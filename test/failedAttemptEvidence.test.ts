import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import {
  CLAUDE_PROJECTS_STATE_ID,
  createClaudeCodeAdapter,
} from '../src/agents/claude-code/index.ts';
import {
  CODEX_HOME_STATE_ID,
  createCodexAdapter,
} from '../src/agents/codex/index.ts';
import { createOpenCodeAdapter } from '../src/agents/opencode/index.ts';
import { parseAtifTrajectory } from '../src/atif/index.ts';
import type { AgentAdapter } from '../src/contracts/agent.ts';
import type { AttemptDiagnosticsStore } from '../src/contracts/attemptDiagnostics.ts';
import { CommandExecutionError } from '../src/contracts/command.ts';
import type { RuntimeAdapter } from '../src/contracts/runtime.ts';
import { createAttemptDiagnosticsStore } from '../src/diagnostics/localStore.ts';
import { attemptDiagnosticsIdentity } from '../src/diagnostics/model.ts';
import { executeEval } from '../src/execution/execute.ts';
import {
  createArtifactStore,
  verifyCompletedRun,
} from '../src/results/localStore.ts';
import { createScriptedCompletionProvider } from '../src/testing/completionProvider.ts';
import {
  createFakeRuntimeAdapter,
  createStaticCredentialResolver,
} from '../src/testing/fakes.ts';
import { createMemoryRunInputProvider } from '../src/testing/memoryInputs.ts';
import { createTestResolvedRunPlan } from '../src/testing/plans.ts';
import {
  OPEN_CODE_MODEL,
  OPEN_CODE_MODEL_PROFILE,
  openCodeExport,
  openCodeStream,
} from './support/opencode.ts';

const SECRET = 'synthetic-secret-value';
const PRIVATE = 'private-task-text';
const SESSION = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  harness: 'claude-code' | 'codex' | 'opencode',
  mode: 'exit' | 'timeout' | 'success',
  enabled: boolean,
  completeFirst = true,
  options: { completedTurns?: number; failExport?: 'later' | 'oversized' } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-failure-evidence-'),
  );
  roots.push(root);
  const adapter =
    harness === 'claude-code'
      ? createClaudeCodeAdapter({
          expectedVersion: '1.0.0',
          sessionIdFactory: () => SESSION,
        })
      : harness === 'codex'
        ? createCodexAdapter({ expectedVersion: '1.0.0' })
        : createOpenCodeAdapter({
            expectedVersion: '1.0.0',
            baseUrl: 'https://api.example.test/v1',
          });
  const selection = {
    adapter: adapter.id,
    provider:
      harness === 'claude-code'
        ? 'anthropic'
        : harness === 'codex'
          ? 'openai'
          : 'openai-compatible',
    model: harness === 'opencode' ? OPEN_CODE_MODEL : 'test-model',
    ...(harness === 'opencode'
      ? { model_profile: OPEN_CODE_MODEL_PROFILE }
      : {}),
  };
  const original = createTestResolvedRunPlan({
    agent: selection,
    mode: 'multi_turn',
    prompt: 'Complete the task.',
    rolePlayer: { provider: 'test-provider', model: 'test-role-player' },
  });
  const plan = {
    ...original,
    limits: { ...original.limits, run_timeout_ms: 1000 },
  };
  const response = `${PRIVATE} ${'x'.repeat(70000)} ${SECRET}`;
  const jsonl = (events: unknown[]) =>
    events.map((event) => JSON.stringify(event)).join('\n');
  const success =
    harness === 'claude-code'
      ? jsonl([{ type: 'result', session_id: SESSION, result: response }])
      : harness === 'codex'
        ? jsonl([
            { type: 'thread.started', thread_id: SESSION },
            { type: 'turn.started' },
            {
              type: 'item.completed',
              item: { id: 'one', type: 'agent_message', text: response },
            },
            {
              type: 'turn.completed',
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cached_input_tokens: 0,
              },
            },
          ])
        : openCodeStream({ prompt: 'Start work.', response });
  const native =
    harness === 'claude-code'
      ? jsonl([
          {
            type: 'assistant',
            sessionId: SESSION,
            message: { content: response },
          },
        ])
      : jsonl([
          { type: 'session_meta', payload: { id: SESSION, source: 'exec' } },
          { type: 'response_item', payload: { text: response } },
        ]);
  const stateFiles =
    harness === 'claude-code'
      ? { [CLAUDE_PROJECTS_STATE_ID]: { [`${SESSION}.jsonl`]: native } }
      : harness === 'codex'
        ? {
            [CODEX_HOME_STATE_ID]: {
              [`sessions/2026/01/01/rollout-2026-01-01T00-00-00-${SESSION}.jsonl`]:
                native,
            },
          }
        : {};
  let turns = 0;
  let exports = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const failedLines = Array.from({ length: 25 }, (_, index) =>
    JSON.stringify(
      harness === 'codex'
        ? {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              id: `failed-${index}`,
              text: `${PRIVATE} ${SECRET}`,
            },
          }
        : harness === 'claude-code'
          ? { type: 'assistant', message: { content: `${PRIVATE} ${SECRET}` } }
          : { type: 'error', error: { message: `${PRIVATE} ${SECRET}` } },
    ),
  );
  if (harness === 'codex')
    failedLines.unshift(
      JSON.stringify({ type: 'thread.started', thread_id: SESSION }),
    );
  const runtime = createFakeRuntimeAdapter({
    stateFiles,
    async command(command) {
      if (command.scope === 'uncredentialed')
        return {
          stdout: harness === 'codex' ? 'codex-cli 1.0.0\n' : '1.0.0',
          stderr: '',
          durationMs: 1,
          exitCode: 0,
        };
      if (command.argv[1] === 'export') {
        exports++;
        if (options.failExport === 'later' && exports > 1)
          return { stdout: '', stderr: '', durationMs: 1, exitCode: 1 };
        if (options.failExport === 'oversized')
          throw new CommandExecutionError(
            'Output limit exceeded.',
            'command_output_limit',
          );
        return {
          stdout: JSON.stringify(
            openCodeExport([{ prompt: 'Start work.', response }]),
          ),
          stderr: '',
          durationMs: 1,
          exitCode: 0,
        };
      }
      if (
        (++turns <= (options.completedTurns ?? 1) && completeFirst) ||
        mode === 'success'
      )
        return { stdout: success, stderr: '', durationMs: 1, exitCode: 0 };
      for (const line of failedLines) command.options.onStdoutLine?.(line);
      command.options.onStderrChunk?.(`${'s'.repeat(40000)}synthetic-sec`);
      command.options.onStderrChunk?.('ret-value');
      entered();
      if (mode === 'timeout') {
        await new Promise<void>((resolve) =>
          command.options.signal!.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        throw new CommandExecutionError('Command aborted.', 'command_aborted', {
          capture: {
            stdout: failedLines.join('\n'),
            stderr: `${'s'.repeat(40000)}${SECRET}`,
            durationMs: 1,
            stdoutBytes: 10000,
            stderrBytes: 40022,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        });
      }
      return {
        stdout: failedLines.join('\n'),
        stderr: `${'s'.repeat(40000)}${SECRET}`,
        durationMs: 1,
        exitCode: 9,
      };
    },
  });
  const provider = createScriptedCompletionProvider({
    responses: [
      JSON.stringify({
        user_needs: [{ description: 'Finish the task', status: 'remaining' }],
        message: 'Start work.',
      }),
      ...Array.from({ length: options.completedTurns ?? 1 }, () =>
        JSON.stringify({
          remaining_need_ids: ['need_1'],
          message: 'Continue work.',
        }),
      ),
      JSON.stringify({ remaining_need_ids: [], message: '' }),
    ],
  });
  const store = createAttemptDiagnosticsStore({ root });
  const run = (
    overrides: {
      agent?: AgentAdapter;
      runtime?: RuntimeAdapter;
      store?: AttemptDiagnosticsStore;
      signal?: AbortSignal;
    } = {},
  ) =>
    executeEval({
      runId: 'failed-evidence',
      plan,
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      composition: {
        runtime: overrides.runtime ?? runtime.adapter,
        agents: new Map([[adapter.id, overrides.agent ?? adapter]]),
        completionProviders: new Map([['test-provider', provider.provider]]),
        credentialResolver: createStaticCredentialResolver({
          'anthropic.api-key': SECRET,
          'openai.api-key': SECRET,
          'opencode.api-key': SECRET,
        }),
        inputProvider: createMemoryRunInputProvider(),
        artifactStore: createArtifactStore({
          root: path.join(root, 'results'),
        }),
        attemptDiagnosticsStore: overrides.store ?? store,
        restrictedDiagnosticExcerpts: enabled,
      },
    });
  return {
    root,
    run,
    started,
    store,
    identity: attemptDiagnosticsIdentity('failed-evidence', plan),
    runtime,
    adapter,
  };
}

describe('failed attempt evidence', () => {
  for (const harness of ['claude-code', 'codex'] as const)
    it(`${harness} preserves a source-reader limit reason in attempt.json`, async () => {
      const f = await fixture(harness, 'exit', true);
      await assert.rejects(
        f.run({
          agent: {
            ...f.adapter,
            async collectNativeArtifact(context) {
              const states = new Map(
                [...context.runtime.stateDirectories].map(([id, workspace]) => [
                  id,
                  {
                    ...workspace,
                    async inspect(file: string) {
                      const entry = await workspace.inspect(file);
                      return file.endsWith('.jsonl')
                        ? { ...entry, size: 16 * 1024 * 1024 + 1 }
                        : entry;
                    },
                  },
                ]),
              );
              return f.adapter.collectNativeArtifact!({
                ...context,
                runtime: { ...context.runtime, stateDirectories: states },
              });
            },
          },
        }),
        { code: 'agent_failed' },
      );
      const saved = (await f.store.read(
        f.identity,
        new AbortController().signal,
      ))!;
      assert.equal(saved.failure_evidence!.native_log.reason, 'too_large');
    });
  it('starts the native read budget after a slow quiesce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await fixture('claude-code', 'exit', true);
    let began!: () => void;
    const stopping = new Promise<void>((resolve) => {
      began = resolve;
    });
    const outcome = assert.rejects(
      f.run({
        runtime: {
          ...f.runtime.adapter,
          async prepare(input) {
            const prepared = await f.runtime.adapter.prepare(input);
            return {
              ...prepared,
              async quiesce() {
                began();
                await new Promise<void>((resolve) => setTimeout(resolve, 2000));
                return prepared.quiesce();
              },
            };
          },
        },
      }),
      { code: 'agent_failed' },
    );
    await Promise.race([stopping, outcome]);
    const pending = (await f.store.read(
      f.identity,
      new AbortController().signal,
    ))!;
    assert.equal(pending.state, 'running');
    assert.equal(pending.failure_evidence!.native_log.reason, undefined);
    await vi.advanceTimersByTimeAsync(2001);
    await outcome;
    const saved = (await f.store.read(
      f.identity,
      new AbortController().signal,
    ))!;
    assert.equal(saved.failure_evidence!.native_log.state, 'truncated');
    assert.equal(saved.failure_evidence!.native_log.capture_point, 'failure');
    assert.equal(saved.failure_evidence!.native_log.reason, undefined);
  });
  it('reports a quiesce timeout without reading unstable native files', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await fixture('claude-code', 'exit', true);
    let began!: () => void;
    const stopping = new Promise<void>((resolve) => {
      began = resolve;
    });
    let reads = 0;
    const outcome = assert.rejects(
      f.run({
        runtime: {
          ...f.runtime.adapter,
          async prepare(input) {
            const prepared = await f.runtime.adapter.prepare(input);
            return {
              ...prepared,
              async quiesce() {
                began();
                return new Promise(() => {});
              },
            };
          },
        },
        agent: {
          ...f.adapter,
          async collectNativeArtifact() {
            reads++;
            return undefined;
          },
        },
      }),
      { code: 'agent_failed' },
    );
    await Promise.race([stopping, outcome]);
    await vi.advanceTimersByTimeAsync(60_001);
    await outcome;
    const saved = (await f.store.read(
      f.identity,
      new AbortController().signal,
    ))!;
    assert.equal(saved.failure_evidence!.native_log.reason, 'timed_out');
    assert.equal(reads, 0);
    assert.equal(f.runtime.runs[0]!.events.at(-1), 'dispose');
  });
  it('reports unsupported capture and oversized artifacts with typed reasons', async () => {
    for (const reason of ['not_supported', 'too_large'] as const) {
      const f = await fixture('claude-code', 'exit', true);
      const agent: AgentAdapter = { ...f.adapter };
      if (reason === 'not_supported') delete agent.collectNativeArtifact;
      else
        agent.collectNativeArtifact = async () => ({
          format: 'claude-code-jsonl',
          sessionId: SESSION,
          body: Buffer.alloc(16 * 1024 * 1024 + 1),
          mediaType: 'text/plain',
          extension: 'jsonl',
        });
      await assert.rejects(f.run({ agent }), { code: 'agent_failed' });
      const saved = (await f.store.read(
        f.identity,
        new AbortController().signal,
      ))!;
      assert.equal(saved.failure_evidence!.native_log.state, 'unavailable');
      assert.equal(saved.failure_evidence!.native_log.reason, reason);
    }
  });
  it('disables native lookup when observed session IDs conflict', async () => {
    const f = await fixture('claude-code', 'exit', true);
    let reads = 0;
    await assert.rejects(
      f.run({
        agent: {
          ...f.adapter,
          async openSession(context) {
            const session = await f.adapter.openSession(context);
            context.diagnostics?.observeSessionId?.('another-session');
            return session;
          },
          async collectNativeArtifact() {
            reads++;
            return undefined;
          },
        },
      }),
      { code: 'agent_failed' },
    );
    const saved = (await f.store.read(
      f.identity,
      new AbortController().signal,
    ))!;
    assert.equal(
      saved.failure_evidence!.native_log.reason,
      'identity_conflict',
    );
    assert.equal(reads, 0);
  });
  it('records the exact completed turn covered by an older OpenCode export', async () => {
    const f = await fixture('opencode', 'exit', true, true, {
      completedTurns: 2,
      failExport: 'later',
    });
    await assert.rejects(f.run(), { code: 'agent_failed' });
    const saved = (await f.store.read(
      f.identity,
      new AbortController().signal,
    ))!;
    assert.equal(saved.failure_evidence!.partial_trajectory.completed_turns, 2);
    assert.equal(
      saved.failure_evidence!.native_log.capture_point,
      'completed_turn',
    );
    assert.equal(saved.failure_evidence!.native_log.through_turn, 1);
  });
  it('keeps the output-limit reason when an OpenCode export cannot be saved', async () => {
    const f = await fixture('opencode', 'exit', true, true, {
      failExport: 'oversized',
    });
    await assert.rejects(f.run(), { code: 'agent_failed' });
    const saved = (await f.store.read(
      f.identity,
      new AbortController().signal,
    ))!;
    assert.equal(saved.failure_evidence!.partial_trajectory.completed_turns, 1);
    assert.equal(saved.failure_evidence!.native_log.reason, 'too_large');
  });
  it('bounds a hung native read and ignores its late result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await fixture('claude-code', 'exit', true);
    let began!: () => void;
    const reading = new Promise<void>((resolve) => {
      began = resolve;
    });
    let resolveRead!: (artifact: undefined) => void;
    let readSignal: AbortSignal | undefined;
    const outcome = assert.rejects(
      f.run({
        agent: {
          ...f.adapter,
          async collectNativeArtifact(context) {
            readSignal = context.signal;
            began();
            return new Promise<undefined>((resolve) => {
              resolveRead = resolve;
            });
          },
        },
      }),
      { code: 'agent_failed' },
    );
    await Promise.race([reading, outcome]);
    await vi.advanceTimersByTimeAsync(501);
    await outcome;
    assert.equal(readSignal!.aborted, true);
    const saved = (await f.store.read(
      f.identity,
      new AbortController().signal,
    ))!;
    assert.equal(saved.failure_evidence!.native_log.state, 'unavailable');
    assert.equal(saved.failure_evidence!.native_log.reason, 'timed_out');
    assert.equal(saved.failure_evidence!.partial_trajectory.completed_turns, 1);
    assert.equal(f.runtime.runs[0]!.events.at(-1), 'dispose');
    resolveRead(undefined);
    await Promise.resolve();
    assert.deepEqual(
      await f.store.read(f.identity, new AbortController().signal),
      saved,
    );
  });
  it('keeps failure diagnostics when native collection throws or names another session', async () => {
    for (const mismatch of [false, true]) {
      const f = await fixture('claude-code', 'exit', true);
      await assert.rejects(
        f.run({
          agent: {
            ...f.adapter,
            async collectNativeArtifact() {
              if (!mismatch) throw new Error(PRIVATE);
              return {
                sessionId: 'other-session',
                format: 'claude-code-jsonl',
                body: Buffer.from(SECRET),
                mediaType: 'text/plain',
                extension: 'jsonl',
              };
            },
          },
        }),
        { code: 'agent_failed' },
      );
      const saved = (await f.store.read(
        f.identity,
        new AbortController().signal,
      ))!;
      assert.equal(saved.failure_evidence!.native_log.state, 'unavailable');
      assert.equal(
        saved.failure_evidence!.native_log.reason,
        mismatch ? 'identity_conflict' : 'read_failed',
      );
      assert.equal(
        saved.failure_evidence!.partial_trajectory.completed_turns,
        1,
      );
    }
  });
  it('marks requested text unsupported when the store cannot protect companions', async () => {
    const f = await fixture('claude-code', 'exit', true);
    await assert.rejects(
      f.run({ store: { read: f.store.read, write: f.store.write } }),
      { code: 'agent_failed' },
    );
    const saved = (await f.store.read(
      f.identity,
      new AbortController().signal,
    ))!;
    assert.equal(saved.capture.restricted, 'unsupported');
    assert.equal(
      saved.failure_evidence!.partial_trajectory.state,
      'unsupported',
    );
    assert.equal(saved.failure_evidence!.native_log.state, 'unsupported');
    assert.equal(saved.restricted, undefined);
    assert.deepEqual(
      await fs.readdir(path.join(f.root, 'diagnostics', 'failed-evidence')),
      ['attempt.json'],
    );
  });
  it('retains completed turns and failure tails after caller cancellation', async () => {
    const f = await fixture('claude-code', 'timeout', true);
    const controller = new AbortController();
    const outcome = assert.rejects(f.run({ signal: controller.signal }), {
      code: 'aborted',
    });
    await Promise.race([f.started, outcome]);
    controller.abort(new Error(PRIVATE));
    await outcome;
    const saved = (await f.store.read(
      f.identity,
      new AbortController().signal,
    ))!;
    assert.equal(saved.primary_failure!.reason, 'cancelled');
    assert.equal(saved.failure_evidence!.partial_trajectory.completed_turns, 1);
    assert.equal(saved.failure_evidence!.native_log.state, 'truncated');
    assert.equal(saved.restricted!.stderr_truncated, true);
  });
  for (const harness of ['claude-code', 'codex', 'opencode'] as const) {
    for (const mode of ['exit', 'timeout'] as const) {
      it(`${harness} retains bounded redacted evidence after ${mode}`, async () => {
        if (mode === 'timeout')
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const f = await fixture(harness, mode, true);
        const outcome = assert.rejects(
          f.run(),
          mode === 'timeout' ? { code: 'aborted' } : { code: 'agent_failed' },
        );
        await Promise.race([f.started, outcome]);
        if (mode === 'timeout') await vi.advanceTimersByTimeAsync(1001);
        await outcome;
        const saved = (await f.store.read(
          f.identity,
          new AbortController().signal,
        ))!;
        assert.equal(
          saved.primary_failure!.reason,
          mode === 'timeout' ? 'timeout' : 'failure',
        );
        assert.equal(saved.agent_invocations!.at(-1)!.state, 'failed');
        assert.equal(saved.agent_invocations!.at(-1)!.events.length, 20);
        assert.equal(saved.restricted!.stderr_truncated, true);
        assert.equal(
          saved.failure_evidence!.partial_trajectory.completed_turns,
          1,
        );
        assert.equal(
          saved.failure_evidence!.partial_trajectory.state,
          'truncated',
        );
        assert.equal(saved.failure_evidence!.native_log.state, 'truncated');
        assert.equal(
          saved.failure_evidence!.native_log.capture_point,
          harness === 'opencode' ? 'completed_turn' : 'failure',
        );
        assert.doesNotMatch(
          JSON.stringify(saved),
          new RegExp(`${SECRET}|${PRIVATE}`),
        );
        const folder = path.join(
          f.root,
          'diagnostics',
          'failed-evidence',
          'restricted',
        );
        for (const filename of await fs.readdir(folder)) {
          assert.doesNotMatch(
            await fs.readFile(path.join(folder, filename), 'utf8'),
            new RegExp(SECRET),
          );
          assert.equal(
            (await fs.stat(path.join(folder, filename))).mode & 0o777,
            0o600,
          );
        }
        const trajectoryDescriptor =
          saved.failure_evidence!.partial_trajectory.artifact!;
        const trajectory = parseAtifTrajectory(
          JSON.parse(
            await fs.readFile(
              path.join(folder, `${trajectoryDescriptor.sha256}.json`),
              'utf8',
            ),
          ),
        );
        assert.equal(trajectory.steps.length, 2);
        assert.equal(trajectory.steps[0]!.message, 'Start work.');
        assert.match(
          String(trajectory.steps[1]!.message),
          /diagnostic text truncated/,
        );
        assert.ok(trajectoryDescriptor.bytes <= 65536);
        assert.ok(saved.failure_evidence!.native_log.artifact!.bytes <= 65536);
        assert.deepEqual(
          await fs.readdir(path.join(f.root, 'results')).catch(() => []),
          [],
        );
        assert.equal(f.runtime.runs[0]!.events.at(-1), 'dispose');
        // The private companion remains verified even though it cannot affect results.
        await fs.writeFile(
          path.join(folder, `${trajectoryDescriptor.sha256}.json`),
          '{}',
        );
        await assert.rejects(
          f.store.read(f.identity, new AbortController().signal),
          /missing, unsafe or mismatched/,
        );
      });
    }
    it(`${harness} records an empty trajectory when its first invocation fails`, async () => {
      const f = await fixture(harness, 'exit', true, false);
      await assert.rejects(f.run(), { code: 'agent_failed' });
      const saved = (await f.store.read(
        f.identity,
        new AbortController().signal,
      ))!;
      assert.equal(saved.failure_evidence!.partial_trajectory.state, 'empty');
      assert.equal(
        saved.failure_evidence!.partial_trajectory.completed_turns,
        0,
      );
      assert.equal(
        saved.failure_evidence!.partial_trajectory.artifact,
        undefined,
      );
      assert.equal(
        saved.failure_evidence!.native_log.state,
        harness === 'opencode' ? 'unavailable' : 'truncated',
      );
    });
    it(`${harness} leaves scored artifacts unchanged when excerpts are enabled`, async () => {
      const off = await fixture(harness, 'success', false);
      const on = await fixture(harness, 'success', true);
      const left = await off.run();
      const right = await on.run();
      await verifyCompletedRun(left.location);
      await verifyCompletedRun(right.location);
      assert.deepEqual(left.result, right.result);
      const files = async (root: string) => {
        const names = await fs.readdir(root, { recursive: true });
        return Promise.all(
          names
            .filter((name) => name.endsWith('.json') || name.endsWith('.jsonl'))
            .sort()
            .map(async (name) => [
              name,
              await fs.readFile(path.join(root, name), 'utf8'),
            ]),
        );
      };
      assert.deepEqual(await files(left.location), await files(right.location));
      const saved = (await on.store.read(
        on.identity,
        new AbortController().signal,
      ))!;
      assert.equal(saved.failure_evidence, undefined);
      assert.equal(saved.restricted, undefined);
    });
    it(`${harness} keeps only counts and structure when excerpts are off`, async () => {
      const f = await fixture(harness, 'exit', false);
      await assert.rejects(f.run(), { code: 'agent_failed' });
      const saved = (await f.store.read(
        f.identity,
        new AbortController().signal,
      ))!;
      assert.equal(
        saved.failure_evidence!.partial_trajectory.completed_turns,
        1,
      );
      assert.equal(
        saved.failure_evidence!.partial_trajectory.state,
        'disabled',
      );
      assert.equal(saved.failure_evidence!.native_log.state, 'disabled');
      assert.equal(saved.restricted, undefined);
      assert.doesNotMatch(
        JSON.stringify(saved),
        new RegExp(`${SECRET}|${PRIVATE}`),
      );
      assert.deepEqual(
        await fs.readdir(path.join(f.root, 'diagnostics', 'failed-evidence')),
        ['attempt.json'],
      );
      assert.deepEqual(
        await fs.readdir(path.join(f.root, 'results')).catch(() => []),
        [],
      );
    });
  }
});
