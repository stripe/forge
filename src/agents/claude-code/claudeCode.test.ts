import {describe, it} from 'node:test';

import {expect} from '../../../test/support/expect.js';
import {createMemoryWorkspace} from '../../testing/memoryWorkspace.js';

import {createClaudeCodeAdapter, loadClaudeEvidence} from './index.js';
import {parseClaudeStream} from './stream.js';

describe('Claude Code adapter', () => {
  it('declares authentication and exact session state for engine-assigned scope', () => {
    const adapter = createClaudeCodeAdapter({sessionIdFactory: () => 'session-1'});
    expect(adapter.version).toBe('1');
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
    expect(adapter.version).toBe('1+gateway');
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

  it('accepts an HTTP loopback base URL without changing direct defaults', () => {
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

    expect(
      createClaudeCodeAdapter().requirements({
        adapter: 'claude-code',
        provider: 'anthropic',
        model: 'claude-test',
      }).environment,
    ).toEqual({
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

  it('records a configured adapter identity and gateway variant in evidence', async () => {
    const evidence = await loadClaudeEvidence({
      project: undefined,
      sessionId: 'session-1',
      fallbackTurns: [
        {user: 'Do the task', assistant: 'Done', toolCalls: []},
      ],
      agentVersion: '2.1.273',
      adapterId: 'claude-code-gateway',
      adapterVersion: '1+gateway',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    expect(evidence.provenance.adapter).toEqual({
      id: 'claude-code-gateway',
      version: '1+gateway',
    });
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
      fallbackTurns: [
        {user: 'Do the task', assistant: 'Fallback', toolCalls: []},
      ],
      agentVersion: '2.1.273',
      adapterId: 'claude-code',
      adapterVersion: '1',
      model: 'claude-test',
      signal: new AbortController().signal,
    });

    expect(evidence.completeness).toBe('partial');
    expect(evidence.trajectory.steps[0]?.timestamp).toBeUndefined();
    expect(evidence.trajectory.steps[1]?.timestamp).toBe(
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
