#!/usr/bin/env node
// Provider-owned Chromium and a separate MCP controller, confined to the eval container.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const state = '/home/forge/.forge-browser';
const ready = path.join(state, 'ready');
const pidFile = path.join(state, 'pid');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let cleanup = async () => {};

async function main() {
  const mode = process.argv[2];
  if (mode === 'start') {
    fs.rmSync(ready, { force: true });
    const log = fs.openSync(path.join(state, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [__filename, 'serve'], {
      detached: true, stdio: ['ignore', log, log],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/forge',
        TMPDIR: '/tmp', PLAYWRIGHT_BROWSERS_PATH: '/opt/forge-browsers' },
    });
    fs.closeSync(log);
    child.unref();
    try {
      for (let i = 0; i < 500; i++) {
        if (fs.existsSync(ready)) {
          const receipt = JSON.parse(fs.readFileSync(ready, 'utf8'));
          if (receipt.pid !== child.pid) throw new Error('Unexpected browser owner.');
          process.stdout.write(receipt.url + '\n');
          return;
        }
        process.kill(child.pid, 0);
        await delay(100);
      }
      throw new Error('Browser startup timed out.');
    } catch (error) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      throw error;
    }
  }
  if (mode === 'stop') {
    if (!fs.existsSync(pidFile)) return;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid browser PID.');
    try { process.kill(pid, 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      fs.rmSync(ready, { force: true });
      return;
    }
    for (let i = 0; i < 100; i++) {
      if (!fs.existsSync(ready)) return;
      await delay(100);
    }
    throw new Error('Browser shutdown timed out.');
  }
  if (mode !== 'serve') throw new Error('Expected start, stop, or serve.');
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const profile = fs.mkdtempSync('/tmp/forge-browser-');
  let browser;
  let controller;
  let stopping;
  cleanup = () => stopping ??= (async () => {
    if (controller && controller.exitCode === null && controller.signalCode === null) {
      const exited = new Promise(resolve => controller.once('exit', resolve));
      controller.kill('SIGTERM');
      await exited;
    }
    await browser?.close();
    fs.rmSync(ready, { force: true });
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  })();
  const stop = () => { void cleanup().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const { chromium } = require('playwright');
  browser = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  });
  const [cdpPort] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
  if (!/^[1-9][0-9]{0,4}$/.test(cdpPort) || +cdpPort > 65535) throw new Error('Invalid CDP port.');
  fs.mkdirSync(path.join(state, 'captures'), { recursive: true });
  controller = spawn(process.execPath, [
    path.join(__dirname, 'node_modules/@playwright/mcp/cli.js'),
    '--host', '127.0.0.1', '--port', '0', '--headless', '--no-sandbox',
    '--no-webmcp', '--shared-browser-context', '--viewport-size', '1280x720',
    '--cdp-endpoint', `http://127.0.0.1:${cdpPort}`,
    '--output-dir', path.join(state, 'captures'),
  ], { env: process.env, stdio: ['ignore', 'inherit', 'pipe'] });
  // The pinned controller reports its OS-assigned listening address after binding.
  // Read our child's report, never probe a preselected port that another run could own.
  let output = '';
  controller.stderr.on('data', chunk => {
    process.stderr.write(chunk);
    output = (output + chunk.toString()).slice(-8192);
    const match = /Listening on (http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})[\r\n]/.exec(output);
    if (match && !stopping) {
      fs.writeFileSync(ready, JSON.stringify({ pid: process.pid, url: `${match[1]}/mcp` }), { mode: 0o600 });
    }
  });
  controller.once('error', () => { void cleanup().finally(() => process.exit(1)); });
  controller.once('exit', () => { if (!stopping) void cleanup().finally(() => process.exit(1)); });
}
main().catch(async () => {
  await cleanup().catch(() => {});
  process.stderr.write('Browser service failed.\n');
  process.exit(1);
});
