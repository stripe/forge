import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  CODEX_HOME_STATE_ID,
  createCodexAdapter,
} from '../src/agents/codex/index.ts';
import { parseAtifTrajectory } from '../src/atif/index.ts';
import type { CommandResult } from '../src/contracts/command.ts';
import {
  type CompletedRunV1,
  createArtifactStore,
  createJudgeTranscriptProjection,
  credentialReference,
  executeEval,
  FORGE_VERSION,
  type ForgeComposition,
  parseInteractionArtifact,
  parseJudgeEvidence,
  preflightEval,
  type ResolvedRunPlanV1,
  verifyCompletedRun,
} from '../src/index.ts';
import { FORGE_CODEX_VERSION } from '../src/runtime/docker/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
  type RecordedTestCommand,
} from '../src/testing/index.ts';

const roots: string[] = [];
const SESSION_ID = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const OTHER_SESSION_ID = '0199a213-81c0-7800-8aa1-bbab2a035a54';
const AGENT_SECRET = 'synthetic-codex-agent-secret';
const COMPLETION_SECRET = 'synthetic-codex-harness-secret';
const SYSTEM_MARKER = 'CODEX_NATIVE_SYSTEM_CONTEXT';
const selection = { adapter: 'codex', provider: 'openai', model: 'gpt-test' };
const ROLE_MODEL = { provider: 'test-completions', model: 'role-test' };
const JUDGE_MODEL = { provider: 'test-completions', model: 'judge-test' };

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

interface Turn {
  prompt: string;
  response: string;
}

function commandResult(stdout: string): CommandResult {
  return { stdout, stderr: '', exitCode: 0, durationMs: 1 };
}

function rolloutPath(sessionId: string): string {
  return `sessions/2026/08/20/rollout-2026-08-20T12-00-00-${sessionId}.jsonl`;
}

function nativeRollout(turns: readonly Turn[], sessionId = SESSION_ID): string {
  const records: unknown[] = [
    {
      type: 'session_meta',
      payload: {
        id: sessionId,
        source: 'exec',
        cli_version: FORGE_CODEX_VERSION,
        base_instructions: { text: SYSTEM_MARKER },
      },
    },
  ];
  for (const [index, turn] of turns.entries()) {
    const turnId = `turn-${index + 1}`;
    const callId = `call-${index + 1}`;
    records.push(
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      {
        type: 'turn_context',
        payload: { turn_id: turnId, model: selection.model },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: turn.prompt }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: turn.prompt,
          images: [],
          local_images: [],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: callId,
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'printf complete > answer.txt' }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: callId,
          output: 'File written.',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: turn.response }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId },
      },
    );
  }
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function stream(response: string): string {
  return [
    { type: 'thread.started', thread_id: SESSION_ID },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'printf complete > answer.txt',
        aggregated_output: 'File written.',
        exit_code: 0,
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: { id: 'item_2', type: 'agent_message', text: response },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');
}

function withoutNativeTools(turns: readonly Turn[]): string {
  return `${nativeRollout(turns)
    .trimEnd()
    .split('\n')
    .filter((line) => {
      const record = JSON.parse(line) as { payload: { type: string } };
      return !['function_call', 'function_call_output'].includes(
        record.payload.type,
      );
    })
    .join('\n')}\n`;
}

function withoutLiveTools(response: string): string {
  return stream(response)
    .split('\n')
    .filter((line) => {
      const record = JSON.parse(line) as { item?: { type: string } };
      return record.item?.type !== 'command_execution';
    })
    .join('\n');
}

// Minimized tool-search/MCP shapes emitted by Codex 0.149.0 with a local fake
// Responses provider and MCP server. No credentials or inference are required.
function mcpRollout(
  turns: readonly Turn[],
  output: unknown,
  result: Record<string, unknown>,
): string {
  const records: unknown[] = [];
  for (const line of nativeRollout(turns).trimEnd().split('\n')) {
    const record = JSON.parse(line) as {
      type: string;
      payload: Record<string, unknown>;
    };
    if (record.payload.type === 'function_call') {
      const id = String(record.payload.call_id);
      const turnId = id.replace('call-', 'turn-');
      const metadata = { turn_id: turnId };
      const response = (payload: Record<string, unknown>) => ({
        type: 'response_item',
        payload: {
          ...payload,
          internal_chat_message_metadata_passthrough: metadata,
        },
      });
      records.push(
        response({
          type: 'tool_search_call',
          id: `search-${id}`,
          call_id: `search-${id}`,
          status: 'completed',
          execution: 'client',
          arguments: { query: 'fixture probe', limit: 1 },
        }),
        response({
          type: 'tool_search_output',
          id: `search-output-${id}`,
          call_id: `search-${id}`,
          status: 'completed',
          execution: 'client',
          tools: [
            {
              type: 'namespace',
              name: 'mcp__fixture',
              description: 'Tools in the fixture namespace.',
              tools: [
                {
                  type: 'function',
                  name: 'probe',
                  description: 'Read the fixture.',
                  strict: false,
                  defer_loading: true,
                  parameters: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                },
              ],
            },
          ],
        }),
        response({
          type: 'function_call',
          id: `item-${id}`,
          call_id: id,
          namespace: 'mcp__fixture',
          name: 'probe',
          arguments: '{}',
        }),
        {
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            thread_id: SESSION_ID,
            turn_id: turnId,
            item: {
              type: 'McpToolCall',
              id,
              server: 'fixture',
              tool: 'probe',
              arguments: {},
              readOnlyHint: true,
              status: result.isError === true ? 'failed' : 'completed',
              result,
              duration: { secs: 0, nanos: 1 },
            },
            started_at_ms: 1,
            completed_at_ms: 2,
          },
        },
        response({
          type: 'function_call_output',
          id: `output-${id}`,
          call_id: id,
          output,
        }),
      );
    } else if (record.payload.type !== 'function_call_output') {
      records.push(record);
    }
  }
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function mcpStream(response: string, result: Record<string, unknown>): string {
  return stream(response)
    .split('\n')
    .map((line) => {
      const record = JSON.parse(line) as { item?: { type: string } };
      return record.item?.type === 'command_execution'
        ? JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'item_1',
              type: 'mcp_tool_call',
              server: 'fixture',
              tool: 'probe',
              arguments: {},
              status: result.isError === true ? 'failed' : 'completed',
              error: null,
              result: {
                content: result.content,
                structured_content: result.structuredContent ?? null,
              },
            },
          })
        : line;
    })
    .join('\n');
}

function truncatedMcpFixture(
  shape: 'text' | 'structured-content' | 'text-metadata',
) {
  const retainedMarker = `MCP_TRUNCATED_VISIBLE_${shape}`;
  const omittedMarker = `MCP_TRUNCATED_PRIVATE_MIDDLE_${shape}`;
  const prefix = `${retainedMarker}: ${AGENT_SECRET}: ${'A'.repeat(108_000)}${omittedMarker}`;
  const longText = prefix + 'Z'.repeat(216_000 - prefix.length);
  const unselectedMarker = 'MCP_UNSELECTED_STRUCTURED_FALLBACK';
  const isError = shape === 'structured-content';
  const result: Record<string, unknown> = {
    content: [
      {
        type: 'text',
        ...(shape === 'text-metadata'
          ? {
              annotations: {
                future: { credential: AGENT_SECRET, values: [null, true, 1] },
              },
              _meta: { marker: 'MCP_TRUNCATED_METADATA' },
            }
          : {}),
        text: shape === 'structured-content' ? unselectedMarker : longText,
      },
    ],
    ...(shape === 'structured-content'
      ? { structuredContent: { answer: longText } }
      : {}),
    isError,
  };
  const rendered = `Wall time: 0.001 seconds\nOutput:\n${JSON.stringify(result.structuredContent ?? result.content)}`;
  // Codex 0.149.0's captured default string-output budget is 12,000 estimated
  // tokens. These ASCII fixtures make the UTF-8 head/tail byte cuts explicit;
  // the truncation marker itself is not charged against the retained budget.
  assert.equal(longText.length, 216_000);
  assert.equal(Buffer.byteLength(rendered), rendered.length);
  const omittedTokens = Math.ceil(Buffer.byteLength(rendered) / 4) - 12_000;
  const truncationMarker = `…${omittedTokens} tokens truncated…`;
  const output = `${rendered.slice(0, 24_000)}${truncationMarker}${rendered.slice(-24_000)}`;
  assert.ok(output.includes(AGENT_SECRET));
  assert.ok(!output.includes(omittedMarker));
  return {
    result,
    output,
    retainedMarker,
    omittedMarker,
    unselectedMarker,
    truncationMarker,
    isError,
  };
}

async function fixture(
  plan: ResolvedRunPlanV1,
  options: {
    responses?: readonly string[];
    native?: (turns: readonly Turn[]) => string | undefined;
    stdout?: (response: string) => string;
    agentCommand?: (call: RecordedTestCommand) => Promise<CommandResult>;
    versionOutput?: string;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-codex-e2e-'));
  roots.push(root);
  const turns: Turn[] = [];
  let nativeBody: string | undefined;
  const runtime = createFakeRuntimeAdapter({
    metadata: {
      mode: 'in-memory-codex-test',
      codexVersion: FORGE_CODEX_VERSION,
    },
    stateFiles: {
      [CODEX_HOME_STATE_ID]: {
        [rolloutPath(OTHER_SESSION_ID)]: nativeRollout(
          [{ prompt: 'Unrelated user', response: 'UNRELATED_NATIVE_MARKER' }],
          OTHER_SESSION_ID,
        ),
      },
    },
    async command(call): Promise<CommandResult> {
      if (call.scope === 'uncredentialed') {
        assert.deepEqual(call.argv, ['codex', '--version']);
        assert.deepEqual(call.credentialEnvironmentNames, []);
        return commandResult(
          options.versionOutput ?? `codex-cli ${FORGE_CODEX_VERSION}`,
        );
      }
      assert.equal(call.scope, 'agent');
      assert.deepEqual(call.credentialEnvironmentNames, ['CODEX_API_KEY']);
      assert.equal(call.argv[0], 'codex');
      assert.equal(call.argv[1], 'exec');
      if (options.agentCommand) return options.agentCommand(call);
      const response =
        options.responses?.[turns.length] ?? 'Completed the answer.';
      const prompt = call.argv.at(-1)!;
      turns.push({ prompt, response });
      const run = runtime.runs[0]!;
      await run.workspace.mutable.writeFile(
        'answer.txt',
        Buffer.from('complete\n'),
      );
      nativeBody = options.native
        ? options.native(turns)
        : nativeRollout(turns);
      if (nativeBody !== undefined) {
        await run.stateDirectories
          .get(CODEX_HOME_STATE_ID)!
          .mutable.writeFile(rolloutPath(SESSION_ID), Buffer.from(nativeBody));
      }
      return commandResult(
        options.stdout ? options.stdout(response) : stream(response),
      );
    },
  });
  const agent = createCodexAdapter();
  const resolved: string[] = [];
  const resultsRoot = path.join(root, 'results');
  const composition: ForgeComposition = {
    runtime: runtime.adapter,
    agents: new Map([[agent.id, agent]]),
    inputProvider: createMemoryRunInputProvider(),
    credentialResolver: createStaticCredentialResolver(
      {
        'openai.api-key': AGENT_SECRET,
        'harness.api-key': COMPLETION_SECRET,
        'unrequested.api-key': 'must-not-resolve',
      },
      {
        onResolve(reference) {
          resolved.push(reference);
        },
      },
    ),
    artifactStore: createArtifactStore({ root: resultsRoot }),
  };
  return {
    root,
    resultsRoot,
    plan,
    composition,
    runtime,
    turns,
    resolved,
    native: () => nativeBody,
  };
}

async function readArtifact(location: string, name: string): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(path.join(location, name), 'utf8'),
  ) as unknown;
}

async function assertRestrictedNative(
  completed: CompletedRunV1,
  expected: string,
) {
  const descriptor = completed.result.supplemental_artifacts.find(
    (artifact) => artifact.path === 'native/codex/session.jsonl',
  );
  assert.ok(descriptor);
  assert.equal(descriptor.sensitivity, 'restricted');
  assert.equal(descriptor.media_type, 'application/x-ndjson');
  const nativePath = path.join(completed.location, descriptor.path);
  assert.equal(await fs.readFile(nativePath, 'utf8'), expected);
  assert.equal((await fs.stat(nativePath)).mode & 0o777, 0o600);
  assert.equal(completed.result.supplemental_artifacts.length, 1);
}

function twoTurnProvider() {
  return createScriptedCompletionProvider({
    id: ROLE_MODEL.provider,
    requirements: {
      credentials: {
        token: { reference: credentialReference('harness.api-key') },
      },
    },
    responses: [
      JSON.stringify({
        user_needs: [
          { description: 'Complete both parts', status: 'remaining' },
        ],
        message: 'Complete part one.',
      }),
      JSON.stringify({
        remaining_need_ids: ['need_1'],
        message: 'Complete part two.',
      }),
      JSON.stringify({ remaining_need_ids: [], message: '' }),
    ],
  });
}

describe('Codex engine integration', () => {
  it('preflights without authority, then commits verifiable one-shot native evidence and scoped credentials', async () => {
    const plan = createTestResolvedRunPlan({
      agent: selection,
      prompt: 'Create answer.txt.',
      checks: {
        files_created: ['answer.txt'],
        file_checks: [
          { file: 'answer.txt', exists: true, contains: '^complete\\n?$' },
        ],
      },
    });
    const test = await fixture(plan, {
      responses: [`Completed the answer with ${AGENT_SECRET}.`],
    });
    preflightEval({ plan, composition: test.composition });
    assert.equal(test.runtime.runs.length, 0);
    assert.deepEqual(test.resolved, []);
    const completed = await executeEval({
      runId: 'codex-native-one',
      plan,
      composition: test.composition,
    });
    const verified = await verifyCompletedRun(completed.location);
    assert.equal(verified.result.evaluation.status, 'passed');
    assert.equal(verified.result.evaluation.score, 0);
    assert.equal(verified.result.agent.session_id, SESSION_ID);
    assert.equal(verified.result.evidence.completeness, 'complete');
    assert.deepEqual(verified.result.evidence.provenance, {
      adapter: { id: 'codex', version: FORGE_VERSION },
      source: {
        kind: 'native_log',
        format: 'codex-rollout-jsonl',
        session_id: SESSION_ID,
      },
    });
    const trajectory = parseAtifTrajectory(
      await readArtifact(completed.location, 'trajectory.json'),
    );
    assert.deepEqual(trajectory.agent, {
      name: 'codex',
      version: FORGE_CODEX_VERSION,
      model_name: selection.model,
    });
    assert.equal(trajectory.steps[0]?.source, 'system');
    assert.equal(trajectory.steps[0]?.message, SYSTEM_MARKER);
    assert.match(JSON.stringify(trajectory), /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(trajectory), new RegExp(AGENT_SECRET));
    assert.doesNotMatch(JSON.stringify(trajectory), /UNRELATED_NATIVE_MARKER/);
    assert.ok(
      trajectory.steps.some(
        (step) => step.source === 'agent' && step.tool_calls?.length,
      ),
    );
    assert.ok(verified.result.evidence.redaction_count > 0);
    await assertRestrictedNative(completed, test.native()!);
    assert.ok(test.native()!.includes(AGENT_SECRET));
    for (const artifact of completed.result.artifacts) {
      assert.doesNotMatch(
        await fs.readFile(path.join(completed.location, artifact.path), 'utf8'),
        new RegExp(AGENT_SECRET),
      );
    }
    assert.deepEqual(test.resolved, ['openai.api-key']);
    const run = test.runtime.runs[0]!;
    assert.deepEqual(run.input.environment.variables, {
      CODEX_HOME: '/home/forge/.codex',
    });
    assert.deepEqual(run.input.environment.credentials, {
      CODEX_API_KEY: { value: AGENT_SECRET, scopes: ['agent'] },
    });
    assert.deepEqual(run.events, [
      'prepare',
      'command:uncredentialed',
      'finalizeSetup',
      'command:agent',
      'quiesce',
      'dispose',
    ]);
    assert.doesNotMatch(
      JSON.stringify(run.commands.map(({ argv }) => argv)),
      new RegExp(AGENT_SECRET),
    );
  });

  it('uses one exact Codex thread for two Ava turns and judges only the visible native projection after sealing', async () => {
    const plan = createTestResolvedRunPlan({
      agent: selection,
      mode: 'multi_turn',
      prompt: 'Complete both parts.',
      maxTurns: 3,
      rolePlayer: ROLE_MODEL,
      judge: JUDGE_MODEL,
      judgingCriteria: [
        {
          criteria_requirement: 'SHOULD' as const,
          value: 'Both parts are complete.',
          requirement_level: 'MUST' as const,
        },
      ],
    });
    const test = await fixture(plan, {
      responses: ['Part one complete.', 'Part two complete.'],
    });
    const provider = createScriptedCompletionProvider({
      id: ROLE_MODEL.provider,
      requirements: {
        credentials: {
          token: { reference: credentialReference('harness.api-key') },
        },
      },
      responses: [
        JSON.stringify({
          user_needs: [
            { description: 'Complete both parts', status: 'remaining' },
          ],
          message: 'Complete part one.',
        }),
        JSON.stringify({
          remaining_need_ids: ['need_1'],
          message: 'Complete part two.',
        }),
        JSON.stringify({ remaining_need_ids: [], message: '' }),
        (request, context) => {
          assert.equal(request.purpose, 'judge');
          assert.deepEqual(context.credentials, { token: COMPLETION_SECRET });
          assert.ok(test.runtime.runs[0]!.events.includes('quiesce'));
          assert.match(request.systemPrompt ?? '', /Part one complete/);
          assert.match(request.systemPrompt ?? '', /Part two complete/);
          assert.doesNotMatch(
            request.systemPrompt ?? '',
            new RegExp(SYSTEM_MARKER),
          );
          assert.doesNotMatch(
            JSON.stringify(request),
            new RegExp(AGENT_SECRET),
          );
          return JSON.stringify({
            results: [
              { index: 0, passed: true, explanation: 'Both parts completed.' },
            ],
          });
        },
      ],
    });
    const completed = await executeEval({
      runId: 'codex-native-multi',
      plan,
      composition: {
        ...test.composition,
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
      },
    });
    const verified = await verifyCompletedRun(completed.location);
    assert.equal(verified.result.evidence.completeness, 'complete');
    assert.deepEqual(verified.result.interaction, {
      mode: 'multi_turn',
      turn_count: 2,
    });
    assert.equal(verified.result.stop_reason, 'task_complete');
    assert.equal(verified.result.evaluation.score, 1);
    assert.equal(verified.result.agent.session_id, SESSION_ID);
    assert.deepEqual(
      test.turns.map(({ prompt }) => prompt),
      ['Complete part one.', 'Complete part two.'],
    );
    const commands = test.runtime.runs[0]!.commands.filter(
      ({ scope }) => scope === 'agent',
    );
    assert.equal(commands[0]!.argv.includes('resume'), false);
    assert.ok(commands[1]!.argv.includes('resume'));
    assert.ok(commands[1]!.argv.includes(SESSION_ID));
    assert.ok(commands.every(({ argv }) => !argv.includes('--last')));
    assert.deepEqual(
      provider.calls.map(({ request }) => request.purpose),
      ['role_player', 'role_player', 'role_player', 'judge'],
    );
    assert.ok(
      provider.calls.every(
        ({ context }) => Object.keys(context.credentials).join() === 'token',
      ),
    );
    const interaction = parseInteractionArtifact(
      await readArtifact(completed.location, 'interaction.json'),
      { forgeVersion: completed.result.forge.version },
    );
    assert.deepEqual(
      interaction.turns.map(({ user }) => user),
      test.turns.map(({ prompt }) => prompt),
    );
    const judge = parseJudgeEvidence(
      await readArtifact(completed.location, 'judge-evidence.json'),
      { forgeVersion: completed.result.forge.version },
    );
    assert.doesNotMatch(
      JSON.stringify(judge.transcript),
      new RegExp(SYSTEM_MARKER),
    );
    await assertRestrictedNative(completed, test.native()!);
  });

  for (const mode of ['malformed', 'unfinished'] as const) {
    it(`falls back explicitly for ${mode} native records while retaining exact restricted source bytes`, async () => {
      const plan = createTestResolvedRunPlan({
        agent: selection,
        prompt: 'Complete the requested answer.',
      });
      const test = await fixture(plan, {
        native: (turns) =>
          mode === 'malformed'
            ? `${nativeRollout(turns)}not-json\n`
            : `${nativeRollout(turns).trimEnd().split('\n').slice(0, -1).join('\n')}\n`,
      });
      const completed = await executeEval({
        runId: `codex-${mode}`,
        plan,
        composition: test.composition,
      });
      const verified = await verifyCompletedRun(completed.location);
      assert.equal(verified.result.evidence.completeness, 'fallback');
      assert.equal(
        verified.result.evidence.provenance.source.kind,
        'driver_fallback',
      );
      assert.deepEqual(
        verified.result.evidence.warnings.map(({ code }) => code),
        [
          mode === 'malformed' ? 'source_invalid' : 'source_incomplete',
          'fallback_used',
        ],
      );
      const trajectory = parseAtifTrajectory(
        await readArtifact(completed.location, 'trajectory.json'),
      );
      assert.deepEqual(
        trajectory.steps
          .filter(({ source }) => source === 'user')
          .map(({ message }) => message),
        ['Complete the requested answer.'],
      );
      assert.ok(JSON.stringify(trajectory).includes('Completed the answer.'));
      assert.doesNotMatch(
        JSON.stringify(trajectory),
        new RegExp(SYSTEM_MARKER),
      );
      await assertRestrictedNative(completed, test.native()!);
    });
  }

  for (const liveHasTools of [true, false]) {
    it(
      liveHasTools
        ? 'falls back when the entire native tool pair is missing, retaining observed activity for the judge'
        : 'accepts a genuinely tool-free native turn without warnings',
      async () => {
        const plan = createTestResolvedRunPlan({
          agent: selection,
          prompt: 'Complete the requested answer.',
          judge: JUDGE_MODEL,
          judgingCriteria: [
            {
              criteria_requirement: 'SHOULD' as const,
              value: 'The answer is complete.',
              requirement_level: 'MUST' as const,
            },
          ],
        });
        const test = await fixture(plan, {
          native: withoutNativeTools,
          ...(liveHasTools ? {} : { stdout: withoutLiveTools }),
        });
        const provider = createScriptedCompletionProvider({
          id: JUDGE_MODEL.provider,
          responses: [
            JSON.stringify({
              results: [
                { index: 0, passed: true, explanation: 'Synthetic judge.' },
              ],
            }),
          ],
        });
        const completed = await executeEval({
          runId: liveHasTools ? 'codex-missing-tool-pair' : 'codex-no-tools',
          plan,
          composition: {
            ...test.composition,
            completionProviders: new Map([
              [provider.provider.id, provider.provider],
            ]),
          },
        });
        const verified = await verifyCompletedRun(completed.location);
        assert.equal(
          verified.result.evidence.completeness,
          liveHasTools ? 'fallback' : 'complete',
        );
        assert.deepEqual(
          verified.result.evidence.warnings.map(({ code }) => code),
          liveHasTools ? ['source_incomplete', 'fallback_used'] : [],
        );
        const interaction = parseInteractionArtifact(
          await readArtifact(completed.location, 'interaction.json'),
          { forgeVersion: completed.result.forge.version },
        );
        const trajectory = parseAtifTrajectory(
          await readArtifact(completed.location, 'trajectory.json'),
        );
        const judge = parseJudgeEvidence(
          await readArtifact(completed.location, 'judge-evidence.json'),
          { forgeVersion: completed.result.forge.version },
        );
        assert.equal(
          interaction.turns[0]!.tool_calls.length,
          liveHasTools ? 1 : 0,
        );
        assert.equal(
          judge.transcript.steps.flatMap((step) =>
            step.source === 'agent' ? (step.tool_calls ?? []) : [],
          ).length,
          liveHasTools ? 1 : 0,
        );
        assert.ok(
          provider.calls[0]!.request.systemPrompt?.includes(
            createJudgeTranscriptProjection(trajectory).transcriptJson,
          ),
        );
        await assertRestrictedNative(completed, test.native()!);
      },
    );
  }

  for (const shape of [
    'structured-string',
    'text-array',
    'full-annotations',
    'content-meta',
    'image-metadata',
  ] as const) {
    it(`preserves captured MCP ${shape} evidence through native selection, judging, redaction, and verification`, async () => {
      const marker = `MCP_RESULT_${shape}`;
      const text = `${marker}: ${AGENT_SECRET}`;
      // A valid synthetic 16x16 PNG from the offline pinned-CLI capture.
      const imageData =
        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGP4z8DwnxLMMGrAqAGjBgwXAwAwxP4QHCfkAAAAAABJRU5ErkJggg==';
      const structuredContent = {
        answer: text,
        reasoning_content: 'Opaque tool data remains visible.',
      };
      const image = shape === 'image-metadata';
      const isError = shape === 'content-meta';
      // These content-level objects are extensible opaque tool data, not a
      // request to interpret annotations or import recorder-only metadata.
      const contentMetadata =
        shape === 'full-annotations'
          ? {
              annotations: {
                audience: ['assistant'],
                priority: 1,
                lastModified: '2026-09-22T00:00:00Z',
                extension: {
                  credential: AGENT_SECRET,
                  reasoning_content: 'Opaque annotation detail.',
                },
              },
            }
          : shape === 'content-meta'
            ? {
                _meta: {
                  extension: {
                    credential: AGENT_SECRET,
                    values: [null, true, { future: 'Opaque metadata detail.' }],
                  },
                },
              }
            : {};
      const imageMetadata =
        shape === 'image-metadata'
          ? {
              annotations: {
                audience: ['assistant'],
                extension: { credential: AGENT_SECRET },
              },
              _meta: { marker: 'SNAPSHOT_ONLY_IMAGE_METADATA' },
            }
          : {};
      const result: Record<string, unknown> = {
        content: [
          { type: 'text', text, ...contentMetadata },
          ...(image
            ? [
                {
                  type: 'image',
                  mimeType: 'image/png',
                  data: imageData,
                  ...imageMetadata,
                },
              ]
            : []),
        ],
        isError,
        ...(shape === 'structured-string' ? { structuredContent } : {}),
      };
      const output =
        shape === 'text-array' || image
          ? [
              { type: 'input_text', text: 'Wall time: 0.001 seconds\nOutput:' },
              { type: 'input_text', text },
              ...(image
                ? [
                    {
                      type: 'input_image',
                      image_url: `data:image/png;base64,${imageData}`,
                    },
                  ]
                : []),
            ]
          : `Wall time: 0.001 seconds\nOutput:\n${JSON.stringify(shape === 'structured-string' ? structuredContent : result.content)}`;
      const plan = createTestResolvedRunPlan({
        agent: selection,
        prompt: 'Look up the fixture.',
        judge: JUDGE_MODEL,
        judgingCriteria: [
          {
            criteria_requirement: 'SHOULD' as const,
            value: 'The assistant inspects the fixture.',
            requirement_level: 'MUST' as const,
          },
        ],
      });
      const test = await fixture(plan, {
        native: (turns) => mcpRollout(turns, output, result),
        stdout: (response) => mcpStream(response, result),
      });
      let sealedAtJudgeDispatch = false;
      const provider = createScriptedCompletionProvider({
        id: JUDGE_MODEL.provider,
        responses: [
          () => {
            sealedAtJudgeDispatch =
              test.runtime.runs[0]!.events.includes('quiesce');
            return JSON.stringify({
              results: [
                {
                  index: 0,
                  passed: true,
                  explanation: 'Synthetic evidence check.',
                },
              ],
            });
          },
        ],
      });
      const completed = await executeEval({
        runId: `codex-mcp-${shape}`,
        plan,
        composition: {
          ...test.composition,
          completionProviders: new Map([
            [provider.provider.id, provider.provider],
          ]),
        },
      });
      const verified = await verifyCompletedRun(completed.location);
      assert.equal(
        verified.result.evidence.provenance.source.kind,
        'native_log',
      );
      assert.equal(
        verified.result.evidence.completeness,
        image ? 'partial' : 'complete',
      );
      assert.deepEqual(
        verified.result.evidence.warnings.map(({ code }) => code),
        image ? ['value_omitted'] : [],
      );
      assert.ok(sealedAtJudgeDispatch);
      const request = provider.calls[0]!.request;
      assert.ok(request.systemPrompt?.includes(marker));
      assert.ok(request.systemPrompt?.includes('tool_search'));
      assert.ok(request.systemPrompt?.includes('mcp__fixture.probe'));
      assert.ok(!JSON.stringify(request).includes(AGENT_SECRET));
      assert.ok(!JSON.stringify(request).includes(imageData));
      const trajectory = parseAtifTrajectory(
        await readArtifact(completed.location, 'trajectory.json'),
      );
      const judge = parseJudgeEvidence(
        await readArtifact(completed.location, 'judge-evidence.json'),
        { forgeVersion: completed.result.forge.version },
      );
      const calls = judge.transcript.steps.flatMap((step) =>
        step.source === 'agent' ? (step.tool_calls ?? []) : [],
      );
      const observations = judge.transcript.steps.flatMap((step) =>
        step.source === 'agent' ? (step.observation?.results ?? []) : [],
      );
      assert.deepEqual(
        calls.map(({ tool_call_id, function_name }) => ({
          tool_call_id,
          function_name,
        })),
        [
          { tool_call_id: 'search-call-1', function_name: 'tool_search' },
          { tool_call_id: 'call-1', function_name: 'mcp__fixture.probe' },
        ],
      );
      assert.equal(observations.length, 2);
      const judgeResult = observations.find(
        ({ source_call_id }) => source_call_id === 'call-1',
      );
      assert.equal(judgeResult?.is_error, isError);
      if (typeof output === 'string') {
        const expectedOutput = output.replaceAll(AGENT_SECRET, '[REDACTED]');
        const nativeResult = trajectory.steps
          .flatMap((step) =>
            step.source === 'agent' ? (step.observation?.results ?? []) : [],
          )
          .find(({ source_call_id }) => source_call_id === 'call-1');
        assert.equal(nativeResult?.content, expectedOutput);
        assert.equal(nativeResult?.extra?.is_error, isError);
        assert.equal(judgeResult?.content, expectedOutput);
      }
      assert.ok(JSON.stringify(observations).includes(marker));
      assert.ok(
        provider.calls[0]!.request.systemPrompt?.includes(
          createJudgeTranscriptProjection(trajectory).transcriptJson,
        ),
      );
      if (shape === 'structured-string')
        assert.ok(
          JSON.stringify(observations).includes(
            'Opaque tool data remains visible.',
          ),
        );
      if (shape === 'image-metadata') {
        assert.ok(test.native()!.includes('SNAPSHOT_ONLY_IMAGE_METADATA'));
        assert.ok(
          !JSON.stringify(trajectory).includes('SNAPSHOT_ONLY_IMAGE_METADATA'),
        );
        assert.ok(
          !JSON.stringify(judge).includes('SNAPSHOT_ONLY_IMAGE_METADATA'),
        );
        assert.ok(
          !JSON.stringify(request).includes('SNAPSHOT_ONLY_IMAGE_METADATA'),
        );
      }
      for (const artifact of completed.result.artifacts) {
        const body = await fs.readFile(
          path.join(completed.location, artifact.path),
          'utf8',
        );
        assert.ok(!body.includes(AGENT_SECRET));
        assert.ok(!body.includes(imageData));
      }
      await assertRestrictedNative(completed, test.native()!);
    });
  }

  it('falls back for qualified MCP evidence without a completion snapshot even when output.is_error is false', async () => {
    const marker = 'UNVERIFIED_NATIVE_MCP_FAILURE_OUTPUT';
    const result = {
      content: [{ type: 'text', text: `${marker}: ${AGENT_SECRET}` }],
      isError: true,
    };
    const output = `Wall time: 0.001 seconds\nOutput:\n${JSON.stringify(result.content)}`;
    const plan = createTestResolvedRunPlan({
      agent: selection,
      prompt: 'Look up the fixture.',
      judge: JUDGE_MODEL,
      judgingCriteria: [
        {
          criteria_requirement: 'SHOULD' as const,
          value: 'The assistant reports the fixture failure.',
          requirement_level: 'MUST' as const,
        },
      ],
    });
    const test = await fixture(plan, {
      responses: ['The fixture tool reported a failure.'],
      native(turns) {
        let removedSnapshots = 0;
        const records = mcpRollout(turns, output, result)
          .trimEnd()
          .split('\n')
          .flatMap((line) => {
            const record = JSON.parse(line) as {
              type: string;
              payload: Record<string, unknown>;
            };
            if (
              record.type === 'event_msg' &&
              record.payload.type === 'item_completed'
            ) {
              assert.equal(
                (record.payload.item as { type: string }).type,
                'McpToolCall',
              );
              removedSnapshots += 1;
              return [];
            }
            if (record.payload.type === 'function_call') {
              delete record.payload.namespace;
              record.payload.name = 'mcp__fixture__probe';
            }
            if (record.payload.type === 'function_call_output') {
              record.payload.is_error = false;
            }
            return [JSON.stringify(record)];
          });
        assert.equal(removedSnapshots, 1);
        return `${records.join('\n')}\n`;
      },
      stdout: (response) => mcpStream(response, result),
    });
    const provider = createScriptedCompletionProvider({
      id: JUDGE_MODEL.provider,
      responses: [
        JSON.stringify({
          results: [
            {
              index: 0,
              passed: false,
              explanation: 'Synthetic incomplete-source evidence check.',
            },
          ],
        }),
      ],
    });
    const completed = await executeEval({
      runId: 'codex-mcp-no-snapshot-qualified-false',
      plan,
      composition: {
        ...test.composition,
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
      },
    });
    const verified = await verifyCompletedRun(completed.location);
    assert.equal(
      verified.result.evidence.provenance.source.kind,
      'driver_fallback',
    );
    assert.equal(verified.result.evidence.completeness, 'fallback');
    assert.deepEqual(
      verified.result.evidence.warnings.map(({ code }) => code),
      ['source_incomplete', 'fallback_used'],
    );
    const interaction = parseInteractionArtifact(
      await readArtifact(completed.location, 'interaction.json'),
      { forgeVersion: completed.result.forge.version },
    );
    assert.deepEqual(interaction.turns[0]!.tool_calls, [
      { id: 'item_1', name: 'mcp__fixture__probe', input: {} },
    ]);
    const trajectory = parseAtifTrajectory(
      await readArtifact(completed.location, 'trajectory.json'),
    );
    const judge = parseJudgeEvidence(
      await readArtifact(completed.location, 'judge-evidence.json'),
      { forgeVersion: completed.result.forge.version },
    );
    const calls = judge.transcript.steps.flatMap((step) =>
      step.source === 'agent' ? (step.tool_calls ?? []) : [],
    );
    assert.deepEqual(calls, [
      {
        tool_call_id: 'item_1',
        function_name: 'mcp__fixture__probe',
        arguments: {},
      },
    ]);
    for (const steps of [trajectory.steps, judge.transcript.steps]) {
      const observations = steps.flatMap((step) =>
        step.source === 'agent' ? (step.observation?.results ?? []) : [],
      );
      assert.deepEqual(observations, []);
      assert.ok(!JSON.stringify(steps).includes('"is_error"'));
      assert.ok(!JSON.stringify(steps).includes(marker));
    }
    assert.equal(provider.calls.length, 1);
    const request = provider.calls[0]!.request;
    assert.ok(
      request.systemPrompt?.includes(
        createJudgeTranscriptProjection(trajectory).transcriptJson,
      ),
    );
    assert.ok(!JSON.stringify(request).includes(marker));
    assert.ok(!JSON.stringify(request).includes(AGENT_SECRET));
    assert.ok(test.native()!.includes(marker));
    assert.ok(test.native()!.includes(AGENT_SECRET));
    await assertRestrictedNative(completed, test.native()!);
  });

  it('falls back for null MCP content annotations containers', async () => {
    const result = {
      content: [
        {
          type: 'text',
          text: 'Malformed metadata fixture.',
          annotations: null,
        },
      ],
      isError: false,
    };
    const output = `Wall time: 0.001 seconds\nOutput:\n${JSON.stringify(result.content)}`;
    const plan = createTestResolvedRunPlan({
      agent: selection,
      prompt: 'Look up the fixture.',
      judge: JUDGE_MODEL,
      judgingCriteria: [
        {
          criteria_requirement: 'SHOULD' as const,
          value: 'The assistant inspects the fixture.',
          requirement_level: 'MUST' as const,
        },
      ],
    });
    const test = await fixture(plan, {
      native: (turns) => mcpRollout(turns, output, result),
      stdout: (response) => mcpStream(response, result),
    });
    const provider = createScriptedCompletionProvider({
      id: JUDGE_MODEL.provider,
      responses: [
        JSON.stringify({
          results: [
            {
              index: 0,
              passed: false,
              explanation: 'Synthetic metadata fallback check.',
            },
          ],
        }),
      ],
    });
    const completed = await executeEval({
      runId: 'codex-mcp-metadata-annotations-null',
      plan,
      composition: {
        ...test.composition,
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
      },
    });
    const verified = await verifyCompletedRun(completed.location);
    assert.equal(
      verified.result.evidence.provenance.source.kind,
      'driver_fallback',
    );
    assert.equal(verified.result.evidence.completeness, 'fallback');
    assert.deepEqual(
      verified.result.evidence.warnings.map(({ code }) => code),
      ['source_incomplete', 'fallback_used'],
    );
    const judge = parseJudgeEvidence(
      await readArtifact(completed.location, 'judge-evidence.json'),
      { forgeVersion: completed.result.forge.version },
    );
    const calls = judge.transcript.steps.flatMap((step) =>
      step.source === 'agent' ? (step.tool_calls ?? []) : [],
    );
    const observations = judge.transcript.steps.flatMap((step) =>
      step.source === 'agent' ? (step.observation?.results ?? []) : [],
    );
    assert.deepEqual(
      calls.map(({ function_name }) => function_name),
      ['mcp__fixture__probe'],
    );
    assert.deepEqual(observations, []);
    assert.equal(provider.calls.length, 1);
    await assertRestrictedNative(completed, test.native()!);
  });

  for (const shape of ['structured-content', 'text-metadata'] as const) {
    it(`retains normal MCP truncated ${shape} output as partial native evidence without restoring omitted text`, async () => {
      const captured = truncatedMcpFixture(shape);
      const expectedOutput = captured.output.replaceAll(
        AGENT_SECRET,
        '[REDACTED]',
      );
      const plan = createTestResolvedRunPlan({
        agent: selection,
        prompt: 'Look up the large fixture.',
        judge: JUDGE_MODEL,
        judgingCriteria: [
          {
            criteria_requirement: 'SHOULD' as const,
            value: 'The assistant inspects the large fixture.',
            requirement_level: 'MUST' as const,
          },
        ],
      });
      const test = await fixture(plan, {
        native: (turns) => mcpRollout(turns, captured.output, captured.result),
        stdout: (response) => mcpStream(response, captured.result),
      });
      const provider = createScriptedCompletionProvider({
        id: JUDGE_MODEL.provider,
        responses: [
          JSON.stringify({
            results: [
              {
                index: 0,
                passed: true,
                explanation: 'Synthetic truncation evidence check.',
              },
            ],
          }),
        ],
      });
      const completed = await executeEval({
        runId: `codex-mcp-truncated-${shape}`,
        plan,
        composition: {
          ...test.composition,
          completionProviders: new Map([
            [provider.provider.id, provider.provider],
          ]),
        },
      });
      const verified = await verifyCompletedRun(completed.location);
      assert.equal(
        verified.result.evidence.provenance.source.kind,
        'native_log',
      );
      assert.equal(verified.result.evidence.completeness, 'partial');
      assert.deepEqual(
        verified.result.evidence.warnings.map(({ code }) => code),
        ['value_omitted'],
      );
      assert.match(verified.result.evidence.warnings[0]!.message, /truncat/i);
      assert.equal(provider.calls.length, 1);

      const trajectory = parseAtifTrajectory(
        await readArtifact(completed.location, 'trajectory.json'),
      );
      const judge = parseJudgeEvidence(
        await readArtifact(completed.location, 'judge-evidence.json'),
        { forgeVersion: completed.result.forge.version },
      );
      const nativeResults = trajectory.steps.flatMap((step) =>
        step.source === 'agent' ? (step.observation?.results ?? []) : [],
      );
      const nativeResult = nativeResults.find(
        ({ source_call_id }) => source_call_id === 'call-1',
      );
      assert.equal(nativeResult?.content, expectedOutput);
      assert.equal(nativeResult?.extra?.is_error, captured.isError);
      const calls = judge.transcript.steps.flatMap((step) =>
        step.source === 'agent' ? (step.tool_calls ?? []) : [],
      );
      const observations = judge.transcript.steps.flatMap((step) =>
        step.source === 'agent' ? (step.observation?.results ?? []) : [],
      );
      assert.deepEqual(
        calls.map(({ function_name }) => function_name),
        ['tool_search', 'mcp__fixture.probe'],
      );
      assert.equal(observations.length, 2);
      const judgeResult = observations.find(
        ({ source_call_id }) => source_call_id === 'call-1',
      );
      assert.equal(judgeResult?.content, expectedOutput);
      assert.equal(judgeResult?.is_error, captured.isError);
      assert.ok(expectedOutput.includes(captured.retainedMarker));
      assert.ok(expectedOutput.includes(captured.truncationMarker));
      if (shape === 'text-metadata') {
        assert.ok(expectedOutput.includes('MCP_TRUNCATED_METADATA'));
        assert.ok(expectedOutput.includes('"credential":"[REDACTED]"'));
      }
      const projected = createJudgeTranscriptProjection(trajectory);
      assert.ok(
        provider.calls[0]!.request.systemPrompt?.includes(
          projected.transcriptJson,
        ),
      );
      for (const value of [trajectory, judge, provider.calls[0]!.request]) {
        const serialized = JSON.stringify(value);
        assert.ok(!serialized.includes(captured.omittedMarker));
        assert.ok(!serialized.includes(captured.unselectedMarker));
        assert.ok(!serialized.includes(AGENT_SECRET));
      }
      for (const artifact of completed.result.artifacts) {
        assert.ok(
          !(
            await fs.readFile(
              path.join(completed.location, artifact.path),
              'utf8',
            )
          ).includes(AGENT_SECRET),
        );
      }
      assert.ok(test.native()!.includes(captured.omittedMarker));
      assert.ok(test.native()!.includes(AGENT_SECRET));
      await assertRestrictedNative(completed, test.native()!);
    });
  }

  it('falls back for a corrupted MCP truncation count instead of trusting a truncation marker', async () => {
    const captured = truncatedMcpFixture('text');
    const output = captured.output.replace(
      captured.truncationMarker,
      '…1 tokens truncated…',
    );
    const plan = createTestResolvedRunPlan({
      agent: selection,
      prompt: 'Look up the large fixture.',
      judge: JUDGE_MODEL,
      judgingCriteria: [
        {
          criteria_requirement: 'SHOULD' as const,
          value: 'The assistant inspects the large fixture.',
          requirement_level: 'MUST' as const,
        },
      ],
    });
    const test = await fixture(plan, {
      native: (turns) => mcpRollout(turns, output, captured.result),
      stdout: (response) => mcpStream(response, captured.result),
    });
    const provider = createScriptedCompletionProvider({
      id: JUDGE_MODEL.provider,
      responses: [
        JSON.stringify({
          results: [
            {
              index: 0,
              passed: false,
              explanation: 'Synthetic fallback evidence check.',
            },
          ],
        }),
      ],
    });
    const completed = await executeEval({
      runId: 'codex-mcp-corrupt-omission-count',
      plan,
      composition: {
        ...test.composition,
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
      },
    });
    const verified = await verifyCompletedRun(completed.location);
    assert.equal(
      verified.result.evidence.provenance.source.kind,
      'driver_fallback',
    );
    assert.equal(verified.result.evidence.completeness, 'fallback');
    assert.deepEqual(
      verified.result.evidence.warnings.map(({ code }) => code),
      ['source_incomplete', 'fallback_used'],
    );
    const trajectory = parseAtifTrajectory(
      await readArtifact(completed.location, 'trajectory.json'),
    );
    const judge = parseJudgeEvidence(
      await readArtifact(completed.location, 'judge-evidence.json'),
      { forgeVersion: completed.result.forge.version },
    );
    const calls = judge.transcript.steps.flatMap((step) =>
      step.source === 'agent' ? (step.tool_calls ?? []) : [],
    );
    const observations = judge.transcript.steps.flatMap((step) =>
      step.source === 'agent' ? (step.observation?.results ?? []) : [],
    );
    assert.deepEqual(
      calls.map(({ function_name }) => function_name),
      ['mcp__fixture__probe'],
    );
    assert.deepEqual(observations, []);
    assert.ok(
      provider.calls[0]!.request.systemPrompt?.includes(
        createJudgeTranscriptProjection(trajectory).transcriptJson,
      ),
    );
    assert.ok(!JSON.stringify(judge).includes(captured.omittedMarker));
    assert.ok(
      !JSON.stringify(provider.calls[0]!.request).includes(AGENT_SECRET),
    );
    assert.ok(test.native()!.includes(captured.omittedMarker));
    await assertRestrictedNative(completed, test.native()!);
  });

  it('reconciles native coverage against both completed driver turns before accepting a valid but stale rollout', async () => {
    const plan = createTestResolvedRunPlan({
      agent: selection,
      mode: 'multi_turn',
      prompt: 'Complete both parts.',
      maxTurns: 3,
      rolePlayer: ROLE_MODEL,
    });
    const test = await fixture(plan, {
      responses: ['Part one complete.', 'Part two complete.'],
      native: (turns) => nativeRollout(turns.slice(0, 1)),
    });
    const provider = twoTurnProvider();
    const completed = await executeEval({
      runId: 'codex-stale-native',
      plan,
      composition: {
        ...test.composition,
        completionProviders: new Map([
          [provider.provider.id, provider.provider],
        ]),
      },
    });
    const verified = await verifyCompletedRun(completed.location);
    assert.equal(verified.result.evidence.completeness, 'fallback');
    assert.deepEqual(
      verified.result.evidence.warnings.map(({ code }) => code),
      ['source_incomplete', 'fallback_used'],
    );
    const trajectory = parseAtifTrajectory(
      await readArtifact(completed.location, 'trajectory.json'),
    );
    assert.deepEqual(
      trajectory.steps
        .filter(({ source }) => source === 'user')
        .map(({ message }) => message),
      ['Complete part one.', 'Complete part two.'],
    );
    assert.ok(JSON.stringify(trajectory).includes('Part two complete.'));
    assert.equal(test.native()!.includes('Part two complete.'), false);
    await assertRestrictedNative(completed, test.native()!);
  });

  it('never substitutes an unrelated rollout when the selected native session is absent', async () => {
    const plan = createTestResolvedRunPlan({
      agent: selection,
      prompt: 'Complete the requested answer.',
    });
    const test = await fixture(plan, { native: () => undefined });
    const completed = await executeEval({
      runId: 'codex-missing-native',
      plan,
      composition: test.composition,
    });
    const verified = await verifyCompletedRun(completed.location);
    assert.equal(verified.result.evidence.completeness, 'fallback');
    assert.deepEqual(
      verified.result.evidence.warnings.map(({ code }) => code),
      ['source_unavailable', 'fallback_used'],
    );
    assert.deepEqual(verified.result.supplemental_artifacts, []);
    const trajectory = parseAtifTrajectory(
      await readArtifact(completed.location, 'trajectory.json'),
    );
    assert.equal(trajectory.session_id, SESSION_ID);
    assert.doesNotMatch(JSON.stringify(trajectory), /UNRELATED_NATIVE_MARKER/);
  });

  it('cancels an in-flight Codex command, disposes the runtime, and commits no result', async () => {
    const plan = createTestResolvedRunPlan({ agent: selection });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let commandSignal: AbortSignal | undefined;
    const test = await fixture(plan, {
      agentCommand: (call) =>
        new Promise<CommandResult>((_resolve, reject) => {
          commandSignal = call.options.signal;
          commandSignal!.addEventListener(
            'abort',
            () => reject(commandSignal!.reason),
            { once: true },
          );
          entered();
        }),
    });
    const controller = new AbortController();
    const pending = executeEval({
      runId: 'codex-cancelled',
      plan,
      composition: test.composition,
      signal: controller.signal,
    });
    await ready;
    controller.abort(new Error('Synthetic cancellation'));
    await assert.rejects(pending, { code: 'aborted' });
    assert.ok(commandSignal?.aborted);
    assert.equal(test.runtime.runs[0]?.events.at(-1), 'dispose');
    assert.equal(test.runtime.runs[0]?.events.includes('quiesce'), false);
    await assert.rejects(
      fs.stat(path.join(test.resultsRoot, 'runs', 'codex-cancelled')),
      { code: 'ENOENT' },
    );
  });

  it('fails the version gate before interaction and cleans up without committing', async () => {
    const plan = createTestResolvedRunPlan({ agent: selection });
    const test = await fixture(plan, { versionOutput: 'codex-cli 0.0.0' });
    await assert.rejects(
      executeEval({
        runId: 'codex-wrong-version',
        plan,
        composition: test.composition,
      }),
      {
        code: 'runtime_failed',
        phase: 'runtime_prepare',
      },
    );
    assert.deepEqual(
      test.runtime.runs[0]!.commands.map(({ scope }) => scope),
      ['uncredentialed'],
    );
    assert.equal(test.runtime.runs[0]!.events.at(-1), 'dispose');
    await assert.rejects(
      fs.stat(path.join(test.resultsRoot, 'runs', 'codex-wrong-version')),
      { code: 'ENOENT' },
    );
  });
});
