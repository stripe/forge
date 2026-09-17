#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

import {runCli} from '../dist/cli.js';
import {createClaudeCodeAdapter} from '../dist/agents/claude-code/index.js';
import {parseAtifTrajectory} from '../dist/atif/index.js';
import {
  GUIDELINE_JUDGE_PROMPT_VERSION,
  JUDGE_TRANSCRIPT_EXCLUDED_FIELDS,
  JUDGE_TRANSCRIPT_PROJECTION_ID,
  JUDGE_TRANSCRIPT_PROJECTION_VERSION,
  JUDGE_TRANSCRIPT_SOURCE,
  createArtifactStore,
  createDirectoryRunInputProvider,
  createJudgeTranscriptProjection,
  credentialReference,
  expandExperiment,
  forgeSetupHandlers,
  loadBenchmarkProfile,
  loadDataset,
  parseInteractionArtifact,
  parseJudgeEvidence,
  resolveRunPlan,
  verifyCompletedRun,
} from '../dist/index.js';
import {createAnthropicCompletionProvider} from '../dist/providers/anthropic/index.js';
import {
  createDockerRuntimeAdapter,
  FORGE_CLAUDE_CODE_VERSION,
  FORGE_RUNTIME_ASSET_DIGEST,
} from '../dist/runtime/docker/index.js';
import {assertRuntimeAdapterConforms} from '../dist/testing/index.js';

const MODEL = 'claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_BRIDGE_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_BRIDGE_CONCURRENCY = 8;
const BRIDGE_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
const BLOCKED_ANTHROPIC_BETA_FLAGS = new Set([
  'thinking-token-count-2026-05-13',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

if (process.env.FORGE_LIVE !== '1') {
  throw new Error(
    'The live suite uses Docker and makes potentially billable model calls. Set FORGE_LIVE=1 to acknowledge both.',
  );
}

const gatewayBaseUrl = optionalEnvironment('ANTHROPIC_BASE_URL');
const gatewaySelected = gatewayBaseUrl !== undefined;
const credentialEnvironmentName = gatewaySelected
  ? 'ANTHROPIC_AUTH_TOKEN'
  : 'ANTHROPIC_API_KEY';
const upstreamCredential = requiredEnvironment(credentialEnvironmentName);
const timeoutMs = positiveIntegerEnvironment(
  'FORGE_LIVE_TIMEOUT_MS',
  DEFAULT_TIMEOUT_MS,
);
const dockerExecutable = optionalEnvironment('FORGE_DOCKER_EXECUTABLE') ?? 'docker';
const resultsRoot = path.resolve(
  repositoryRoot,
  optionalEnvironment('FORGE_LIVE_RESULTS_ROOT') ?? 'results/live',
);
const suiteId = liveSuiteId(optionalEnvironment('FORGE_LIVE_RUN_ID'));
const runIds = Object.freeze({
  docker: `${suiteId}-docker`,
  oneShot: `${suiteId}-one-shot`,
  multiTurn: `${suiteId}-multi-turn`,
});
const controller = new AbortController();
const signal = AbortSignal.any([
  controller.signal,
  AbortSignal.timeout(timeoutMs),
]);
const abort = (receivedSignal) => {
  if (!controller.signal.aborted) {
    controller.abort(new Error(`Forge live suite received ${receivedSignal}.`));
  }
};
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

let bridge;
try {
  const gatewayUrl = gatewayBaseUrl === undefined
    ? undefined
    : parseGatewayUrl(gatewayBaseUrl);
  bridge = gatewayUrl !== undefined && isLoopbackHostname(gatewayUrl.hostname)
    ? await startLoopbackGatewayBridge({
        upstream: gatewayUrl,
        upstreamCredential,
      })
    : undefined;

  const agentCredentialReference = credentialReference(
    bridge === undefined
      ? 'live.agent-credential'
      : 'live.ephemeral-bridge-credential',
  );
  const completionCredentialReference = credentialReference(
    'live.completion-credential',
  );
  const agentCredential = bridge?.credential ?? upstreamCredential;
  const runtime = createDockerRuntimeAdapter({dockerExecutable});
  const agent = createClaudeCodeAdapter({
    credential: agentCredentialReference,
    credentialEnvironmentName,
    ...(gatewayBaseUrl === undefined
      ? {}
      : {baseUrl: bridge?.agentBaseUrl ?? gatewayBaseUrl}),
  });
  const completionProvider = createAnthropicCompletionProvider({
    credential: completionCredentialReference,
    ...(gatewayBaseUrl === undefined
      ? {auth: 'api-key'}
      : {auth: 'bearer', baseUrl: gatewayBaseUrl}),
  });
  const credentialValues = new Map([
    [agentCredentialReference, agentCredential],
    [completionCredentialReference, upstreamCredential],
  ]);
  const compositionFactory = async ({datasetRoot, resultsRoot: selectedRoot}) =>
    Object.freeze({
      runtime,
      agents: new Map([[agent.id, agent]]),
      setupHandlers: forgeSetupHandlers,
      completionProviders: new Map([
        [completionProvider.id, completionProvider],
      ]),
      credentialResolver: Object.freeze({
        async resolve(reference, context) {
          context.signal.throwIfAborted();
          const value = credentialValues.get(reference);
          if (value === undefined) {
            throw new Error('The live suite received an unexpected credential reference.');
          }
          return value;
        },
      }),
      inputProvider: await createDirectoryRunInputProvider(datasetRoot),
      artifactStore: createArtifactStore({root: selectedRoot}),
    });

  progress('checking the real Docker runtime lifecycle');
  const dockerReport = await runDockerConformance(runtime, runIds.docker, signal);
  if (bridge !== undefined) {
    progress('checking the container-to-loopback gateway bridge');
    await assertDockerCanReachBridge({
      bridge,
      dockerExecutable,
      platform: dockerReport.platform,
      signal,
    });
  }

  progress('running the one-shot Claude Code evaluation');
  const oneShotCompleted = await runSelection({
    label: 'one-shot',
    example: 'quickstart',
    casePath: ['cases', 'examples', 'hello-file.yaml'],
    runId: runIds.oneShot,
    compositionFactory,
    signal,
  });
  const oneShotReport = await verifyOneShotRun(oneShotCompleted);

  progress('running the multi-turn Ava and guideline evaluation');
  const multiTurnCompleted = await runSelection({
    label: 'multi-turn',
    example: 'multi-turn',
    casePath: ['cases', 'examples', 'release-summary.yaml'],
    runId: runIds.multiTurn,
    compositionFactory,
    signal,
  });
  const multiTurnReport = await verifyMultiTurnRun(multiTurnCompleted);

  process.stdout.write(
    `${JSON.stringify(
      {
        verified: true,
        suite_id: suiteId,
        authentication_mode: bridge === undefined
          ? gatewaySelected
            ? 'messages_compatible_gateway'
            : 'direct_anthropic'
          : 'loopback_gateway_bridge',
        docker: dockerReport,
        runs: {
          one_shot: oneShotReport,
          multi_turn: multiTurnReport,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
  await bridge?.close().catch(() => undefined);
}

async function runDockerConformance(runtime, runId, executionSignal) {
  const [dataset, profile] = await Promise.all([
    loadDataset(path.join(repositoryRoot, 'examples', 'quickstart', 'dataset')),
    loadBenchmarkProfile(
      path.join(repositoryRoot, 'examples', 'quickstart', 'profile.yaml'),
    ),
  ]);
  const selection = expandExperiment(profile)[0];
  if (selection === undefined) {
    throw new Error('The quickstart profile contains no run selection.');
  }
  const plan = resolveRunPlan({dataset, profile, selection});
  const report = await assertRuntimeAdapterConforms(
    runtime,
    {
      runId,
      plan,
      environment: {variables: {}, credentials: {}},
      requirements: {executables: [], stateDirectories: []},
      signal: executionSignal,
    },
    {
      probePath: '.forge-conformance/live-e2e.bin',
      probeBody: Buffer.from('forge-live-e2e\n', 'utf8'),
    },
  );
  return Object.freeze({
    valid: true,
    adapter: {id: runtime.id, version: runtime.version},
    platform: plan.runtime.platform,
    run_id: report.runtimeId,
    cleanup_and_idempotent_disposal_verified: true,
  });
}

async function runSelection({
  label,
  example,
  casePath,
  runId,
  compositionFactory,
  signal: executionSignal,
}) {
  let stdout = '';
  let hadStderr = false;
  const exitCode = await runCli(
    [
      'run',
      '--profile',
      path.join(repositoryRoot, 'examples', example, 'profile.yaml'),
      '--case-file',
      path.join(
        repositoryRoot,
        'examples',
        example,
        'dataset',
        ...casePath,
      ),
      '--agent',
      'claude-code',
      '--model',
      MODEL,
      '--output',
      resultsRoot,
      '--run-id',
      runId,
    ],
    {
      cwd: repositoryRoot,
      signal: executionSignal,
      compositionFactory,
      stdout(text) {
        stdout += text;
      },
      stderr(text) {
        hadStderr = true;
        process.stderr.write(text);
      },
    },
  );
  if (exitCode !== 0) {
    throw new Error(
      `The live ${label} run failed with exit code ${exitCode}.${
        hadStderr ? ' See the preceding Forge diagnostic.' : ''
      }`,
    );
  }

  let summary;
  try {
    summary = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`The live ${label} run returned invalid JSON.`, {
      cause: error,
    });
  }
  if (
    summary === null ||
    typeof summary !== 'object' ||
    summary.run_id !== runId ||
    typeof summary.location !== 'string'
  ) {
    throw new Error(`The live ${label} run returned an invalid summary.`);
  }
  return verifyCompletedRun(summary.location);
}

async function verifyOneShotRun(completed) {
  const {result} = completed;
  requireCondition(
    result.stop_reason === 'task_complete' && result.failure === null,
    'The live one-shot run did not complete the task.',
    completed.location,
  );
  requireCondition(
    result.interaction.mode === 'one_shot' &&
      result.interaction.turn_count === 1,
    'The live one-shot run did not record exactly one turn.',
    completed.location,
  );
  requireCondition(
    result.evaluation.status === 'passed' &&
      result.evaluation.score === 0 &&
      result.evaluation.guidelines_total === 0 &&
      result.evaluation.checks.length > 0 &&
      result.evaluation.checks.every(({passed}) => passed),
    'The live one-shot checks did not all pass.',
    completed.location,
  );
  requireCondition(
    result.completion_calls.length === 0,
    'The checks-only one-shot unexpectedly used a host completion provider.',
    completed.location,
  );
  requireArtifactPaths(
    result,
    [
      'plan.json',
      'trajectory.json',
      'interaction.json',
      'workspace-evidence.json',
      'evaluation.json',
    ],
    completed.location,
  );

  const [interaction, trajectory] = await Promise.all([
    readJsonArtifact(completed.location, 'interaction.json', parseInteractionArtifact),
    readJsonArtifact(completed.location, 'trajectory.json', parseAtifTrajectory),
  ]);
  requireCondition(
    interaction.mode === 'one_shot' &&
      interaction.turns.length === 1 &&
      interaction.role_player === undefined &&
      interaction.failure === null,
    'The live one-shot interaction audit is inconsistent.',
    completed.location,
  );
  verifyNativeSession(result, trajectory, 1, completed.location);
  verifyTrajectoryTurns(trajectory, interaction.turns, completed.location);

  return Object.freeze({
    verified: true,
    run_id: result.run_id,
    location: completed.location,
    status: result.evaluation.status,
    score: result.evaluation.score,
    turns: result.interaction.turn_count,
    agent_cost_usd: result.agent.cost_usd,
    evidence: evidenceSummary(result.evidence),
  });
}

async function verifyMultiTurnRun(completed) {
  const {result} = completed;
  requireCondition(
    result.stop_reason === 'task_complete' && result.failure === null,
    'The live multi-turn run did not complete the task.',
    completed.location,
  );
  requireCondition(
    result.interaction.mode === 'multi_turn' &&
      result.interaction.turn_count >= 2 &&
      result.interaction.turn_count <= 4,
    'The live multi-turn run did not exercise between two and four turns.',
    completed.location,
  );
  requireCondition(
    result.evaluation.status === 'passed' &&
      result.evaluation.score === 1 &&
      result.evaluation.guidelines_total >= 1 &&
      result.evaluation.guidelines_passed ===
        result.evaluation.guidelines_total &&
      result.evaluation.guidelines.every(({passed}) => passed) &&
      result.evaluation.checks.length > 0 &&
      result.evaluation.checks.every(({passed}) => passed),
    'The live multi-turn checks and guidelines did not all pass.',
    completed.location,
  );
  requireArtifactPaths(
    result,
    [
      'plan.json',
      'trajectory.json',
      'interaction.json',
      'workspace-evidence.json',
      'judge-evidence.json',
      'evaluation.json',
    ],
    completed.location,
  );

  const [interaction, trajectory, judgeEvidence] = await Promise.all([
    readJsonArtifact(completed.location, 'interaction.json', parseInteractionArtifact),
    readJsonArtifact(completed.location, 'trajectory.json', parseAtifTrajectory),
    readJsonArtifact(completed.location, 'judge-evidence.json', parseJudgeEvidence),
  ]);
  const invokedDecisions = interaction.role_player?.decisions.filter(
    ({coding_agent_invoked: invoked}) => invoked,
  );
  requireCondition(
    interaction.mode === 'multi_turn' &&
      interaction.turns.length === result.interaction.turn_count &&
      interaction.turns.length >= 2 &&
      interaction.failure === null &&
      interaction.role_player !== undefined &&
      interaction.role_player.needs !== null &&
      interaction.role_player.needs.length > 0 &&
      interaction.role_player.decisions[0]?.source ===
        'configured_initial_prompt' &&
      invokedDecisions?.length === interaction.turns.length &&
      interaction.role_player.decisions.at(-1)?.stop === true,
    'The live multi-turn interaction audit is incomplete.',
    completed.location,
  );
  verifyNativeSession(
    result,
    trajectory,
    result.interaction.turn_count,
    completed.location,
  );
  verifyTrajectoryTurns(trajectory, interaction.turns, completed.location);
  const judgeTranscript = createJudgeTranscriptProjection(trajectory);

  const trajectoryDescriptor = result.artifacts.find(
    ({path: artifactPath}) => artifactPath === 'trajectory.json',
  );
  const releaseSummary = judgeEvidence.workspace.entries.find(
    ({path: evidencePath}) => evidencePath === 'release-summary.txt',
  );
  requireCondition(
    judgeEvidence.prompt_version === GUIDELINE_JUDGE_PROMPT_VERSION &&
      trajectoryDescriptor !== undefined &&
      judgeEvidence.trajectory_sha256 === trajectoryDescriptor.sha256 &&
      judgeEvidence.transcript.source === JUDGE_TRANSCRIPT_SOURCE &&
      judgeEvidence.transcript.projection_id ===
        JUDGE_TRANSCRIPT_PROJECTION_ID &&
      judgeEvidence.transcript.projection_version ===
        JUDGE_TRANSCRIPT_PROJECTION_VERSION &&
      judgeEvidence.transcript.excluded_fields.length ===
        JUDGE_TRANSCRIPT_EXCLUDED_FIELDS.length &&
      judgeEvidence.transcript.excluded_fields.every(
        (field, index) => field === JUDGE_TRANSCRIPT_EXCLUDED_FIELDS[index],
      ) &&
      judgeEvidence.transcript.sha256 === judgeTranscript.transcriptSha256 &&
      judgeEvidence.workspace.complete === true &&
      judgeEvidence.workspace.warnings.length === 0 &&
      releaseSummary?.truncated === false &&
      releaseSummary.content ===
        'Forge is ready for multi-turn evaluation.\n',
    'The live judge evidence is incomplete or does not bind the exact deliverable.',
    completed.location,
  );

  const completionCalls = {
    role_player: completionSummary(result.completion_calls, 'role_player'),
    judge: completionSummary(result.completion_calls, 'judge'),
  };
  requireCondition(
    completionCalls.role_player.succeeded >= 2 &&
      completionCalls.judge.succeeded >= 1,
    'The live run did not complete all required Ava and judge calls.',
    completed.location,
  );

  return Object.freeze({
    verified: true,
    run_id: result.run_id,
    location: completed.location,
    status: result.evaluation.status,
    score: result.evaluation.score,
    turns: result.interaction.turn_count,
    guidelines_passed: result.evaluation.guidelines_passed,
    agent_cost_usd: result.agent.cost_usd,
    session_provenance_verified: true,
    evidence: evidenceSummary(result.evidence),
    completion_calls: completionCalls,
  });
}

function verifyNativeSession(result, trajectory, minimumAgentSteps, location) {
  const source = result.evidence.provenance.source;
  const sessionId = result.agent.session_id;
  requireCondition(
    source.kind === 'native_log' &&
      source.format === 'claude-code-jsonl' &&
      result.evidence.completeness !== 'fallback' &&
      sessionId !== null &&
      source.session_id === sessionId &&
      result.evidence.provenance.adapter.id === result.agent.adapter &&
      result.evidence.provenance.adapter.version ===
        result.agent.adapter_version &&
      trajectory.session_id === sessionId &&
      trajectory.agent.name === result.agent.adapter &&
      trajectory.agent.version === FORGE_CLAUDE_CODE_VERSION &&
      trajectory.agent.model_name === result.agent.model &&
      trajectory.steps.filter(({source: stepSource}) => stepSource === 'agent')
        .length >= minimumAgentSteps,
    'The live run did not preserve exact native Claude session evidence.',
    location,
  );
}

function verifyTrajectoryTurns(trajectory, turns, location) {
  const trajectoryTurns = [];
  let current;
  for (const step of trajectory.steps) {
    if (step.is_copied_context === true || step.source === 'system') continue;
    if (step.source === 'user') {
      if (typeof step.message !== 'string') {
        current = undefined;
        trajectoryTurns.push({
          user: undefined,
          hasAgent: false,
          hasResponse: false,
        });
        continue;
      }
      current = {user: step.message, hasAgent: false, hasResponse: false};
      trajectoryTurns.push(current);
      continue;
    }
    if (current === undefined) {
      requireCondition(
        false,
        'The native trajectory contains agent activity before a completed user turn.',
        location,
      );
    }
    current.hasAgent = true;
    const hasMessage =
      typeof step.message === 'string'
        ? step.message.length > 0
        : Array.isArray(step.message) &&
          step.message.some(
            (part) => part.type !== 'text' || part.text.length > 0,
          );
    if (
      hasMessage ||
      (step.tool_calls?.length ?? 0) > 0
    ) {
      current.hasResponse = true;
    }
  }

  requireCondition(
    trajectoryTurns.length === turns.length &&
      turns.every((turn, index) => {
        const persisted = trajectoryTurns[index];
        const completedHasResponse =
          turn.assistant.length > 0 || turn.tool_calls.length > 0;
        return (
          persisted?.user === turn.user &&
          persisted.hasAgent &&
          (!completedHasResponse || persisted.hasResponse)
        );
      }),
    'The native trajectory does not structurally cover every completed turn.',
    location,
  );
}

function requireArtifactPaths(result, expected, location) {
  const actual = result.artifacts.map(({path: artifactPath}) => artifactPath);
  requireCondition(
    actual.length === expected.length &&
      expected.every((artifactPath) => actual.includes(artifactPath)) &&
      result.supplemental_artifacts.length === 0,
    'The live run did not commit the expected canonical artifact set.',
    location,
  );
}

async function readJsonArtifact(location, artifactPath, parse) {
  let value;
  try {
    value = JSON.parse(
      await fs.readFile(path.join(location, artifactPath), 'utf8'),
    );
  } catch (error) {
    throw new Error(`Could not read ${artifactPath} from the completed run.`, {
      cause: error,
    });
  }
  return parse(value);
}

function completionSummary(calls, purpose) {
  const selected = calls.filter((call) => call.purpose === purpose);
  const safeModel = selected.every(
    ({provider, model}) => provider === 'anthropic' && model === MODEL,
  );
  if (!safeModel || selected.length === 0) {
    throw new Error(`The live ${purpose} calls used unexpected model coordinates.`);
  }
  return Object.freeze({
    attempts: selected.length,
    succeeded: selected.filter(({status}) => status === 'succeeded').length,
    failed: selected.filter(({status}) => status === 'failed').length,
    input_tokens: sumNullable(selected.map(({input_tokens: value}) => value)),
    output_tokens: sumNullable(selected.map(({output_tokens: value}) => value)),
    error_codes: selected.flatMap(({error_code: errorCode}) =>
      errorCode === null ? [] : [errorCode],
    ),
  });
}

function evidenceSummary(evidence) {
  const warningCounts = {};
  for (const {code} of evidence.warnings) {
    warningCounts[code] = (warningCounts[code] ?? 0) + 1;
  }
  return Object.freeze({
    completeness: evidence.completeness,
    source: evidence.provenance.source.kind,
    warning_counts: warningCounts,
  });
}

function sumNullable(values) {
  const present = values.filter((value) => value !== null);
  return present.length === 0
    ? null
    : present.reduce((sum, value) => sum + value, 0);
}

function requireCondition(condition, message, location) {
  if (!condition) {
    throw new Error(`${message} Result: ${location}`);
  }
}

async function startLoopbackGatewayBridge({upstream, upstreamCredential}) {
  const prefix = randomBytes(32).toString('hex');
  const bridgeCredential = randomBytes(32).toString('base64url');
  const expectedAuthorizationDigest = authorizationDigest(bridgeCredential);
  const upstreamTransport = upstream.protocol === 'https:' ? https : http;
  const sockets = new Set();
  const upstreamRequests = new Set();
  let activeRequests = 0;

  const server = http.createServer(
    {
      headersTimeout: 15_000,
      requestTimeout: BRIDGE_REQUEST_TIMEOUT_MS,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 64 * 1024,
    },
    (request, response) => {
      const requestTarget = request.url ?? '';
      const healthPath = `/${prefix}/_forge_live_health`;
      if (request.method === 'GET' && requestTarget === healthPath) {
        response.writeHead(204);
        response.end();
        return;
      }
      if (
        activeRequests >= MAX_BRIDGE_CONCURRENCY ||
        requestTarget.length > 4_096 ||
        !requestTarget.startsWith('/') ||
        request.headers.upgrade !== undefined
      ) {
        rejectBridgeRequest(request, response, 400);
        return;
      }

      let parsedTarget;
      try {
        parsedTarget = new URL(requestTarget, 'http://forge-bridge.invalid');
      } catch {
        rejectBridgeRequest(request, response, 400);
        return;
      }
      const allowedPaths = new Set([
        `/${prefix}/v1/messages`,
        `/${prefix}/v1/messages/count_tokens`,
      ]);
      if (
        request.method !== 'POST' ||
        !allowedPaths.has(parsedTarget.pathname) ||
        !authorizedBridgeRequest(
          request.headers.authorization,
          expectedAuthorizationDigest,
        )
      ) {
        rejectBridgeRequest(request, response, 403);
        return;
      }
      const contentLength = request.headers['content-length'];
      if (
        typeof contentLength === 'string' &&
        (!/^[0-9]+$/.test(contentLength) ||
          Number(contentLength) > MAX_BRIDGE_REQUEST_BYTES)
      ) {
        rejectBridgeRequest(request, response, 413);
        return;
      }

      activeRequests += 1;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        activeRequests -= 1;
      };
      response.once('close', finish);
      response.once('finish', finish);

      const suffix = parsedTarget.pathname.slice(`/${prefix}`.length);
      const upstreamPath = `${upstream.pathname.replace(/\/+$/, '')}${suffix}${
        parsedTarget.search
      }`;
      const headers = sanitizedProxyHeaders(request.headers);
      headers.host = upstream.host;
      headers.authorization = `Bearer ${upstreamCredential}`;
      delete headers['x-api-key'];
      filterAnthropicBetaHeader(headers);

      const upstreamRequest = upstreamTransport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          method: request.method,
          path: upstreamPath,
          headers,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            sanitizedProxyHeaders(upstreamResponse.headers),
          );
          upstreamResponse.pipe(response);
        },
      );
      upstreamRequests.add(upstreamRequest);
      upstreamRequest.once('close', () => upstreamRequests.delete(upstreamRequest));
      upstreamRequest.setTimeout(BRIDGE_REQUEST_TIMEOUT_MS, () => {
        upstreamRequest.destroy();
      });
      upstreamRequest.once('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end('gateway unavailable');
      });

      let requestBytes = 0;
      request.on('data', (chunk) => {
        requestBytes += chunk.byteLength;
        if (requestBytes > MAX_BRIDGE_REQUEST_BYTES) {
          upstreamRequest.destroy();
          if (!response.headersSent) response.writeHead(413);
          response.end();
          request.destroy();
          return;
        }
        if (
          !upstreamRequest.destroyed &&
          !upstreamRequest.write(chunk)
        ) {
          request.pause();
          upstreamRequest.once('drain', () => request.resume());
        }
      });
      request.once('end', () => {
        if (!upstreamRequest.destroyed) upstreamRequest.end();
      });
      request.once('aborted', () => upstreamRequest.destroy());
      request.once('error', () => upstreamRequest.destroy());
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.maxConnections = MAX_BRIDGE_CONCURRENCY * 2;

  await new Promise((resolve, reject) => {
    const startupError = (error) => reject(error);
    server.once('error', startupError);
    server.listen(0, '0.0.0.0', () => {
      server.removeListener('error', startupError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeBridgeServer(server, sockets, upstreamRequests);
    throw new Error('The loopback gateway bridge did not bind a TCP port.');
  }

  return Object.freeze({
    server,
    port: address.port,
    credential: bridgeCredential,
    agentBaseUrl: `http://host.docker.internal:${address.port}/${prefix}`,
    healthUrl: `http://host.docker.internal:${address.port}/${prefix}/_forge_live_health`,
    close: () => closeBridgeServer(server, sockets, upstreamRequests),
  });
}

function authorizedBridgeRequest(rawAuthorization, expectedDigest) {
  if (typeof rawAuthorization !== 'string') return false;
  return timingSafeEqual(
    authorizationDigestValue(rawAuthorization),
    expectedDigest,
  );
}

function authorizationDigest(credential) {
  return authorizationDigestValue(`Bearer ${credential}`);
}

function authorizationDigestValue(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function sanitizedProxyHeaders(input) {
  const output = {};
  for (const [name, value] of Object.entries(input)) {
    if (
      value !== undefined &&
      !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) &&
      name.toLowerCase() !== 'host' &&
      name.toLowerCase() !== 'authorization' &&
      name.toLowerCase() !== 'x-api-key'
    ) {
      output[name] = value;
    }
  }
  return output;
}

function filterAnthropicBetaHeader(headers) {
  const raw = headers['anthropic-beta'];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const kept = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(
      (value) =>
        value.length > 0 && !BLOCKED_ANTHROPIC_BETA_FLAGS.has(value),
    );
  if (kept.length === 0) delete headers['anthropic-beta'];
  else headers['anthropic-beta'] = kept.join(',');
}

function rejectBridgeRequest(request, response, status) {
  request.resume();
  response.writeHead(status);
  response.end();
}

async function closeBridgeServer(server, sockets, upstreamRequests) {
  for (const request of upstreamRequests) request.destroy();
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function assertDockerCanReachBridge({
  bridge,
  dockerExecutable,
  platform,
  signal: executionSignal,
}) {
  const architecture = platform === 'linux/arm64' ? 'arm64' : 'amd64';
  const image = `stripe-forge-runtime:${FORGE_RUNTIME_ASSET_DIGEST.slice(
    0,
    20,
  )}-${architecture}`;
  const result = await runBoundedCommand(
    dockerExecutable,
    [
      'run',
      '--rm',
      '--pull=never',
      '--platform',
      platform,
      '--entrypoint',
      '/usr/bin/curl',
      image,
      '--silent',
      '--show-error',
      '--max-time',
      '10',
      '--output',
      '/dev/null',
      '--write-out',
      '%{http_code}',
      bridge.healthUrl,
    ],
    AbortSignal.any([executionSignal, AbortSignal.timeout(30_000)]),
  );
  if (result.exitCode !== 0 || result.stdout !== '204') {
    throw new Error(
      'A Docker container could not reach the temporary loopback gateway bridge.',
    );
  }
}

function runBoundedCommand(executable, argv, executionSignal) {
  return new Promise((resolve, reject) => {
    executionSignal.throwIfAborted();
    const child = spawn(executable, argv, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      executionSignal.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      reject(error);
    };
    const capture = (target, chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) {
        fail(new Error('The Docker bridge probe exceeded its output limit.'));
        return;
      }
      target.push(chunk);
    };
    const onAbort = () =>
      fail(
        executionSignal.reason instanceof Error
          ? executionSignal.reason
          : new Error('The Docker bridge probe was aborted.'),
      );
    executionSignal.addEventListener('abort', onAbort, {once: true});
    child.stdout.on('data', (chunk) => capture(stdout, chunk));
    child.stderr.on('data', (chunk) => capture(stderr, chunk));
    child.once('error', (error) => fail(error));
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      executionSignal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
}

function parseGatewayUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('ANTHROPIC_BASE_URL must be a valid HTTP(S) URL.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError(
      'ANTHROPIC_BASE_URL must be a credential-free HTTP(S) URL without a query or fragment.',
    );
  }
  return parsed;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized)
  );
}

function liveSuiteId(configured) {
  const value = configured ?? `live-e2e-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) {
    throw new TypeError(
      'FORGE_LIVE_RUN_ID must be a safe identifier of at most 96 characters.',
    );
  }
  return value;
}

function requiredEnvironment(name) {
  const value = optionalEnvironment(name);
  if (value === undefined) {
    throw new Error(`${name} is required for the live suite.`);
  }
  return value;
}

function optionalEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes('\0')) {
    throw new TypeError(`${name} must not contain a NUL byte.`);
  }
  return value;
}

function positiveIntegerEnvironment(name, fallback) {
  const value = optionalEnvironment(name);
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be a safe integer.`);
  }
  return parsed;
}

function progress(message) {
  process.stderr.write(`[forge live] ${message}...\n`);
}
