import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { FORGE_VERSION } from '../../version.ts';
import { type ClaudeCodeLayout, createClaudeCodeAdapter } from './index.ts';

const layout: ClaudeCodeLayout = {
  workspace: '/tmp/run/workspace',
  home: '/tmp/run/home',
  configDirectory: '/tmp/run/session',
};
const selection = {
  adapter: 'claude-code',
  provider: 'anthropic',
  model: 'claude-test',
};

describe('Claude runtime layout', () => {
  it('preserves default behavior when the Docker layout is supplied explicitly', () => {
    const adapter = createClaudeCodeAdapter({
      layout: {
        workspace: '/workspace',
        home: '/home/forge',
        configDirectory: '/home/forge/.claude',
      },
    });
    assert.equal(adapter.version, FORGE_VERSION);
    assert.deepEqual(adapter.metadata, {
      endpoint_mode: 'default',
      layout_mode: 'default',
    });
    assert.equal(
      adapter.requirements(selection).environment.variables,
      undefined,
    );
  });

  it('uses the runtime home default when no separate configuration directory is needed', () => {
    const adapter = createClaudeCodeAdapter({
      layout: {
        ...layout,
        configDirectory: `${layout.home}/.claude`,
      },
    });
    assert.equal(
      adapter.requirements(selection).environment.variables,
      undefined,
    );
    assert.equal(
      adapter.requirements(selection).stateDirectories[0]?.containerPath,
      '/tmp/run/home/.claude/projects/-tmp-run-workspace',
    );
  });

  it('matches the pinned Claude encoding for punctuation, Unicode, and long workspace paths', () => {
    for (const [workspace, project] of [
      ['/tmp/run_123/project.name', '-tmp-run-123-project-name'],
      ['/tmp/项目/space name', '-tmp----space-name'],
      [`/tmp/${'a'.repeat(210)}`, `-tmp-${'a'.repeat(195)}-de6m7t`],
    ]) {
      assert.equal(
        createClaudeCodeAdapter({
          layout: { ...layout, workspace: workspace! },
        }).requirements(selection).stateDirectories[0]?.containerPath,
        `${layout.configDirectory}/projects/${project}`,
      );
    }
  });

  it('rejects noncanonical, overlapping, and malformed layouts before preflight', () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...layout, extra: '/unexpected' },
      ...[
        'relative',
        '/',
        '/tmp/../workspace',
        '/tmp//workspace',
        '/tmp/workspace/',
        '/tmp/work\u0000space',
        '/tmp/work\nspace',
        '/tmp/work\\space',
        `/tmp/${'x'.repeat(4_096)}`,
      ].map((workspace) => ({ ...layout, workspace })),
      { ...layout, home: layout.workspace },
      { ...layout, home: '/tmp/run/workspace/home' },
      { ...layout, configDirectory: '/tmp/run/workspace/config' },
      { ...layout, configDirectory: '/tmp/run' },
      { ...layout, configDirectory: layout.home },
    ];
    for (const candidate of invalid) {
      assert.throws(
        () =>
          createClaudeCodeAdapter({ layout: candidate as ClaudeCodeLayout }),
        /Claude layout/,
      );
    }
  });

  it('rejects a credential that could redirect the Claude configuration directory', () => {
    assert.throws(
      () =>
        createClaudeCodeAdapter({
          layout,
          credentialEnvironmentName: 'CLAUDE_CONFIG_DIR',
        }),
      /configuration directory cannot be supplied as a credential/,
    );
  });
});
