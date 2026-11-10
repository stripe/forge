import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type {
  AgentPrepareContext,
  AgentSessionContext,
} from '../../contracts/agent.ts';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../../contracts/command.ts';
import { CommandExecutionError } from '../../contracts/command.ts';
import type {
  MutableWorkspace,
  RuntimeLogicalPaths,
} from '../../contracts/runtime.ts';
import type {
  AgentInvocationRecord,
  RestrictedAgentExcerpts,
} from '../../diagnostics/agent.ts';
import { FORGE_CODEX_VERSION } from '../../runtime/docker/assets.ts';
import { createRedactedTail } from '../../security/diagnosticRedaction.ts';
import { redactSecrets } from '../../security/redaction.ts';
import { createMemoryRunInputProvider } from '../../testing/memoryInputs.ts';
import { createMemoryWorkspace } from '../../testing/memoryWorkspace.ts';
import { createTestResolvedRunPlan } from '../../testing/plans.ts';
import { FORGE_VERSION } from '../../version.ts';
import {
  CODEX_HOME_STATE_ID,
  type CodexAdapterOptions,
  createCodexAdapter,
} from './index.ts';

const SESSION_ID = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const OTHER_SESSION_ID = '0199a213-81c0-7800-8aa1-bbab2a035a54';
const selection = { adapter: 'codex', provider: 'openai', model: 'gpt-test' };

interface Call {
  scope: 'uncredentialed' | 'agent';
  argv: readonly string[];
  options: CommandOptions;
}

function result(stdout: string, exitCode = 0): CommandResult {
  return { stdout, stderr: '', exitCode, durationMs: 1 };
}

function completed(sessionId = SESSION_ID, text = 'Done'): string {
  return [
    { type: 'thread.started', thread_id: sessionId },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 1 },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
}

function fixture(
  options: {
    adapterOptions?: CodexAdapterOptions;
    paths?: RuntimeLogicalPaths;
    missingState?: boolean;
    hookTrust?: 'native' | 'automation';
    command?: (call: Call) => CommandResult | Promise<CommandResult>;
  } = {},
) {
  const adapter = createCodexAdapter(options.adapterOptions);
  const plan = createTestResolvedRunPlan({
    agent: {
      ...selection,
      adapter: adapter.id,
      provider: options.adapterOptions?.provider ?? selection.provider,
      ...(options.hookTrust === undefined
        ? {}
        : { hook_trust: options.hookTrust }),
    },
  });
  const calls: Call[] = [];
  const runner = (scope: Call['scope']): CommandRunner => ({
    async run(argv, commandOptions = {}) {
      const call = { scope, argv: [...argv], options: { ...commandOptions } };
      calls.push(call);
      return (
        options.command?.(call) ??
        result(
          scope === 'uncredentialed'
            ? `codex-cli ${options.adapterOptions?.expectedVersion ?? FORGE_CODEX_VERSION}\n`
            : completed(),
        )
      );
    },
  });
  const base = {
    runId: 'codex-test',
    plan,
    selection: plan.agent,
    inputs: createMemoryRunInputProvider(),
    signal: new AbortController().signal,
  };
  const runtime = {
    runtimeId: base.runId,
    paths: options.paths ??
      options.adapterOptions?.layout ?? {
        workspace: '/workspace',
        home: '/home/forge',
      },
    workspace: createMemoryWorkspace().mutable,
    stateDirectories: new Map<string, MutableWorkspace>(
      options.missingState
        ? []
        : [[CODEX_HOME_STATE_ID, createMemoryWorkspace().mutable]],
    ),
  };
  const prepareContext: AgentPrepareContext = {
    ...base,
    runtime: {
      ...runtime,
      commands: { uncredentialed: runner('uncredentialed') },
    },
  };
  const sessionContext: AgentSessionContext = {
    ...base,
    runtime: { ...runtime, commands: { agent: runner('agent') } },
  };
  return { adapter, calls, prepareContext, sessionContext };
}

function configArguments(argv: readonly string[]): readonly string[] {
  return argv.flatMap((argument, index) =>
    argument === '-c' ? [argv[index + 1]!] : [],
  );
}

function assertIsolatedCommand(argv: readonly string[]): void {
  const config = configArguments(argv);
  for (const value of [
    'cli_auth_credentials_store="ephemeral"',
    'analytics.enabled=false',
    'check_for_update_on_startup=false',
  ]) {
    assert.ok(
      config.includes(value),
      `Missing isolated Codex configuration: ${value}`,
    );
  }
  assert.equal(argv.includes('--ignore-user-config'), false);
  assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Codex adapter', () => {
  it('rejects model profiles even with a custom adapter ID', () => {
    const adapter = createCodexAdapter({ id: 'custom-agent' });
    assert.throws(
      () =>
        adapter.requirements({
          adapter: 'custom-agent',
          provider: 'openai',
          model: 'test',
          model_profile: {
            limit: { context: 32000, output: 4000 },
            reasoning: false,
            temperature: true,
            attachment: false,
          },
        }),
      /model_profile is not supported/,
    );
  });

  it('retains a failed process exit status without copying command output', async () => {
    const test = fixture({
      command: () => ({
        ...result('private stdout', 17),
        stderr: 'private stderr',
      }),
    });
    const session = await test.adapter.openSession(test.sessionContext);
    await assert.rejects(
      session.send('Run the task', { signal: test.sessionContext.signal }),
      {
        message:
          'Codex exited with status 17 without a successful completed turn.',
      },
    );
  });

  it('applies hook policy and refreshed native plugin settings on initial and resumed turns', async () => {
    for (const hookTrust of ['native', 'automation'] as const) {
      const test = fixture({ hookTrust });
      const home =
        test.sessionContext.runtime.stateDirectories.get(CODEX_HOME_STATE_ID)!;
      const writeConfig = (enabled: boolean) =>
        home.writeFile(
          'config.toml',
          Buffer.from(`
[plugins."fixture@test"]
enabled=${enabled}
[model_providers.forge]
http_headers={"X-Wrong"="synthetic-secret"}
`),
        );
      await writeConfig(true);
      const session = await test.adapter.openSession(test.sessionContext);
      await session.send('First', { signal: test.sessionContext.signal });
      assert.match(
        Buffer.from(await home.readFile('config.toml')).toString(),
        /enabled = true/,
      );
      await writeConfig(false);
      await session.send('Second', { signal: test.sessionContext.signal });
      assert.match(
        Buffer.from(await home.readFile('config.toml')).toString(),
        /enabled = false/,
      );
      assert.doesNotMatch(
        Buffer.from(await home.readFile('config.toml')).toString(),
        /synthetic-secret/,
      );
      for (const call of test.calls) {
        assert.equal(
          call.argv.includes('--dangerously-bypass-hook-trust'),
          hookTrust === 'automation',
        );
        assert.equal(call.argv.includes('--ignore-user-config'), false);
      }
      assert.ok(test.calls[1]!.argv.includes('resume'));
    }
  });
  it('declares run-owned configuration and opaque credentials for engine-assigned scope', () => {
    const adapter = createCodexAdapter();
    assert.equal(adapter.id, 'codex');
    assert.equal(adapter.version, FORGE_VERSION);
    assert.deepEqual(adapter.metadata, {
      endpoint_mode: 'default',
      layout_mode: 'default',
    });
    assert.deepEqual(adapter.requirements(selection), {
      executables: ['codex'],
      environment: {
        variables: { CODEX_HOME: '/home/forge/.codex' },
        credentials: { CODEX_API_KEY: { reference: 'openai.api-key' } },
      },
      stateDirectories: [
        { id: CODEX_HOME_STATE_ID, containerPath: '/home/forge/.codex' },
      ],
    });
    assert.deepEqual(adapter.evidenceIdentity(selection), {
      name: 'codex',
      version: FORGE_CODEX_VERSION,
    });
    assert.ok(adapter.pluginInstaller);
    assert.ok(Object.isFrozen(adapter));
  });

  it('requires the configured adapter and provider before declaring authority', () => {
    const adapter = createCodexAdapter();
    for (const mismatch of [
      { ...selection, adapter: 'other-agent' },
      { ...selection, provider: 'other-provider' },
    ]) {
      assert.throws(() => adapter.requirements(mismatch), /does not match/);
      assert.throws(() => adapter.evidenceIdentity(mismatch), /does not match/);
    }
  });

  it('binds compatible Responses endpoints to an environment name, not a secret or reference in argv', async () => {
    const test = fixture({
      adapterOptions: {
        id: 'codex-gateway',
        provider: 'responses-compatible',
        baseUrl: 'https://gateway.example.test/openai/v1',
        credential: 'gateway.routing-token',
        credentialEnvironmentName: 'GATEWAY_TOKEN',
      },
    });
    assert.equal(test.adapter.version, FORGE_VERSION);
    assert.deepEqual(test.adapter.metadata, {
      endpoint_mode: 'custom',
      layout_mode: 'default',
    });
    assert.deepEqual(
      test.adapter.requirements(test.sessionContext.selection).environment,
      {
        variables: { CODEX_HOME: '/home/forge/.codex' },
        credentials: { GATEWAY_TOKEN: { reference: 'gateway.routing-token' } },
      },
    );
    const session = await test.adapter.openSession(test.sessionContext);
    await session.send('First', { signal: test.sessionContext.signal });
    await session.send('Continue', { signal: test.sessionContext.signal });
    for (const call of test.calls) {
      assertIsolatedCommand(call.argv);
      const config = configArguments(call.argv);
      assert.ok(config.includes('model_provider="forge"'));
      assert.ok(
        config.includes(
          'model_providers.forge.base_url="https://gateway.example.test/openai/v1"',
        ),
      );
      assert.ok(
        config.includes('model_providers.forge.env_key="GATEWAY_TOKEN"'),
      );
      assert.ok(config.includes('model_providers.forge.wire_api="responses"'));
      assert.ok(
        config.includes('model_providers.forge.requires_openai_auth=false'),
      );
      assert.doesNotMatch(
        call.argv.join('\n'),
        /gateway\.routing-token|api_key=|bearer_token=/,
      );
      assert.equal(call.scope, 'agent');
    }
  });

  it('checks the exact binary version only through the uncredentialed preparation runner', async () => {
    const test = fixture({
      adapterOptions: {
        executable: '/opt/tools/codex',
        expectedVersion: '9.8.7',
      },
    });
    await test.adapter.prepare(test.prepareContext);
    assert.equal(test.calls.length, 1);
    assert.deepEqual(test.calls[0]?.argv, ['/opt/tools/codex', '--version']);
    assert.equal(test.calls[0]?.scope, 'uncredentialed');
    assert.equal(test.calls[0]?.options.signal, test.prepareContext.signal);
    assert.equal(test.calls[0]?.options.timeoutMs, 30_000);
    assert.equal(test.calls[0]?.options.maxOutputBytes, 64 * 1024);
    assert.deepEqual(test.adapter.evidenceIdentity(selection), {
      name: 'codex',
      version: '9.8.7',
    });
  });

  it('rejects a missing state directory before any version command', async () => {
    const test = fixture({ missingState: true });
    await assert.rejects(
      test.adapter.prepare(test.prepareContext),
      /state is unavailable/,
    );
    assert.equal(test.calls.length, 0);
  });

  it('rejects nonzero or nonmatching version output without disclosing command output', async () => {
    for (const output of [
      result(`codex-cli ${FORGE_CODEX_VERSION}`, 1),
      result('codex-cli 0.0.0'),
      result(FORGE_CODEX_VERSION),
      result(`codex-cli ${FORGE_CODEX_VERSION}\nprivate-output`),
    ]) {
      const test = fixture({ command: () => output });
      await assert.rejects(
        test.adapter.prepare(test.prepareContext),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /version does not match/);
          assert.doesNotMatch(error.message, /private-output/);
          return true;
        },
      );
      assert.equal(test.calls[0]?.scope, 'uncredentialed');
    }
  });

  it('uses the selected model, workspace cwd, literal prompt, and exact thread ID across turns', async () => {
    const test = fixture({ adapterOptions: { executable: '/opt/bin/codex' } });
    const session = await test.adapter.openSession(test.sessionContext);
    assert.equal(session.sessionId(), undefined);
    const prompts = [
      '--model not-a-flag; $(not-a-command)\nquoted "text"',
      '--last is literal prompt text',
    ];
    for (const prompt of prompts) {
      const signal = new AbortController().signal;
      const turn = await session.send(prompt, { signal });
      assert.equal(turn.sessionId, SESSION_ID);
      assert.equal(turn.text, 'Done');
      assert.equal(session.sessionId(), SESSION_ID);
      const call = test.calls.at(-1)!;
      assertIsolatedCommand(call.argv);
      assert.deepEqual(call.argv.slice(0, 2), ['/opt/bin/codex', 'exec']);
      assert.equal(call.argv.at(-1), prompt);
      assert.ok(
        call.argv.indexOf('--') >= 0 &&
          call.argv.indexOf('--') < call.argv.length - 1,
      );
      assert.equal(
        call.argv[call.argv.indexOf('--model') + 1],
        selection.model,
      );
      assert.ok(call.argv.includes('--json'));
      assert.ok(call.argv.includes('--skip-git-repo-check'));
      assert.equal(call.argv.includes('--last'), false);
      assert.equal(call.options.cwd, '.');
      assert.equal(call.options.signal, signal);
      assert.equal(
        call.options.timeoutMs,
        test.sessionContext.plan.limits.run_timeout_ms,
      );
      assert.equal(call.options.maxOutputBytes, 16 * 1024 * 1024);
    }
    assert.equal(test.calls[0]!.argv.includes('resume'), false);
    const resumed = test.calls[1]!.argv;
    assert.ok(
      resumed.slice(resumed.indexOf('resume') + 1).includes(SESSION_ID),
    );
    assert.equal(
      resumed.filter((argument) => argument === SESSION_ID).length,
      1,
    );
  });

  it('does not adopt or advance session identity on failed command exits', async () => {
    const outputs = [
      result(completed(OTHER_SESSION_ID), 1),
      result(completed()),
      {
        ...result(completed(OTHER_SESSION_ID), 2),
        stderr: 'private-error-output',
      },
      result(completed()),
    ];
    const test = fixture({ command: () => outputs.shift()! });
    const session = await test.adapter.openSession(test.sessionContext);
    const send = () =>
      session.send('Work', { signal: test.sessionContext.signal });
    await assert.rejects(send(), /without a successful completed turn/);
    assert.equal(session.sessionId(), undefined);
    await send();
    assert.equal(test.calls[1]!.argv.includes('resume'), false);
    await assert.rejects(send(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /without a successful completed turn/);
      assert.doesNotMatch(error.message, /private-error-output/);
      return true;
    });
    assert.equal(session.sessionId(), SESSION_ID);
    await send();
    const resumed = test.calls[3]!.argv;
    assert.ok(
      resumed.slice(resumed.indexOf('resume') + 1).includes(SESSION_ID),
    );
  });

  it('keeps the established thread after a malformed or mismatched resumed stream', async () => {
    const outputs = [
      completed(),
      completed(OTHER_SESSION_ID),
      'not json',
      completed(),
    ];
    const test = fixture({ command: () => result(outputs.shift()!) });
    const session = await test.adapter.openSession(test.sessionContext);
    const send = () =>
      session.send('Work', { signal: test.sessionContext.signal });
    await send();
    await assert.rejects(send(), /session ID/);
    assert.equal(session.sessionId(), SESSION_ID);
    await assert.rejects(send());
    assert.equal(session.sessionId(), SESSION_ID);
    await send();
    assert.equal(session.sessionId(), SESSION_ID);
  });

  it('forwards send cancellation and releases the in-flight guard after the runner rejects', async () => {
    const entered = deferred<void>();
    let first = true;
    const test = fixture({
      command: (call) => {
        if (!first) return result(completed());
        first = false;
        return new Promise<CommandResult>((_resolve, reject) => {
          call.options.signal!.addEventListener(
            'abort',
            () => reject(call.options.signal!.reason),
            { once: true },
          );
          entered.resolve();
        });
      },
    });
    const session = await test.adapter.openSession(test.sessionContext);
    const controller = new AbortController();
    const pending = session.send('Work', { signal: controller.signal });
    await entered.promise;
    assert.equal(test.calls[0]?.options.signal, controller.signal);
    const reason = new Error('test cancellation');
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(session.sessionId(), undefined);
    await session.send('Try again', { signal: new AbortController().signal });
    assert.equal(session.sessionId(), SESSION_ID);
  });

  it('rejects concurrent sends without starting a second command or advancing identity', async () => {
    const first = deferred<CommandResult>();
    let calls = 0;
    const test = fixture({
      command: () => (calls++ === 0 ? first.promise : result(completed())),
    });
    const session = await test.adapter.openSession(test.sessionContext);
    const pending = session.send('First', {
      signal: test.sessionContext.signal,
    });
    await assert.rejects(
      session.send('Concurrent', { signal: test.sessionContext.signal }),
      /concurrent/,
    );
    assert.equal(test.calls.length, 1);
    assert.equal(session.sessionId(), undefined);
    first.resolve(result(completed()));
    await pending;
    await session.send('Next', { signal: test.sessionContext.signal });
    assert.equal(test.calls.length, 2);
    assert.equal(session.sessionId(), SESSION_ID);
  });

  it('rejects invalid prompts without invoking commands', async () => {
    const test = fixture();
    const session = await test.adapter.openSession(test.sessionContext);
    for (const prompt of ['', '-', 'before\0after']) {
      await assert.rejects(
        session.send(prompt, { signal: test.sessionContext.signal }),
        /prompt/,
      );
    }
    assert.equal(test.calls.length, 0);
  });

  it('rejects runtime layout mismatches before version checks or session creation', async () => {
    for (const paths of [
      { workspace: '/other/workspace', home: '/home/forge' },
      { workspace: '/workspace', home: '/other/home' },
    ]) {
      const test = fixture({ paths });
      await assert.rejects(
        test.adapter.prepare(test.prepareContext),
        /paths do not match/,
      );
      await assert.rejects(
        test.adapter.openSession(test.sessionContext),
        /paths do not match/,
      );
      assert.equal(test.calls.length, 0);
    }
  });

  it('rejects endpoint URLs that embed credentials or have unsafe syntax', () => {
    for (const baseUrl of [
      '',
      'relative/path',
      'ftp://example.test',
      'https://user:secret@example.test',
      'https://example.test?token=secret',
      'https://example.test/#fragment',
      'https://example.test/\nnext',
      `https://example.test/${'x'.repeat(4096)}`,
    ]) {
      assert.throws(() => createCodexAdapter({ baseUrl }), /baseUrl/);
    }
  });

  it('rejects credentials that overwrite runtime paths or API routing', () => {
    for (const credentialEnvironmentName of [
      'CODEX_HOME',
      'HOME',
      'PATH',
      'PWD',
      'TMPDIR',
      'TMP',
      'TEMP',
      'OPENAI_BASE_URL',
    ]) {
      assert.throws(
        () => createCodexAdapter({ credentialEnvironmentName }),
        /must not override/,
      );
    }
    assert.throws(() =>
      createCodexAdapter({ credentialEnvironmentName: 'INVALID-NAME' }),
    );
  });
});

describe('Codex invocation diagnostics', () => {
  const prefix = [
    { type: 'thread.started', thread_id: SESSION_ID },
    { type: 'turn.started' },
  ].map((value) => JSON.stringify(value));
  for (const [name, tail, expected] of [
    [
      'error item',
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i', type: 'error', message: 'HTTP 502 secret-value' },
      }),
      'item_error',
    ],
    [
      'failed turn',
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'status 429 secret-value' },
      }),
      'turn_failed',
    ],
    [
      'unknown event',
      JSON.stringify({ type: 'malicious-secret-value' }),
      'unsupported_event_type',
    ],
    [
      'unknown field',
      JSON.stringify({ type: 'turn.completed', 'secret-value': 'private' }),
      'unexpected_field',
    ],
    [
      'unknown item',
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i', type: 'secret-value' },
      }),
      'unsupported_event_type',
    ],
    ['malformed JSON', '{secret-value', 'invalid_json'],
    [
      'event order',
      JSON.stringify({ type: 'thread.started', thread_id: SESSION_ID }),
      'invalid_event_order',
    ],
  ] as const) {
    it(`retains a safe location for ${name} without accepting the invocation`, async () => {
      const stdout = [...prefix, tail].join('\n');
      const records: AgentInvocationRecord[] = [];
      const bodies: RestrictedAgentExcerpts[] = [];
      const f = fixture({
        command: (call) => {
          for (const line of stdout.split('\n'))
            call.options.onStdoutLine?.(line);
          return result(stdout);
        },
      });
      const session = await f.adapter.openSession({
        ...f.sessionContext,
        diagnostics: {
          restrictedExcerpts: false,
          redact: (text) => redactSecrets(text, ['secret-value']).value,
          redactedTail: (maximumBytes) =>
            createRedactedTail(['secret-value'], maximumBytes),
          async record(record, body) {
            records.push(record);
            if (body) bodies.push(body);
          },
        },
      });
      await assert.rejects(
        session.send('private prompt', {
          signal: new AbortController().signal,
        }),
      );
      const last = records.at(-1)!;
      assert.equal(last.rejection?.code, expected);
      assert.equal(last.rejection?.line_index, 3);
      assert.equal(
        last.rejection?.schema_path,
        expected === 'item_error' || name === 'unknown item'
          ? 'event.item'
          : 'event',
      );
      assert.equal(last.state, 'failed');
      assert.equal(last.events.length, 3);
      assert.equal(JSON.stringify(records).includes('secret-value'), false);
      assert.deepEqual(bodies, []);
      if (expected === 'item_error' || expected === 'turn_failed') {
        assert.equal(
          last.first_failure?.http_status,
          expected === 'item_error' ? 502 : 429,
        );
        assert.equal(last.first_failure?.http_origin, 'agent_reported');
      }
    });
  }

  it('retains process and parser failures together on a nonzero exit', async () => {
    const stdout = [
      ...prefix,
      JSON.stringify({ type: 'turn.failed', error: { message: 'HTTP 502' } }),
    ].join('\n');
    const records: AgentInvocationRecord[] = [];
    const f = fixture({ command: () => result(stdout, 1) });
    const session = await f.adapter.openSession({
      ...f.sessionContext,
      diagnostics: {
        restrictedExcerpts: false,
        redact: (text) => redactSecrets(text, []).value,
        redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
        async record(record) {
          records.push(record);
        },
      },
    });
    await assert.rejects(
      session.send('task', { signal: new AbortController().signal }),
      /status 1/,
    );
    assert.equal(records.at(-1)!.process?.exit_code, 1);
    assert.equal(records.at(-1)!.rejection?.code, 'process_nonzero_exit');
    assert.equal(records.at(-1)!.extraction_rejection?.code, 'turn_failed');
    assert.equal(records.at(-1)!.events.at(-1)?.http_status, 502);
    assert.equal(session.sessionId(), undefined);
  });

  it('never accepts a completed turn from a failed process', async () => {
    const records: AgentInvocationRecord[] = [];
    const f = fixture({ command: () => result(completed(), 7) });
    const session = await f.adapter.openSession({
      ...f.sessionContext,
      diagnostics: {
        restrictedExcerpts: false,
        redact: (text) => redactSecrets(text, []).value,
        redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
        async record(record) {
          records.push(record);
        },
      },
    });
    await assert.rejects(
      session.send('task', { signal: new AbortController().signal }),
      /status 7/,
    );
    assert.equal(records.at(-1)!.rejection?.code, 'process_nonzero_exit');
    assert.equal(records.at(-1)!.extraction_rejection, undefined);
    assert.equal(records.at(-1)!.last_completed_turn, 4);
  });

  it('records nonzero tool exits without failing a successful turn or changing its text', async () => {
    const tool = {
      type: 'item.completed',
      item: {
        id: 'tool',
        type: 'command_execution',
        command: 'private command',
        aggregated_output: 'private output',
        exit_code: 2,
        status: 'completed',
      },
    };
    const stdout = completed().split('\n');
    stdout.splice(2, 0, JSON.stringify(tool));
    const records: AgentInvocationRecord[] = [];
    const f = fixture({ command: () => result(stdout.join('\n')) });
    const session = await f.adapter.openSession({
      ...f.sessionContext,
      diagnostics: {
        restrictedExcerpts: true,
        redact: (text) => redactSecrets(text, []).value,
        redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
        async record(record, body) {
          assert.equal(body, undefined);
          records.push(record);
        },
      },
    });
    const turn = await session.send('task', {
      signal: new AbortController().signal,
    });
    assert.equal(turn.text, 'Done');
    assert.equal(records.at(-1)!.state, 'completed');
    assert.equal(records.at(-1)!.tool_failure_count, 1);
    assert.equal(records.at(-1)!.events[2]!.tool_exit_code, 2);
    assert.equal(JSON.stringify(records).includes('private'), false);
  });

  for (const code of [
    'command_timeout',
    'command_aborted',
    'command_output_limit',
    'command_start_failed',
  ] as const) {
    it(`keeps bounded partial capture for ${code}`, async () => {
      const stdout = [...prefix, '{malformed'].join('\n');
      const records: AgentInvocationRecord[] = [];
      let excerpt: RestrictedAgentExcerpts | undefined;
      const f = fixture({
        command: (call) => {
          for (const line of stdout.split('\n'))
            call.options.onStdoutLine?.(line);
          call.options.onStderrChunk?.('stderr secret-');
          call.options.onStderrChunk?.('value');
          throw new CommandExecutionError('Command failed.', code, {
            capture: {
              stdout,
              stderr: 'stderr secret-value',
              durationMs: 50,
              stdoutBytes: Buffer.byteLength(stdout),
              stderrBytes: 19,
              stdoutTruncated: code === 'command_output_limit',
              stderrTruncated: false,
              signal: 'SIGTERM',
            },
          });
        },
      });
      const session = await f.adapter.openSession({
        ...f.sessionContext,
        diagnostics: {
          restrictedExcerpts: true,
          redact: (text) => redactSecrets(text, ['secret-value']).value,
          redactedTail: (maximumBytes) =>
            createRedactedTail(['secret-value'], maximumBytes),
          async record(record, body) {
            records.push(record);
            excerpt = body;
          },
        },
      });
      await assert.rejects(
        session.send('task', { signal: new AbortController().signal }),
        { code },
      );
      const last = records.at(-1)!;
      assert.equal(last.process?.error_code, code);
      assert.equal(last.process?.signal, 'SIGTERM');
      assert.equal(last.extraction_rejection?.code, 'invalid_json');
      assert.equal(
        last.rejection?.code,
        code === 'command_output_limit' ? 'output_limit' : 'unknown',
      );
      assert.equal(excerpt?.stderr, 'stderr [REDACTED]');
      assert.equal(excerpt?.cli_events.includes('agent_exec'), true);
    });
  }

  it('ignores capture failures without changing successful output', async () => {
    const f = fixture();
    const session = await f.adapter.openSession({
      ...f.sessionContext,
      diagnostics: {
        restrictedExcerpts: false,
        redact: (text) => redactSecrets(text, []).value,
        redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
        async record() {
          throw new Error('storage failure');
        },
      },
    });
    assert.equal(
      (await session.send('task', { signal: new AbortController().signal }))
        .text,
      'Done',
    );
  });
});

it('records the typed command failure and capture gap for a custom runner without partial output', async () => {
  const records: AgentInvocationRecord[] = [];
  const f = fixture({
    command() {
      throw new CommandExecutionError('Timeout.', 'command_timeout');
    },
  });
  const session = await f.adapter.openSession({
    ...f.sessionContext,
    diagnostics: {
      restrictedExcerpts: false,
      redact: (text) => redactSecrets(text, []).value,
      redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
      async record(record) {
        records.push(record);
      },
    },
  });
  await assert.rejects(
    session.send('task', { signal: new AbortController().signal }),
    { code: 'command_timeout' },
  );
  assert.equal(records.at(-1)!.capture, 'unsupported');
  assert.deepEqual(records.at(-1)!.process, { error_code: 'command_timeout' });
});

it.each([
  { failure: 'command_timeout', ending: '' },
  { failure: 'command_timeout', ending: '\n' },
  { failure: 'command_aborted', ending: '' },
  { failure: 'command_aborted', ending: '\n' },
  { failure: 'nonzero_exit', ending: '' },
  { failure: 'nonzero_exit', ending: '\n' },
  { failure: 'command_start_failed', ending: '' },
] as const)(
  'keeps $failure with clean incomplete output unlocated (ending $ending)',
  async ({ failure, ending }) => {
    for (const callbacks of [false, true]) {
      const lines =
        failure === 'command_start_failed'
          ? []
          : completed().split('\n').slice(0, 2);
      const stdout = lines.join('\n') + ending;
      const records: AgentInvocationRecord[] = [];
      let body: RestrictedAgentExcerpts | undefined;
      const f = fixture({
        command(call) {
          if (callbacks)
            for (const line of lines) call.options.onStdoutLine?.(line);
          if (failure === 'nonzero_exit') return result(stdout, 1);
          throw new CommandExecutionError('Command failed.', failure, {
            capture: {
              stdout,
              stderr: '',
              durationMs: 1,
              stdoutBytes: Buffer.byteLength(stdout),
              stderrBytes: 0,
              stdoutTruncated: false,
              stderrTruncated: false,
            },
          });
        },
      });
      const session = await f.adapter.openSession({
        ...f.sessionContext,
        diagnostics: {
          restrictedExcerpts: true,
          redact: (text) => text,
          redactedTail: (maximumBytes) => createRedactedTail([], maximumBytes),
          async record(record, excerpts) {
            records.push(record);
            body = excerpts;
          },
        },
      });
      await assert.rejects(
        session.send('task', { signal: new AbortController().signal }),
      );
      const last = records.at(-1)!;
      assert.equal(last.state, 'failed');
      assert.equal(session.sessionId(), undefined);
      assert.equal(last.event_count, lines.length);
      assert.equal(last.events.length, lines.length);
      assert.equal(last.first_failure, undefined);
      assert.equal(last.extraction_rejection?.code, 'invalid_event_order');
      assert.equal(last.extraction_rejection?.line_index, undefined);
      assert.equal(JSON.parse(body!.cli_events).failure, null);
      if (failure === 'nonzero_exit') {
        assert.equal(last.process?.exit_code, 1);
        assert.equal(last.rejection?.code, 'process_nonzero_exit');
      } else {
        assert.equal(last.process?.error_code, failure);
        assert.equal(last.rejection?.code, 'unknown');
      }
    }
  },
);
