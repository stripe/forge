import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'vitest';
import {
  CLAUDE_PROJECTS_STATE_ID,
  createClaudeCodeAdapter,
} from '../src/agents/claude-code/index.ts';
import { parseAtifTrajectory } from '../src/atif/index.ts';
import {
  createArtifactStore,
  executeEval,
  type ForgeComposition,
  parseInteractionArtifact,
  preflightEval,
  type ResolvedRunPlanV1,
  verifyCompletedRun,
} from '../src/index.ts';
import { FORGE_CLAUDE_CODE_VERSION } from '../src/runtime/docker/index.ts';
import {
  createFakeRuntimeAdapter,
  createMemoryRunInputProvider,
  createScriptedCompletionProvider,
  createStaticCredentialResolver,
  createTestResolvedRunPlan,
} from '../src/testing/index.ts';

const SESSION_ID = 'claude-integration-session';
const SECRET = 'synthetic-claude-integration-secret';
const selection = {
  adapter: 'claude-code',
  provider: 'anthropic',
  model: 'claude-test',
};

async function fixture(
  root: string,
  plan: ResolvedRunPlanV1,
  incomplete = false,
  nativeContext: readonly unknown[] = [],
) {
  const turns: Array<{ prompt: string; response: string }> = [];
  const resolved: string[] = [];
  let native = '';
  const runtime = createFakeRuntimeAdapter({
    stateFiles: {
      [CLAUDE_PROJECTS_STATE_ID]: {
        'unrelated.jsonl': 'UNRELATED_SESSION_MUST_NOT_BE_SELECTED',
      },
    },
    async command(call) {
      if (call.scope === 'uncredentialed') {
        assert.deepEqual(call.argv, ['claude', '--version']);
        assert.deepEqual(call.credentialEnvironmentNames, []);
        return {
          exitCode: 0,
          stdout: `${FORGE_CLAUDE_CODE_VERSION} (Claude Code)`,
          stderr: '',
          durationMs: 1,
        };
      }
      assert.equal(call.scope, 'agent');
      assert.deepEqual(call.credentialEnvironmentNames, ['ANTHROPIC_API_KEY']);
      const prompt = call.argv[2]!;
      assert.deepEqual(call.argv, [
        'claude',
        '-p',
        prompt,
        turns.length === 0 ? '--session-id' : '--resume',
        SESSION_ID,
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--disallowedTools',
        'Agent',
        '--model',
        selection.model,
      ]);
      const index = turns.length + 1;
      const response = `Part ${index} complete: ${SECRET}.`;
      turns.push({ prompt, response });
      const run = runtime.runs[0]!;
      if (plan.interaction.mode === 'one_shot' || turns.length === 2) {
        await run.workspace.mutable.writeFile(
          'answer.txt',
          Buffer.from('complete\n'),
        );
      }
      native = `${turns
        .flatMap((turn, turnIndex) => [
          {
            type: 'user',
            sessionId: SESSION_ID,
            message: { content: turn.prompt },
          },
          ...nativeContext,
          ...(!incomplete
            ? [
                {
                  type: 'assistant',
                  sessionId: SESSION_ID,
                  message: {
                    content: [
                      {
                        type: 'tool_use',
                        id: `call-${turnIndex + 1}`,
                        name: 'Write',
                        input: { file_path: 'answer.txt' },
                      },
                    ],
                  },
                },
                {
                  type: 'user',
                  sessionId: SESSION_ID,
                  message: {
                    content: [
                      {
                        type: 'tool_result',
                        tool_use_id: `call-${turnIndex + 1}`,
                        content: 'File written.',
                      },
                    ],
                  },
                },
              ]
            : []),
          ...(!incomplete
            ? [
                {
                  type: 'assistant',
                  sessionId: SESSION_ID,
                  message: {
                    content: [{ type: 'text', text: turn.response }],
                  },
                },
              ]
            : []),
        ])
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`;
      await run.stateDirectories
        .get(CLAUDE_PROJECTS_STATE_ID)!
        .mutable.writeFile(`${SESSION_ID}.jsonl`, Buffer.from(native));
      return {
        exitCode: 0,
        stderr: '',
        durationMs: 1,
        stdout: [
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: `call-${index}`,
                  name: 'Write',
                  input: { file_path: 'answer.txt' },
                },
              ],
            },
          },
          {
            type: 'result',
            result: response,
            session_id: SESSION_ID,
            total_cost_usd: 0.01,
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n'),
      };
    },
  });
  const agent = createClaudeCodeAdapter({
    sessionIdFactory: () => SESSION_ID,
    disallowedTools: ['Agent'],
  });
  const composition: ForgeComposition = {
    runtime: runtime.adapter,
    agents: new Map([[agent.id, agent]]),
    inputProvider: createMemoryRunInputProvider(),
    credentialResolver: createStaticCredentialResolver(
      {
        'anthropic.api-key': SECRET,
        'unrequested.api-key': 'must-not-resolve',
      },
      {
        onResolve(reference) {
          resolved.push(reference);
        },
      },
    ),
    artifactStore: createArtifactStore({ root: path.join(root, 'results') }),
  };
  return { runtime, composition, turns, resolved, native: () => native };
}

async function artifact(location: string, name: string): Promise<unknown> {
  return JSON.parse(
    await fs.readFile(path.join(location, name), 'utf8'),
  ) as unknown;
}

it('runs the real Claude adapter through two turns, native selection, redaction, and verified commit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-claude-e2e-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const rolePlayer = { provider: 'test-completions', model: 'role-test' };
  const plan = createTestResolvedRunPlan({
    agent: selection,
    mode: 'multi_turn',
    prompt: 'Complete both parts.',
    maxTurns: 3,
    rolePlayer,
    checks: {
      file_checks: [
        { file: 'answer.txt', exists: true, contains: '^complete\\n$' },
      ],
    },
  });
  const test = await fixture(root, plan);
  const provider = createScriptedCompletionProvider({
    id: rolePlayer.provider,
    responses: [
      JSON.stringify({
        user_needs: [
          {
            description: 'Complete both parts',
            acceptance: 'Both requested parts are complete.',
          },
        ],
        message: 'Do part one.',
      }),
      JSON.stringify({
        remaining_need_ids: ['need_1'],
        message: 'Do part two.',
      }),
      JSON.stringify({ remaining_need_ids: [], message: '' }),
    ],
  });
  const composition = {
    ...test.composition,
    completionProviders: new Map([[rolePlayer.provider, provider.provider]]),
  };
  preflightEval({ plan, composition });
  assert.equal(test.runtime.runs.length, 0);
  assert.deepEqual(test.resolved, []);
  const completed = await executeEval({
    runId: 'claude-two-turns',
    plan,
    composition,
  });
  const verified = await verifyCompletedRun(completed.location);
  assert.equal(verified.result.evaluation.status, 'passed');
  assert.equal(verified.result.agent.session_id, SESSION_ID);
  assert.equal(verified.result.evidence.completeness, 'complete');
  assert.equal(verified.result.evidence.provenance.source.kind, 'native_log');
  const trajectory = parseAtifTrajectory(
    await artifact(completed.location, 'trajectory.json'),
  );
  assert.deepEqual(
    trajectory.steps
      .filter(({ source }) => source === 'user')
      .map(({ message }) => message),
    test.turns.map(({ prompt }) => prompt),
  );
  assert.equal(
    trajectory.steps.flatMap((step) =>
      step.source === 'agent' ? (step.tool_calls ?? []) : [],
    ).length,
    2,
  );
  assert.match(JSON.stringify(trajectory), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(trajectory), /UNRELATED_SESSION/);
  const interaction = parseInteractionArtifact(
    await artifact(completed.location, 'interaction.json'),
    { forgeVersion: completed.result.forge.version },
  );
  assert.equal(interaction.turns.length, 2);
  for (const descriptor of completed.result.artifacts) {
    assert.ok(
      !(
        await fs.readFile(
          path.join(completed.location, descriptor.path),
          'utf8',
        )
      ).includes(SECRET),
    );
  }
  const native = completed.result.supplemental_artifacts.find(
    ({ path: name }) => name === 'native/claude-code/session.jsonl',
  );
  assert.equal(native?.sensitivity, 'restricted');
  const nativePath = path.join(completed.location, native!.path);
  assert.equal(await fs.readFile(nativePath, 'utf8'), test.native());
  assert.equal((await fs.stat(nativePath)).mode & 0o777, 0o600);
  assert.deepEqual(test.resolved, ['anthropic.api-key']);
  assert.deepEqual(test.runtime.runs[0]!.events, [
    'prepare',
    'command:uncredentialed',
    'finalizeSetup',
    'command:agent',
    'command:agent',
    'quiesce',
    'dispose',
  ]);
});

it('commits native evidence with batching bookkeeping, queued task context, and retry metadata', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-claude-records-'),
  );
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const plan = createTestResolvedRunPlan({
    agent: selection,
    prompt: 'Complete the answer.',
  });
  const notification = `<task-notification>Background task finished: ${SECRET}</task-notification>`;
  const test = await fixture(root, plan, false, [
    {
      type: 'attachment',
      attachment: {
        type: 'batching_reminder_sent',
        model: 'claude-test',
        text: 'Batch tool calls.',
      },
    },
    {
      type: 'attachment',
      sessionId: SESSION_ID,
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        prompt: notification,
        timestamp: '2026-09-17T16:02:50.000Z',
      },
      rendered: [
        {
          content: `<system-reminder>\nSynthetic background event.\n${notification}\n</system-reminder>`,
        },
      ],
    },
    {
      type: 'system',
      subtype: 'api_error',
      source: 'request_retry',
      error: { message: SECRET },
    },
  ]);
  const completed = await executeEval({
    runId: 'claude-native-records',
    plan,
    composition: test.composition,
  });
  const verified = await verifyCompletedRun(completed.location);
  assert.equal(verified.result.evidence.completeness, 'partial');
  assert.equal(verified.result.evidence.provenance.source.kind, 'native_log');
  assert.deepEqual(
    verified.result.evidence.warnings.map(({ code }) => code),
    ['unsupported_native_event'],
  );
  const trajectory = parseAtifTrajectory(
    await artifact(completed.location, 'trajectory.json'),
  );
  assert.deepEqual(
    trajectory.steps
      .filter(({ source }) => source === 'user')
      .map(({ message }) => message),
    ['Complete the answer.'],
  );
  assert.equal(trajectory.steps[1]?.source, 'system');
  assert.equal(
    trajectory.steps[1]?.message,
    '<system-reminder>\nSynthetic background event.\n<task-notification>Background task finished: [REDACTED]</task-notification>\n</system-reminder>',
  );
  assert.doesNotMatch(JSON.stringify(trajectory), new RegExp(SECRET));
  assert.equal(
    await fs.readFile(
      path.join(completed.location, 'native/claude-code/session.jsonl'),
      'utf8',
    ),
    test.native(),
  );
});

it('commits complete native evidence when only API retry metadata is ignored', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-claude-retries-'),
  );
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const plan = createTestResolvedRunPlan({
    agent: selection,
    prompt: 'Complete the answer.',
  });
  const test = await fixture(root, plan, false, [
    {
      type: 'system',
      subtype: 'api_error',
      source: 'request_retry',
      error: { message: 'Synthetic retry response body' },
    },
  ]);
  const completed = await executeEval({
    runId: 'claude-native-retries',
    plan,
    composition: test.composition,
  });
  const verified = await verifyCompletedRun(completed.location);
  assert.equal(verified.result.evidence.completeness, 'complete');
  assert.equal(verified.result.evidence.provenance.source.kind, 'native_log');
  assert.deepEqual(verified.result.evidence.warnings, []);
  assert.doesNotMatch(
    JSON.stringify(await artifact(completed.location, 'trajectory.json')),
    /Synthetic retry response body/,
  );
});

it('uses driver fallback for user-only Claude native evidence while preserving exact restricted source', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-claude-fallback-'),
  );
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const plan = createTestResolvedRunPlan({
    agent: selection,
    prompt: 'Complete the answer.',
  });
  const test = await fixture(root, plan, true);
  const completed = await executeEval({
    runId: 'claude-incomplete',
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
    ['source_invalid', 'fallback_used'],
  );
  const trajectory = parseAtifTrajectory(
    await artifact(completed.location, 'trajectory.json'),
  );
  assert.equal(
    trajectory.steps.flatMap((step) =>
      step.source === 'agent' ? (step.tool_calls ?? []) : [],
    ).length,
    1,
  );
  assert.match(JSON.stringify(trajectory), /\[REDACTED\]/);
  assert.equal(
    await fs.readFile(
      path.join(completed.location, 'native/claude-code/session.jsonl'),
      'utf8',
    ),
    test.native(),
  );
});
