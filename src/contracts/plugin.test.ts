import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { parseAgentPluginInstallationReceipt } from './pluginReceipt.ts';

const RECEIPT = {
  adapter: 'claude-code',
  plugin: 'stripe@claude-plugins-official',
  marketplace: 'anthropics/claude-plugins-official',
  marketplace_commit: 'a'.repeat(40),
  native_plugin_id: 'stripe@forge-test',
  version: '0.9.2',
  source: { kind: 'git-subdir', commit: 'b'.repeat(40) },
  installed_tree: {
    format: 'forge-plugin-tree-v1',
    sha256: `sha256:${'c'.repeat(64)}`,
    entry_count: 2,
    file_count: 1,
    size_bytes: 42,
  },
} as const;

describe('plugin installation receipts', () => {
  it('strictly snapshots a complete public resolution', () => {
    const input = structuredClone(RECEIPT);
    const parsed = parseAgentPluginInstallationReceipt(input);

    assert.deepEqual(parsed, RECEIPT);
    assert.notEqual(parsed, input);
    assert.notEqual(parsed.source, input.source);
    assert.notEqual(parsed.installed_tree, input.installed_tree);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.source));
    assert.ok(Object.isFrozen(parsed.installed_tree));
    Object.assign(input.source, { kind: 'archive' });
    Object.assign(input.installed_tree, { size_bytes: 99 });
    assert.deepEqual(parsed, RECEIPT);
  });

  it('round-trips the optional Codex MCP relocation record and requires its parts together', () => {
    const relocated = {
      ...RECEIPT,
      adapter: 'codex',
      mcp_configuration: 'codex-user-config',
      mcp_connections: [
        { name: 'stripe', url: 'https://mcp.stripe.com/v1' },
        { name: 'zeta', url: 'http://localhost:8080' },
      ],
    };
    const parsed = parseAgentPluginInstallationReceipt(
      JSON.parse(JSON.stringify(relocated)),
    );
    assert.deepEqual(parsed, relocated);
    assert.ok(Object.isFrozen(parsed.mcp_connections));
    // Old receipts carry neither field and still read.
    const old = parseAgentPluginInstallationReceipt(RECEIPT);
    assert.equal(Object.hasOwn(old, 'mcp_configuration'), false);
    assert.equal(Object.hasOwn(old, 'mcp_connections'), false);

    const { mcp_connections, ...marker } = relocated;
    const { mcp_configuration, ...connections } = relocated;
    const stripe = { name: 'stripe', url: 'https://mcp.stripe.com' };
    for (const bad of [
      marker,
      connections,
      { ...relocated, mcp_configuration: 'codex-global' },
      { ...relocated, mcp_configuration: undefined },
      { ...relocated, mcp_connections: [] },
      { ...relocated, mcp_connections: {} },
      { ...relocated, mcp_connections: Array(17).fill(stripe) },
      { ...relocated, mcp_connections: [stripe, stripe] },
      {
        ...relocated,
        mcp_connections: [
          { name: 'zeta', url: stripe.url },
          { name: 'stripe', url: stripe.url },
        ],
      },
      { ...relocated, mcp_connections: [{ ...stripe, extra: true }] },
      {
        ...relocated,
        mcp_connections: [{ name: 'Bad Name', url: stripe.url }],
      },
      { ...relocated, mcp_connections: new Array(1) },
      {
        ...relocated,
        mcp_connections: Object.assign([stripe], { extra: true }),
      },
      {
        ...relocated,
        mcp_connections: Object.assign([stripe], { [Symbol('extra')]: true }),
      },
      ...[
        'https://mcp.stripe.com?api_key=synthetic-secret',
        'https://mcp.stripe.com#synthetic-secret',
        'https://user:synthetic-secret@mcp.stripe.com',
        'ftp://mcp.stripe.com',
        'not a url',
      ].map((url) => ({
        ...relocated,
        mcp_connections: [{ name: 'stripe', url }],
      })),
    ])
      assert.throws(() => parseAgentPluginInstallationReceipt(bad));
  });

  it('preserves neutral and exact historical shapes without rewriting', () => {
    const { native_plugin_id: _id, ...base } = RECEIPT;
    const historicalBundle = {
      ...base,
      adapter: 'custom-opencode',
      installation: 'opencode-bundle',
      source: {
        kind: 'git-subdir',
        commit: 'b'.repeat(40),
        path: 'providers/claude/plugin',
      },
    };
    for (const receipt of [
      RECEIPT,
      { ...RECEIPT, installation: 'native' },
      {
        ...RECEIPT,
        installation: 'native',
        mcp_configuration: 'codex-user-config',
        mcp_connections: [{ name: 'stripe', url: 'https://mcp.stripe.com' }],
      },
      historicalBundle,
      {
        ...historicalBundle,
        installation: 'bundle',
        source: { ...historicalBundle.source, path: 'other/bundle' },
      },
    ]) {
      const input = JSON.parse(JSON.stringify(receipt));
      const parsed = parseAgentPluginInstallationReceipt(input);
      assert.deepEqual(parsed, receipt);
      assert.deepEqual(parseAgentPluginInstallationReceipt(parsed), parsed);
      assert.notEqual(parsed.source, input.source);
      assert.ok(Object.isFrozen(parsed));
      assert.ok(Object.isFrozen(parsed.source));
      assert.ok(Object.isFrozen(parsed.installed_tree));
    }
    assert.throws(() =>
      parseAgentPluginInstallationReceipt({
        ...historicalBundle,
        source: { ...historicalBundle.source, path: 'other/bundle' },
      }),
    );
  });

  it('rejects unknown discriminators, mixed identities and unsafe bundle paths', () => {
    const { native_plugin_id: _id, ...base } = RECEIPT;
    const bundle = {
      ...base,
      installation: 'bundle',
      source: {
        kind: 'git-subdir',
        commit: 'b'.repeat(40),
        path: 'some/plugin',
      },
    };
    for (const malformed of [
      { ...RECEIPT, installation: undefined },
      { ...RECEIPT, installation: 'unknown' },
      { ...base, installation: 'native' },
      { ...bundle, native_plugin_id: RECEIPT.native_plugin_id },
      { ...bundle, adapter_details: {} },
      {
        ...bundle,
        mcp_configuration: 'codex-user-config',
        mcp_connections: [{ name: 'stripe', url: 'https://mcp.stripe.com' }],
      },
      { ...bundle, source: { kind: 'archive' } },
      { ...bundle, source: { ...bundle.source, commit: undefined } },
      { ...bundle, source: { ...bundle.source, extra: true } },
      { ...RECEIPT, installation: 'native', source: bundle.source },
      ...[
        '',
        '.',
        '..',
        '../plugin',
        '/plugin',
        'C:/plugin',
        'a\\b',
        'a//b',
        'a/./b',
        'a/../b',
        'a/',
        'a\n',
        'é'.repeat(128),
        Array(17).fill('a'.repeat(250)).join('/'),
      ].map((path) => ({ ...bundle, source: { ...bundle.source, path } })),
    ])
      assert.throws(() => parseAgentPluginInstallationReceipt(malformed));
    assert.equal(
      parseAgentPluginInstallationReceipt({
        ...bundle,
        source: { ...bundle.source, path: 'é'.repeat(127) },
      }).source.path,
      'é'.repeat(127),
    );
  });

  it('accepts each supported source kind when no source commit is reported', () => {
    for (const kind of [
      'marketplace-path',
      'archive',
      'github',
      'url',
      'git-subdir',
    ]) {
      assert.deepEqual(
        parseAgentPluginInstallationReceipt({
          ...RECEIPT,
          source: { kind },
        }).source,
        { kind },
      );
    }
  });

  it('preserves an observed full Git commit for each Git source kind', () => {
    for (const kind of ['github', 'url', 'git-subdir']) {
      const source = { kind, commit: 'd'.repeat(40) };
      assert.deepEqual(
        parseAgentPluginInstallationReceipt({ ...RECEIPT, source }).source,
        source,
      );
    }
  });

  it('rejects malformed observed commits and unsupported source metadata', () => {
    for (const input of [
      { ...RECEIPT, unexpected: true },
      { ...RECEIPT, marketplace_commit: 'a'.repeat(39) },
      { ...RECEIPT, marketplace_commit: 'A'.repeat(40) },
      { ...RECEIPT, marketplace_commit: undefined },
      { ...RECEIPT, installed_tree: {} },
      { ...RECEIPT, source: { kind: 'git-subdir', commit: 'not-a-commit' } },
      { ...RECEIPT, source: { kind: 'git-subdir', commit: 'B'.repeat(40) } },
      {
        ...RECEIPT,
        source: { kind: 'marketplace-path', commit: 'b'.repeat(40) },
      },
      { ...RECEIPT, source: { kind: 'archive', commit: 'b'.repeat(40) } },
      {
        ...RECEIPT,
        source: { kind: 'archive', sha256: `sha256:${'c'.repeat(64)}` },
      },
      { ...RECEIPT, source: { kind: 'unsupported' } },
      { ...RECEIPT, source: {} },
      { ...RECEIPT, version: undefined },
    ]) {
      assert.throws(() => parseAgentPluginInstallationReceipt(input));
    }
  });

  it('requires a strict, bounded installed-tree fingerprint description', () => {
    for (const installed_tree of [
      { ...RECEIPT.installed_tree, format: 'unsupported' },
      { ...RECEIPT.installed_tree, sha256: 'invalid' },
      { ...RECEIPT.installed_tree, entry_count: 0 },
      { ...RECEIPT.installed_tree, file_count: 0 },
      { ...RECEIPT.installed_tree, file_count: 3 },
      { ...RECEIPT.installed_tree, size_bytes: -1 },
      { ...RECEIPT.installed_tree, entry_count: 1.5 },
      { ...RECEIPT.installed_tree, entry_count: Number.MAX_SAFE_INTEGER + 1 },
      { ...RECEIPT.installed_tree, file_count: Number.POSITIVE_INFINITY },
      { ...RECEIPT.installed_tree, size_bytes: Number.NaN },
      { ...RECEIPT.installed_tree, size_bytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...RECEIPT.installed_tree, extra: true },
    ]) {
      assert.throws(() =>
        parseAgentPluginInstallationReceipt({ ...RECEIPT, installed_tree }),
      );
    }
    assert.equal(
      parseAgentPluginInstallationReceipt({
        ...RECEIPT,
        installed_tree: { ...RECEIPT.installed_tree, size_bytes: 0 },
      }).installed_tree.size_bytes,
      0,
    );
  });

  it('rejects missing or unsafe plugin provenance identities', () => {
    for (const [field, value] of [
      ['adapter', '../adapter'],
      ['plugin', 'unqualified'],
      ['plugin', 'plugin@marketplace@extra'],
      ['plugin', '../plugin@marketplace'],
      ['native_plugin_id', 'plugin@../marketplace'],
      ['marketplace', 'https://github.com/owner/repository'],
      ['marketplace', 'owner/repository/extra'],
      ['version', 'release\n'],
    ] as const) {
      assert.throws(() =>
        parseAgentPluginInstallationReceipt({ ...RECEIPT, [field]: value }),
      );
    }
    for (const field of [
      'adapter',
      'plugin',
      'marketplace',
      'native_plugin_id',
      'source',
      'installed_tree',
    ]) {
      const input: Record<string, unknown> = { ...RECEIPT };
      delete input[field];
      assert.throws(() => parseAgentPluginInstallationReceipt(input));
    }
  });

  it('accepts explicit null-prototype records and rejects hidden, symbol, and inherited fields', () => {
    assert.deepEqual(
      parseAgentPluginInstallationReceipt(
        Object.assign(Object.create(null), RECEIPT, {
          source: Object.assign(Object.create(null), RECEIPT.source),
          installed_tree: Object.assign(
            Object.create(null),
            RECEIPT.installed_tree,
          ),
        }),
      ),
      RECEIPT,
    );
    for (const makeMalformed of [
      (input: object) =>
        Object.defineProperty(input, 'hidden', { value: true }),
      (input: object) => Object.assign(input, { [Symbol('extra')]: true }),
      (input: object) => Object.create(input),
    ]) {
      assert.throws(() =>
        parseAgentPluginInstallationReceipt(makeMalformed({ ...RECEIPT })),
      );
      assert.throws(() =>
        parseAgentPluginInstallationReceipt({
          ...RECEIPT,
          source: makeMalformed({ ...RECEIPT.source }),
        }),
      );
      assert.throws(() =>
        parseAgentPluginInstallationReceipt({
          ...RECEIPT,
          installed_tree: makeMalformed({ ...RECEIPT.installed_tree }),
        }),
      );
    }
  });
});
