import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';

const { verifyBrowserEvidence, buildProxyArguments } = await import(
  pathToFileURL(path.join(process.cwd(), 'scripts/live/browser.mjs')).href
);
const { readLiveConfiguration } = await import(
  pathToFileURL(path.join(process.cwd(), 'scripts/live/configuration.mjs')).href
);

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'forge-browser-evidence-'),
  );
  const files = [
    {
      path: 'screenshot.png',
      media_type: 'image/png',
      body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    },
    {
      path: 'actions.json',
      media_type: 'application/json',
      body: Buffer.from('[]\n'),
    },
  ];
  for (const file of files)
    await fs.writeFile(path.join(root, file.path), file.body);
  const probe = {
    model_calls: 0,
    registrations: { claude_code: true, codex: true },
    reconnect_state_preserved: true,
    artifacts: files.map(({ path, media_type, body }) => ({
      path,
      media_type,
      size_bytes: body.length,
      sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    })),
  };
  return {
    root,
    probe,
    dispose: () => fs.rm(root, { recursive: true, force: true }),
  };
}

describe('devbox browser PoC boundary', () => {
  it('rejects credential-bearing or non-HTTP build proxies', () => {
    for (const value of [
      'http://user:secret@localhost:10071',
      'http://localhost:10071/?token=secret',
      'file:///tmp/proxy',
    ])
      assert.throws(() => buildProxyArguments(value));
    assert.ok(
      buildProxyArguments('http://localhost:10071').includes(
        'HTTPS_PROXY=http://localhost:10071',
      ),
    );
  });
  it('does not read model credentials or provider endpoints in browser mode', () => {
    const configuration = readLiveConfiguration(
      new Proxy(
        { FORGE_LIVE: '1', FORGE_LIVE_MODE: 'browser' } as Record<
          string,
          string
        >,
        {
          get(target, name: string) {
            assert.ok(
              !/API_KEY|AUTH_TOKEN|BASE_URL/.test(name),
              `Read ${name}`,
            );
            return target[name];
          },
        },
      ),
      process.cwd(),
    );
    assert.equal(configuration.mode, 'browser');
    assert.equal(configuration.upstreamCredential, undefined);
    assert.equal(configuration.gatewayBaseUrl, undefined);
  });

  it('checks retained bytes against their hashes and rejects modified evidence', async () => {
    const { root, probe, dispose } = await fixture();
    try {
      await verifyBrowserEvidence(root, probe);
      await fs.writeFile(path.join(root, 'actions.json'), '{}\n');
      await assert.rejects(verifyBrowserEvidence(root, probe));
    } finally {
      await dispose();
    }
  });

  it('rejects missing or redirected artifacts before reading other paths', async () => {
    const { root, probe, dispose } = await fixture();
    try {
      await assert.rejects(
        verifyBrowserEvidence(root, {
          ...probe,
          artifacts: probe.artifacts.slice(0, 1),
        }),
      );
      await assert.rejects(
        verifyBrowserEvidence(root, {
          ...probe,
          artifacts: [
            { ...probe.artifacts[0], path: '../screenshot.png' },
            probe.artifacts[1],
          ],
        }),
      );
      await fs.rename(
        path.join(root, 'screenshot.png'),
        path.join(root, 'other.png'),
      );
      await fs.symlink('other.png', path.join(root, 'screenshot.png'));
      await assert.rejects(verifyBrowserEvidence(root, probe), /regular file/);
    } finally {
      await dispose();
    }
  });
});
