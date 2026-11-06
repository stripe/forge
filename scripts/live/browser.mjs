import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const assetRoot = fileURLToPath(new URL('./browser/', import.meta.url));
export const BROWSER_POC_PINS = Object.freeze({
  playwright_mcp: '0.0.84',
  playwright: '1.65.0-alpha-2026-10-30',
  claude_code: '2.1.273',
  codex: '0.149.0',
});

/** Environment smoke test; no model calls or changes to Forge's public schema. */
export async function runBrowserIntegrationSuite({
  dockerExecutable,
  resultsRoot,
  suiteId,
  signal,
  progress,
  browserBuildProxy,
  browserBuildNetwork = 'default',
}) {
  assert.ok(
    ['default', 'host'].includes(browserBuildNetwork),
    'Browser build network must be default or host',
  );
  const proxyArguments =
    browserBuildProxy === undefined
      ? []
      : buildProxyArguments(browserBuildProxy);
  const name = `stripe-forge-browser-${randomUUID()}`;
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const outputRoot = path.join(resultsRoot, `${suiteId}-browser`);
  await fs.mkdir(resultsRoot, { recursive: true });
  // Do not overwrite the evidence of an earlier attempt.
  await fs.mkdir(outputRoot, { mode: 0o700 });
  const evidenceRoot = path.join(outputRoot, 'evidence');
  await fs.mkdir(evidenceRoot, { mode: 0o700 });
  const assets = await Promise.all(
    [
      'Dockerfile',
      'server.mjs',
      'probe.mjs',
      'package.json',
      'package-lock.json',
    ].map(async (name) =>
      Buffer.concat([
        Buffer.from(`${name}\0`),
        await fs.readFile(path.join(assetRoot, name)),
        Buffer.from('\0'),
      ]),
    ),
  );
  const assetDigest = `sha256:${createHash('sha256').update(Buffer.concat(assets)).digest('hex')}`;
  const docker = async (args, commandSignal = signal) => {
    const result = await exec(dockerExecutable, args, {
      signal: commandSignal,
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout.trim();
  };
  let allocated = false;
  let imageId;
  let report;
  try {
    progress('building the opt-in Chromium/Playwright MCP development image');
    imageId = await docker([
      'build',
      '--quiet',
      '--network',
      browserBuildNetwork,
      ...proxyArguments,
      assetRoot,
    ]);
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    progress(
      'starting an isolated browser and local fixture with external networking disabled',
    );
    await docker([
      'run',
      '--detach',
      '--name',
      name,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '4g',
      '--cpus',
      '2',
      '--pids-limit',
      '512',
      '--shm-size',
      '256m',
      '--tmpfs',
      '/tmp:rw,size=1g,mode=1777',
      '--tmpfs',
      '/home/forge:rw,size=128m,mode=1777',
      '--user',
      `${process.getuid?.() ?? 10001}:10001`,
      '--mount',
      `type=bind,source=${evidenceRoot},target=/evidence`,
      imageId,
    ]);
    allocated = true;
    // Readiness probes run inside the container; no host ports or credentials.
    await docker([
      'exec',
      name,
      'node',
      '-e',
      `
      const signal = AbortSignal.timeout(30000);
      while (!signal.aborted) {
        try {
          const response = await fetch('http://127.0.0.1:8931/mcp', {signal});
          if (response.status < 500) process.exit(0);
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      process.exit(1);
    `,
    ]);
    progress(
      'checking native MCP registration, tools, reconnect state, and retained screenshot',
    );
    await docker(['exec', name, 'node', '/opt/browser/probe.mjs', suiteId]);
    const probe = JSON.parse(
      await fs.readFile(path.join(evidenceRoot, 'probe.json'), 'utf8'),
    );
    assert.equal(probe.run_id, suiteId);
    assert.deepEqual(probe.pins, BROWSER_POC_PINS);
    await verifyBrowserEvidence(evidenceRoot, probe);
    report = {
      verified: true,
      model_calls: 0,
      run_id: suiteId,
      provider: 'local',
      controller: 'playwright-mcp',
      pins: BROWSER_POC_PINS,
      image_id: imageId,
      asset_sha256: assetDigest,
      network: 'none',
      build_network: browserBuildNetwork,
      build_proxy_configured: browserBuildProxy !== undefined,
      evidence_location: evidenceRoot,
      registrations: probe.registrations,
      reconnect_state_preserved: probe.reconnect_state_preserved,
      artifacts: probe.artifacts,
    };
  } finally {
    // Allocation may have succeeded even if the Docker client was interrupted.
    const cleanupSignal = AbortSignal.timeout(30_000);
    const existing = await docker(
      ['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'],
      cleanupSignal,
    );
    if (allocated || existing)
      await docker(['rm', '--force', name], cleanupSignal);
    assert.equal(
      await docker(
        ['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'],
        cleanupSignal,
      ),
      '',
      'Browser PoC container leaked',
    );
  }
  await fs.writeFile(
    path.join(outputRoot, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  return report;
}

/** Verify the exact retained inventory, without trusting paths or claimed hashes. */
export async function verifyBrowserEvidence(root, probe) {
  assert.equal(probe.model_calls, 0);
  assert.deepEqual(probe.registrations, { claude_code: true, codex: true });
  assert.equal(probe.reconnect_state_preserved, true);
  assert.deepEqual(probe.artifacts.map(({ path }) => path).sort(), [
    'actions.json',
    'screenshot.png',
  ]);
  for (const artifact of probe.artifacts) {
    const filename = path.join(root, artifact.path);
    const stat = await fs.lstat(filename);
    assert.ok(stat.isFile(), 'Evidence must be a regular file');
    assert.ok(
      stat.size <= (artifact.path === 'screenshot.png' ? 4 : 2) * 1024 * 1024,
      'Evidence exceeds the PoC budget',
    );
    const bytes = await fs.readFile(filename);
    if (artifact.path === 'screenshot.png') {
      assert.equal(artifact.media_type, 'image/png');
      assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
    } else assert.equal(artifact.media_type, 'application/json');
    assert.equal(bytes.length, artifact.size_bytes);
    assert.equal(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      artifact.sha256,
    );
    await fs.chmod(filename, 0o600);
  }
}

/** Docker's predefined proxy build args are not persisted as image ENV settings. */
export function buildProxyArguments(value) {
  const proxy = new URL(value);
  assert.ok(
    ['http:', 'https:'].includes(proxy.protocol) &&
      !proxy.username &&
      !proxy.password &&
      !proxy.search &&
      !proxy.hash &&
      proxy.pathname === '/',
    'Build proxy must be a credential-free HTTP(S) origin',
  );
  return ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].flatMap(
    (name) => ['--build-arg', `${name}=${proxy.origin}`],
  );
}
