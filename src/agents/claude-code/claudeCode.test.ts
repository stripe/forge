import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {expect} from '../../../test/support/expect.js';
import {parseAtifTrajectory} from '../../atif/index.js';
import {createMemoryWorkspace} from '../../testing/memoryWorkspace.js';
import {createMemoryRunInputProvider} from '../../testing/memoryInputs.js';
import {createTestResolvedRunPlan} from '../../testing/plans.js';

import {
  CLAUDE_PLUGIN_STATE_ID,
  CLAUDE_PROJECTS_STATE_ID,
  createClaudeCodeAdapter,
  loadClaudeEvidence,
  type ClaudeCodeLayout,
} from './index.js';
import {loadClaudeNativeArtifact} from './evidence.js';
import {parseClaudeStream} from './stream.js';

function hookSuccessRecord(context: string) {
  return {
    type: 'attachment',
    sessionId: 'session-1',
    attachment: {
      type: 'hook_success',
      command: 'example-hook',
      content: '',
      durationMs: 12,
      exitCode: 0,
      hookEvent: 'SessionStart',
      hookName: 'hook-command',
      stderr: '',
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      }),
      toolUseID: 'success-id',
    },
  };
}

function hookAdditionalContextRecord(context: string) {
  return {
    type: 'attachment',
    sessionId: 'session-1',
    attachment: {
      type: 'hook_additional_context',
      content: [context],
      hookEvent: 'SessionStart',
      hookName: 'context-renderer',
      toolUseID: 'context-id',
    },
    rendered: [{content: `<system-reminder>\n${context}\n</system-reminder>`}],
  };
}

describe('Claude Code adapter', () => {
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
    expect(adapter.version).toBe('2');
    const requirements = adapter.requirements({
      adapter: 'claude-code',
      provider: 'anthropic',
      model: 'claude-test',
    });
    expect(requirements.environment.credentials?.ANTHROPIC_API_KEY?.reference).toBe(
      'anthropic.api-key',
    );
    expect(requirements.stateDirectories).toEqual([
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
    expect(adapter.version).toBe('2+gateway');
    const requirements = adapter.requirements({
      adapter: 'claude-code',
      provider: 'anthropic-compatible',
      model: 'claude-test',
    });

    expect(requirements.environment).toEqual({
      variables: {
        ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
      },
      credentials: {
        ANTHROPIC_AUTH_TOKEN: {
          reference: 'gateway.routing-token',
        },
      },
    });
    expect(requirements.environment.credentials).not.toHaveProperty(
      'ANTHROPIC_API_KEY',
    );
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
      expect(() => createClaudeCodeAdapter({baseUrl})).toThrow(
        /baseUrl|base URL/,
      );
    });
  }

  it('accepts an HTTP loopback base URL', () => {
    expect(
      createClaudeCodeAdapter({baseUrl: 'http://127.0.0.1:23456'}).requirements({
        adapter: 'claude-code',
        provider: 'anthropic',
        model: 'claude-test',
      }).environment,
    ).toEqual({
      variables: {ANTHROPIC_BASE_URL: 'http://127.0.0.1:23456'},
      credentials: {
        ANTHROPIC_API_KEY: {
          reference: 'anthropic.api-key',
        },
      },
    });

  });

  it('rejects a credential binding that collides with the base URL variable', () => {
    expect(() =>
      createClaudeCodeAdapter({
        baseUrl: 'https://gateway.example.test',
        credentialEnvironmentName: 'ANTHROPIC_BASE_URL',
      }),
    ).toThrow(/different environment variables/);
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
      expect(argv[0]).toBe('claude');
      expect(argv.includes('--settings')).toBe(false);
      expect(argv.some((arg) => arg.startsWith('CLAUDE_CODE_'))).toBe(false);
    }
    expect(argvCalls[1]?.slice(1, 5)).toEqual(['-p', 'Continue', '--resume', 'session-1']);
  });

  it('returns unavailable native evidence without constructing fallback', async () => {
    const evidence = await loadClaudeEvidence({
      project: undefined,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    expect(evidence).toEqual({
      kind: 'unavailable',
      reason: {
        code: 'source_unavailable',
        message: 'The exact Claude session is unavailable.',
      },
    });
  });

  it('classifies a missing exact session file as unavailable', async () => {
    const evidence = await loadClaudeEvidence({
      project: createMemoryWorkspace().readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    expect(evidence).toEqual({
      kind: 'unavailable',
      reason: {
        code: 'source_unavailable',
        message: 'The exact Claude session is unavailable.',
      },
    });
  });

  it('captures only the exact selected Claude JSONL without transforming bytes', async () => {
    const raw =
      '{"type":"attachment","attachment":{"type":"environment","credential":"raw-secret"}}\n';
    const project = createMemoryWorkspace({
      'session-1.jsonl': raw,
      'session-2.jsonl': '{"type":"user","message":{"content":"other"}}\n',
    });

    const artifact = await loadClaudeNativeArtifact({
      project: project.readonly,
      sessionId: 'session-1',
      signal: new AbortController().signal,
    });

    expect(artifact).toMatchObject({
      format: 'claude-code-jsonl',
      sessionId: 'session-1',
      mediaType: 'application/x-ndjson',
      extension: 'jsonl',
    });
    expect(Buffer.from(artifact?.body ?? []).toString('utf8')).toBe(raw);
  });

  it('classifies malformed native JSONL as invalid', async () => {
    const evidence = await loadClaudeEvidence({
      project: createMemoryWorkspace({
        'session-1.jsonl': '{"type":"user"}\nnot-json',
      }).readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    expect(evidence).toEqual({
      kind: 'unavailable',
      reason: {
        code: 'source_invalid',
        message: 'Claude session evidence could not be normalized safely.',
      },
    });
  });

  for (const {description, marker} of [
    {
      description: 'compact summary flag',
      marker: {type: 'summary', isCompactSummary: true},
    },
    {
      description: 'compact boundary subtype',
      marker: {type: 'system', subtype: 'compact_boundary'},
    },
  ]) {
    it(`classifies the ${description} as incomplete native evidence`, async () => {
      const project = createMemoryWorkspace({
        'session-1.jsonl': [
          JSON.stringify(marker),
          JSON.stringify({
            type: 'user',
            sessionId: 'session-1',
            message: {content: 'Do the task'},
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 'session-1',
            message: {content: 'Done'},
          }),
        ].join('\n'),
      });

      const evidence = await loadClaudeEvidence({
        project: project.readonly,
        sessionId: 'session-1',
        agentVersion: '2.1.273',
        model: 'claude-test',
        signal: new AbortController().signal,
      });

      expect(evidence).toEqual({
        kind: 'unavailable',
        reason: {
          code: 'source_incomplete',
          message: 'Claude session evidence could not be normalized safely.',
        },
      });
    });
  }

  it('classifies an unknown root conversation record as incomplete', async () => {
    const project = createMemoryWorkspace({
      'session-1.jsonl': [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: {content: 'Do the task'},
        }),
        '',
        JSON.stringify({type: 'future-conversation-record'}),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {content: 'Done'},
        }),
      ].join('\n'),
    });

    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    expect(evidence).toEqual({
      kind: 'unavailable',
      reason: {
        code: 'source_incomplete',
        message: 'Claude session evidence could not be normalized safely (unrecognized record at line 3).',
      },
    });
  });

  for (const {description, records} of [
    {
      description: 'user',
      records: [
        {
          type: 'user',
          sessionId: 'session-1',
          message: {content: [{type: 'future-user-block'}]},
        },
        {
          type: 'assistant',
          sessionId: 'session-1',
          message: {content: 'Done'},
        },
      ],
    },
    {
      description: 'assistant',
      records: [
        {
          type: 'user',
          sessionId: 'session-1',
          message: {content: 'Do the task'},
        },
        {
          type: 'assistant',
          sessionId: 'session-1',
          message: {content: [{type: 'future-assistant-block'}]},
        },
      ],
    },
  ]) {
    it(`classifies an unknown ${description} content block as incomplete`, async () => {
      const project = createMemoryWorkspace({
        'session-1.jsonl': records.map((record) => JSON.stringify(record)).join('\n'),
      });

      const evidence = await loadClaudeEvidence({
        project: project.readonly,
        sessionId: 'session-1',
        agentVersion: '2.1.273',
        model: 'claude-test',
        signal: new AbortController().signal,
      });

      expect(evidence).toEqual({
        kind: 'unavailable',
        reason: {
          code: 'source_incomplete',
          message: 'Claude session evidence could not be normalized safely.',
        },
      });
    });
  }

  it('accepts explicitly supported metadata records without adding steps', async () => {
    const metadataTypes = [
      'agent-name',
      'ai-title',
      'custom-title',
      'file-history-snapshot',
      'last-prompt',
      'mode',
      'permission-mode',
      'pr-link',
      'queue-operation',
      'summary',
    ];
    const project = createMemoryWorkspace({
      'session-1.jsonl': [
        ...metadataTypes.map((type) => JSON.stringify({type})),
        JSON.stringify({type: 'atis-latch', atis: '', sessionId: 'session-1'}),
        JSON.stringify({type: 'system', subtype: 'stop_hook_summary'}),
        JSON.stringify({type: 'system', subtype: 'turn_duration'}),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: {content: 'Do the task'},
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {content: 'Done'},
        }),
      ].join('\n'),
    });

    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    expect(trajectory.steps.map(({source, message}) => ({source, message}))).toEqual([
      {source: 'user', message: 'Do the task'},
      {source: 'agent', message: 'Done'},
    ]);
    expect(evidence.warnings).toEqual([]);
  });

  it('maps rendered Claude attachments to ATIF system steps', async () => {
    const rendered =
      '<system-reminder>\n# Environment\nPrimary working directory: /workspace\n</system-reminder>';
    const project = createMemoryWorkspace({
      'session-1.jsonl': [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: {content: 'Do the task'},
        }),
        JSON.stringify({
          type: 'attachment',
          sessionId: 'session-1',
          timestamp: '2026-09-17T16:02:51.921Z',
          attachment: {
            type: 'environment',
            snapshot: {workingDirectory: '/workspace'},
          },
          rendered: [{content: rendered}],
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {content: 'Done'},
        }),
      ].join('\n'),
    });

    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    expect(
      trajectory.steps.map(({step_id, source, message}) => ({
        step_id,
        source,
        message,
      })),
    ).toEqual([
      {step_id: 1, source: 'user', message: 'Do the task'},
      {
        step_id: 2,
        source: 'system',
        message: rendered,
      },
      {step_id: 3, source: 'agent', message: 'Done'},
    ]);
    expect(trajectory.steps[1]).toMatchObject({
      timestamp: '2026-09-17T16:02:51.921Z',
      extra: {
        native_record_type: 'attachment',
        attachment_type: 'environment',
      },
    });
    expect(evidence.warnings).toEqual([]);
  });

  it('accepts a hook success only when its context is in the next rendered attachment', async () => {
    const context = 'Use the installed plugin for this task.';
    const project = createMemoryWorkspace({
      'session-1.jsonl': [
        hookSuccessRecord(context),
        hookAdditionalContextRecord(context),
        {type: 'user', sessionId: 'session-1', message: {content: 'Do the task'}},
        {type: 'assistant', sessionId: 'session-1', message: {content: 'Done'}},
      ].map((record) => JSON.stringify(record)).join('\n'),
    });

    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    expect(parseAtifTrajectory(evidence.trajectory).steps.map(({source, message}) => ({
      source,
      message,
    }))).toEqual([
      {source: 'system', message: `<system-reminder>\n${context}\n</system-reminder>`},
      {source: 'user', message: 'Do the task'},
      {source: 'agent', message: 'Done'},
    ]);
    expect(evidence.warnings).toEqual([]);
  });

  for (const {description, hookRecords} of [
    {
      description: 'missing context attachment',
      hookRecords: [hookSuccessRecord('plugin context')],
    },
    {
      description: 'nonmatching context attachment',
      hookRecords: [
        hookSuccessRecord('plugin context'),
        hookAdditionalContextRecord('different context'),
      ],
    },
    {
      description: 'unrendered context attachment',
      hookRecords: [
        hookSuccessRecord('plugin context'),
        {...hookAdditionalContextRecord('plugin context'), rendered: []},
      ],
    },
    {
      description: 'intervening metadata record',
      hookRecords: [
        hookSuccessRecord('plugin context'),
        {type: 'summary'},
        hookAdditionalContextRecord('plugin context'),
      ],
    },
    {
      description: 'new hook-success payload field',
      hookRecords: [
        {
          ...hookSuccessRecord('plugin context'),
          attachment: {
            ...hookSuccessRecord('plugin context').attachment,
            futureContent: 'unrepresented context',
          },
        },
        hookAdditionalContextRecord('plugin context'),
      ],
    },
    {
      description: 'nonempty hook-success stderr',
      hookRecords: [
        {
          ...hookSuccessRecord('plugin context'),
          attachment: {
            ...hookSuccessRecord('plugin context').attachment,
            stderr: 'unrepresented error',
          },
        },
        hookAdditionalContextRecord('plugin context'),
      ],
    },
  ]) {
    it(`reports incomplete native evidence for ${description}`, async () => {
      const project = createMemoryWorkspace({
        'session-1.jsonl': [
          ...hookRecords,
          {type: 'user', sessionId: 'session-1', message: {content: 'Do the task'}},
          {type: 'assistant', sessionId: 'session-1', message: {content: 'Done'}},
        ].map((record) => JSON.stringify(record)).join('\n'),
      });

      const evidence = await loadClaudeEvidence({
        project: project.readonly,
        sessionId: 'session-1',
        agentVersion: '2.1.273',
        model: 'claude-test',
        signal: new AbortController().signal,
      });

      expect(evidence).toEqual({
        kind: 'unavailable',
        reason: {
          code: 'source_incomplete',
          message: 'Claude session evidence could not be normalized safely (attachment/hook_success at line 1).',
        },
      });
    });
  }

  it('drops empty session context and retains prompt snapshots as partial native detail', async () => {
    const project = createMemoryWorkspace({
      'session-1.jsonl': [
        JSON.stringify({
          type: 'attachment',
          attachment: {type: 'session_context', context: {}},
        }),
        JSON.stringify({
          type: 'attachment',
          attachment: {
            type: 'prompt_snapshot',
            systemPrompt: ['System prompt'],
          },
        }),
        JSON.stringify({
          type: 'attachment',
          attachment: {
            type: 'prompt_snapshot',
            systemPrompt: ['System prompt'],
            cliPrefix: 'CLI prefix',
            tools: [{name: 'Read'}],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: {content: 'Do the task'},
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {content: 'Done'},
        }),
      ].join('\n'),
    });

    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    expect(evidence.warnings).toEqual([
      {
        code: 'unsupported_native_event',
        message: 'Claude prompt snapshot detail was retained only in native evidence.',
        path: 'line:2',
      },
      {
        code: 'unsupported_native_event',
        message: 'Claude prompt snapshot detail was retained only in native evidence.',
        path: 'line:3',
      },
    ]);
  });

  it('marks known Claude attachment context as omitted optional detail', async () => {
    const project = createMemoryWorkspace({
      'session-1.jsonl': [
        JSON.stringify({
          type: 'attachment',
          attachment: {type: 'nested_memory'},
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: {content: 'Do the task'},
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {content: 'Done'},
        }),
      ].join('\n'),
    });

    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    expect(evidence.warnings).toEqual([
      {
        code: 'unsupported_native_event',
        message: 'Known Claude attachment context was omitted from ATIF.',
        path: 'line:1',
      },
    ]);
  });

  for (const {description, record, diagnosticKind} of [
    {
      description: 'queued command attachment',
      diagnosticKind: 'attachment/queued_command',
      record: {
        type: 'attachment',
        attachment: {type: 'queued_command'},
        rendered: [{content: 'Queued user command'}],
      },
    },
    {
      description: 'malformed rendered attachment',
      diagnosticKind: 'attachment',
      record: {
        type: 'attachment',
        attachment: {type: 'environment'},
        rendered: [{content: 42}],
      },
    },
    {
      description: 'nonempty session context attachment',
      diagnosticKind: 'attachment/session_context',
      record: {
        type: 'attachment',
        attachment: {type: 'session_context', context: {mode: 'future'}},
      },
    },
    {
      description: 'malformed prompt snapshot attachment',
      diagnosticKind: 'attachment/prompt_snapshot',
      record: {
        type: 'attachment',
        attachment: {type: 'prompt_snapshot', systemPrompt: 'not-an-array'},
      },
    },
    {
      description: 'unclassified unrendered attachment',
      diagnosticKind: 'attachment',
      record: {
        type: 'attachment',
        attachment: {type: 'future_attachment', content: 'unknown content'},
      },
    },
    {
      description: 'nonempty ATIS latch',
      diagnosticKind: 'atis-latch',
      record: {type: 'atis-latch', atis: 'future-state', sessionId: 'session-1'},
    },
    {
      description: 'conversation-bearing system event',
      diagnosticKind: 'system',
      record: {type: 'system', subtype: 'local_command'},
    },
    {
      description: 'unclassified progress event',
      diagnosticKind: 'unrecognized record',
      record: {type: 'progress'},
    },
  ]) {
    it(`classifies a ${description} as incomplete`, async () => {
      const project = createMemoryWorkspace({
        'session-1.jsonl': [
          JSON.stringify(record),
          JSON.stringify({
            type: 'user',
            sessionId: 'session-1',
            message: {content: 'Do the task'},
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 'session-1',
            message: {content: 'Done'},
          }),
        ].join('\n'),
      });

      const evidence = await loadClaudeEvidence({
        project: project.readonly,
        sessionId: 'session-1',
        agentVersion: '2.1.273',
        model: 'claude-test',
        signal: new AbortController().signal,
      });

      expect(evidence).toEqual({
        kind: 'unavailable',
        reason: {
          code: 'source_incomplete',
          message: `Claude session evidence could not be normalized safely (${diagnosticKind} at line 1).`,
        },
      });
    });
  }

  it('ignores meta user records before validating their conversation blocks', async () => {
    const project = createMemoryWorkspace({
      'session-1.jsonl': [
        JSON.stringify({
          type: 'user',
          isMeta: true,
          sessionId: 'session-1',
          message: {content: [{type: 'future-meta-block'}]},
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: {content: 'Do the task'},
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {content: 'Done'},
        }),
      ].join('\n'),
    });

    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    expect(trajectory.steps.map(({source, message}) => ({source, message}))).toEqual([
      {source: 'user', message: 'Do the task'},
      {source: 'agent', message: 'Done'},
    ]);
    expect(evidence.warnings).toEqual([]);
  });

  it('classifies sidechain records as incomplete primary-session evidence', async () => {
    const project = createMemoryWorkspace({
      'session-1.jsonl': JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        sessionId: 'session-1',
        message: {content: 'Subagent response'},
      }),
    });

    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    expect(evidence).toEqual({
      kind: 'unavailable',
      reason: {
        code: 'source_incomplete',
        message: 'Claude session evidence could not be normalized safely.',
      },
    });
  });

  it('preserves multiple tool-result records on their preceding agent step', async () => {
    const project = createMemoryWorkspace({
      'session-1.jsonl': [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: {content: 'Do the task'},
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {
            content: [
              {type: 'thinking', thinking: 'Use both tools.'},
              {type: 'tool_use', id: 'call-1', name: 'Read', input: {path: 'a.txt'}},
              {type: 'tool_use', id: 'call-2', name: 'Write', input: {path: 'b.txt'}},
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'unrelated-call',
                name: 'Edit',
                input: {path: 'unrelated.txt'},
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          isMeta: true,
          sessionId: 'session-1',
          message: {
            content: [
              {type: 'tool_result', tool_use_id: 'call-1', content: 'read output'},
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-2',
                content: 'write output',
                is_error: true,
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          message: {content: 'Done'},
        }),
      ].join('\n'),
    });

    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    const toolStep = trajectory.steps[1];
    expect(toolStep?.source).toBe('agent');
    assert.ok(toolStep?.source === 'agent');
    assert.equal(toolStep.reasoning_content, 'Use both tools.');
    assert.deepEqual(toolStep.tool_calls, [
      {tool_call_id: 'call-1', function_name: 'Read', arguments: {path: 'a.txt'}},
      {tool_call_id: 'call-2', function_name: 'Write', arguments: {path: 'b.txt'}},
    ]);
    assert.equal(trajectory.session_id, 'session-1');
    expect(toolStep?.observation?.results).toEqual([
      {source_call_id: 'call-1', content: 'read output'},
      {
        source_call_id: 'call-2',
        content: 'write output',
        extra: {is_error: true},
      },
    ]);
    expect(trajectory.steps[2]?.observation).toBeUndefined();
    expect(trajectory.steps[3]?.message).toBe('Done');
    expect(evidence.warnings).toEqual([]);
  });

  it('omits impossible native timestamps without discarding the session', async () => {
    const project = createMemoryWorkspace({
      'session-1.jsonl': [
        JSON.stringify({
          type: 'user',
          timestamp: '2025-02-30T00:00:00Z',
          sessionId: 'session-1',
          message: {content: 'Do the task'},
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2025-03-01T00:00:00Z',
          sessionId: 'session-1',
          message: {content: 'Done'},
        }),
      ].join('\n'),
    });
    const evidence = await loadClaudeEvidence({
      project: project.readonly,
      sessionId: 'session-1',
      agentVersion: '2.1.273',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    if (evidence.kind !== 'available') {
      throw new Error('Expected available Claude evidence.');
    }
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    expect(trajectory.steps[0]?.timestamp).toBeUndefined();
    expect(trajectory.steps[1]?.timestamp).toBe(
      '2025-03-01T00:00:00Z',
    );
    expect(evidence.warnings).toEqual([
      {
        code: 'value_omitted',
        message: 'An invalid Claude timestamp was omitted.',
        path: 'line:1',
      },
    ]);
  });

  it('parses terminal stream evidence without exposing raw noise', () => {
    const output = [
      'not-json',
      JSON.stringify({
        type: 'assistant',
        message: {content: [{type: 'tool_use', id: 'call-1', name: 'Write', input: {file: 'x'}}]},
      }),
      JSON.stringify({
        type: 'result',
        result: 'done',
        session_id: 'session-1',
        total_cost_usd: 0.01,
      }),
    ].join('\n');
    expect(parseClaudeStream(output)).toEqual({
      text: 'done',
      sessionId: 'session-1',
      toolCalls: [{id: 'call-1', name: 'Write', input: {file: 'x'}}],
      costUsd: 0.01,
    });
  });
});
