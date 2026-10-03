import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parseAtifTrajectory} from '../../atif/index.js';
import {createMemoryWorkspace} from '../../testing/memoryWorkspace.js';
import {createMemoryRunInputProvider} from '../../testing/memoryInputs.js';
import {createTestResolvedRunPlan} from '../../testing/plans.js';

import {
  CLAUDE_PLUGIN_STATE_ID,
  CLAUDE_PROJECTS_STATE_ID,
  createClaudeCodeAdapter,
  type ClaudeCodeLayout,
} from './index.js';

describe('Claude Code adapter', () => {
  it('rejects Codex hook policy even when registered with a custom adapter ID', () => {
    for (const id of ['claude-code', 'custom-claude']) {
      const adapter = createClaudeCodeAdapter({id});
      assert.throws(() => adapter.requirements({adapter: id, provider: 'anthropic', model: 'claude-test', hook_trust: 'native'}), /hook_trust is not supported/);
    }
  });

  const customLayout: ClaudeCodeLayout = {
    workspace: '/tmp/run_123/project.name',
    home: '/tmp/run_123/home',
    configDirectory: '/tmp/run_123/session',
  };

  it('snapshots a separate configuration root for setup, sessions, and native evidence', async () => {
    const layout = {...customLayout};
    const adapter = createClaudeCodeAdapter({layout, sessionIdFactory: () => 'session-1'});
    layout.workspace = '/changed/workspace';
    layout.configDirectory = '/changed/session';
    const plan = createTestResolvedRunPlan({
      agent: {adapter: 'claude-code', provider: 'anthropic', model: 'claude-test'},
    });
    assert.equal(adapter.version, '2+layout');
    assert.equal(createClaudeCodeAdapter({
      layout: customLayout, baseUrl: 'https://gateway.example.test',
    }).version, '2+gateway.layout');
    const requirements = adapter.requirements(plan.agent);
    assert.deepEqual(requirements.environment.variables, {
      CLAUDE_CONFIG_DIR: customLayout.configDirectory,
    });
    assert.deepEqual(requirements.stateDirectories, [{
      id: CLAUDE_PROJECTS_STATE_ID,
      containerPath: '/tmp/run_123/session/projects/-tmp-run-123-project-name',
    }]);
    assert.equal(adapter.pluginInstaller?.preflight({
      plugin: 'stripe@claude-plugins-official',
      marketplace: 'anthropics/claude-plugins-official',
    }, {selection: plan.agent, runtime: plan.runtime})
      .requirements.stateDirectories[0]?.containerPath, '/tmp/run_123/session/plugins');

    const calls: string[][] = [];
    const workspace = createMemoryWorkspace();
    const raw = ['First', 'Continue'].flatMap((prompt) => [
      {type: 'user', sessionId: 'session-1', message: {content: prompt}},
      {type: 'assistant', sessionId: 'session-1', message: {content: 'done'}},
    ]).map((record) => JSON.stringify(record)).join('\n');
    const state = createMemoryWorkspace({
      'session-1.jsonl': raw,
      'unrelated.jsonl': 'not the selected evidence',
    });
    const base = {
      runId: 'custom-layout',
      plan,
      selection: plan.agent,
      inputs: createMemoryRunInputProvider(),
      signal: new AbortController().signal,
    };
    const runtime = {
      runtimeId: base.runId,
      paths: customLayout,
      workspace: workspace.mutable,
      stateDirectories: new Map([[CLAUDE_PROJECTS_STATE_ID, state.mutable]]),
    };
    await adapter.prepare({...base, runtime: {...runtime, commands: {
      uncredentialed: {async run(argv) {
        calls.push([...argv]);
        return {exitCode: 0, stdout: '2.1.273 (Claude Code)', stderr: '', durationMs: 1};
      }},
    }}});
    const session = await adapter.openSession({...base, runtime: {...runtime, commands: {
      agent: {async run(argv) {
        calls.push([...argv]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({type: 'result', result: 'done', session_id: 'session-1'}),
          stderr: '', durationMs: 1,
        };
      }},
    }}});
    await session.send('First', {signal: base.signal});
    await session.send('Continue', {signal: base.signal});
    assert.deepEqual(calls[1]?.slice(0, 5), ['claude', '-p', 'First', '--session-id', 'session-1']);
    assert.deepEqual(calls[2]?.slice(0, 5), ['claude', '-p', 'Continue', '--resume', 'session-1']);
    const evidenceContext = {...base, sessionId: 'session-1', runtime: {
      ...runtime,
      workspace: workspace.readonly,
      stateDirectories: new Map([[CLAUDE_PROJECTS_STATE_ID, state.readonly]]),
      metadata: {},
    }};
    const evidence = await adapter.collectEvidence(evidenceContext);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind === 'available') {
      assert.equal(parseAtifTrajectory(evidence.trajectory).steps.length, 4);
    }
    const artifact = await adapter.collectNativeArtifact?.(evidenceContext);
    assert.equal(Buffer.from(artifact?.body ?? []).toString('utf8'), raw);
  });

  it('rejects a mismatched runtime layout before invoking commands or opening a session', async () => {
    const adapter = createClaudeCodeAdapter({layout: customLayout});
    const plan = createTestResolvedRunPlan({
      agent: {adapter: 'claude-code', provider: 'anthropic', model: 'claude-test'},
    });
    let calls = 0;
    const commands = {async run() {
      calls += 1;
      return {exitCode: 0, stdout: '2.1.273', stderr: '', durationMs: 1};
    }};
    for (const paths of [
      {...customLayout, home: '/other/home'},
      {...customLayout, workspace: '/other/workspace'},
    ]) {
      const context = {
        runId: 'wrong-layout', plan, selection: plan.agent,
        inputs: createMemoryRunInputProvider(), signal: new AbortController().signal,
        runtime: {
          runtimeId: 'wrong-layout', paths,
          workspace: createMemoryWorkspace().mutable,
          stateDirectories: new Map(),
          commands: {uncredentialed: commands, agent: commands},
        },
      };
      await assert.rejects(adapter.prepare(context), /do not match the declared layout/);
      await assert.rejects(adapter.openSession(context), /do not match the declared layout/);
    }
    assert.equal(calls, 0);
  });

  it('declares authentication and exact session state for engine-assigned scope', () => {
    const adapter = createClaudeCodeAdapter({sessionIdFactory: () => 'session-1'});
    assert.equal(adapter.version, '2');
    const requirements = adapter.requirements({
      adapter: 'claude-code',
      provider: 'anthropic',
      model: 'claude-test',
    });
    assert.equal(requirements.environment.credentials?.ANTHROPIC_API_KEY?.reference, 'anthropic.api-key');
    assert.deepEqual(requirements.stateDirectories, [
      {
        id: 'claude-projects',
        containerPath: '/home/forge/.claude/projects/-workspace',
      },
    ]);
  });

  it('declares a credential-free compatible endpoint and opaque auth token', () => {
    const adapter = createClaudeCodeAdapter({
      provider: 'anthropic-compatible',
      baseUrl: 'https://gateway.example.test/anthropic',
      credential: 'gateway.routing-token',
      credentialEnvironmentName: 'ANTHROPIC_AUTH_TOKEN',
    });
    assert.equal(adapter.version, '2+gateway');
    const requirements = adapter.requirements({
      adapter: 'claude-code',
      provider: 'anthropic-compatible',
      model: 'claude-test',
    });

    assert.deepEqual(requirements.environment, {
      variables: {
        ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
      },
      credentials: {
        ANTHROPIC_AUTH_TOKEN: {
          reference: 'gateway.routing-token',
        },
      },
    });
    assert.ok(!('ANTHROPIC_API_KEY' in (requirements.environment.credentials)));
  });

  for (const {description, baseUrl} of [
    {description: 'empty', baseUrl: ''},
    {description: 'relative', baseUrl: 'relative/path'},
    {description: 'unsupported protocol', baseUrl: 'ftp://gateway.example.test'},
    {
      description: 'embedded credentials',
      baseUrl: 'https://user:secret@gateway.example.test',
    },
    {
      description: 'query string',
      baseUrl: 'https://gateway.example.test?token=secret',
    },
    {
      description: 'fragment',
      baseUrl: 'https://gateway.example.test/#routing',
    },
    {
      description: 'control character',
      baseUrl: 'https://gateway.example.test/\nnext',
    },
    {
      description: 'overlong',
      baseUrl: `https://gateway.example.test/${'x'.repeat(4096)}`,
    },
  ]) {
    it(`rejects an unsafe Claude base URL (${description})`, () => {
      assert.throws(() => createClaudeCodeAdapter({baseUrl}), /baseUrl|base URL/);
    });
  }

  it('accepts an HTTP loopback base URL', () => {
    assert.deepEqual(createClaudeCodeAdapter({baseUrl: 'http://127.0.0.1:23456'}).requirements({
      adapter: 'claude-code',
      provider: 'anthropic',
      model: 'claude-test',
    }).environment, {
      variables: {ANTHROPIC_BASE_URL: 'http://127.0.0.1:23456'},
      credentials: {
        ANTHROPIC_API_KEY: {
          reference: 'anthropic.api-key',
        },
      },
    });

  });

  it('rejects a credential binding that collides with the base URL variable', () => {
    assert.throws(() =>
      createClaudeCodeAdapter({
        baseUrl: 'https://gateway.example.test',
        credentialEnvironmentName: 'ANTHROPIC_BASE_URL',
      }), /different environment variables/);
  });

  it('uses native writable plugin settings for initial and resumed sessions', async () => {
    const argvCalls: string[][] = [];
    const workspace = createMemoryWorkspace();
    const pluginState = createMemoryWorkspace();
    const plan = createTestResolvedRunPlan({
      agent: {
        adapter: 'claude-code',
        provider: 'anthropic',
        model: 'claude-test',
      },
    });
    const adapter = createClaudeCodeAdapter({
      sessionIdFactory: () => 'session-1',
    });
    const session = await adapter.openSession({
      runId: 'run-plugin-session',
      plan,
      selection: plan.agent,
      runtime: {
        runtimeId: 'run-plugin-session',
        workspace: workspace.mutable,
        paths: {workspace: '/workspace', home: '/home/forge'},
        stateDirectories: new Map([
          [CLAUDE_PLUGIN_STATE_ID, pluginState.mutable],
        ]),
        commands: {
          agent: {
            async run(argv) {
              argvCalls.push([...argv]);
              return {
                stdout: JSON.stringify({
                  type: 'result',
                  result: 'done',
                  session_id: 'session-1',
                }),
                stderr: '',
                exitCode: 0,
                durationMs: 1,
              };
            },
          },
        },
      },
      inputs: createMemoryRunInputProvider(),
      signal: new AbortController().signal,
    });
    await session.send('Do the work', {signal: new AbortController().signal});
    await session.send('Continue', {signal: new AbortController().signal});

    for (const argv of argvCalls) {
      assert.equal(argv[0], 'claude');
      assert.equal(argv.includes('--settings'), false);
      assert.equal(argv.some((arg) => arg.startsWith('CLAUDE_CODE_')), false);
    }
    assert.deepEqual(argvCalls[1]?.slice(1, 5), ['-p', 'Continue', '--resume', 'session-1']);
  });

});
