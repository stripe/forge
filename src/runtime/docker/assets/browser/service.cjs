#!/usr/bin/env node
// Provider-owned Chromium and a separate MCP controller, confined to the eval container.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const state = '/home/forge/.forge-browser';
const ready = path.join(state, 'ready');
const pidFile = path.join(state, 'pid');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const mode = process.argv[2];
  if (mode === 'start') {
    const log = fs.openSync(path.join(state, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [__filename, 'serve'], {
      detached: true, stdio: ['ignore', log, log],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/forge',
        TMPDIR: '/tmp', PLAYWRIGHT_BROWSERS_PATH: '/opt/forge-browsers' },
    });
    fs.closeSync(log);
    child.unref();
    for (let i = 0; i < 500; i++) {
      if (fs.existsSync(ready)) return;
      await delay(100);
    }
    throw new Error('Browser startup timed out.');
  }
  if (mode === 'stop') {
    if (!fs.existsSync(pidFile)) return;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid browser PID.');
    try { process.kill(pid, 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    for (let i = 0; i < 50; i++) {
      if (!fs.existsSync(ready)) return;
      await delay(100);
    }
    throw new Error('Browser shutdown timed out.');
  }
  if (mode !== 'serve') throw new Error('Expected start, stop, or serve.');
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const { chromium } = require('playwright');
  const browser = await chromium.launchPersistentContext('/tmp/forge-browser-profile', {
    headless: true, viewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222'],
  });
  fs.mkdirSync(path.join(state, 'captures'), { recursive: true });
  const controller = spawn(process.execPath, [
    path.join(__dirname, 'node_modules/@playwright/mcp/cli.js'),
    '--host', '127.0.0.1', '--port', '8931', '--headless', '--no-sandbox',
    '--no-webmcp', '--shared-browser-context', '--viewport-size', '1280x720',
    '--cdp-endpoint', 'http://127.0.0.1:9222',
    '--output-dir', path.join(state, 'captures'),
  ], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    controller.kill('SIGTERM');
    await browser.close().catch(() => {});
    fs.rmSync(ready, { force: true });
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  controller.once('error', () => { void stop(); });
  controller.once('exit', () => { void stop(); });
  for (let i = 0; i < 300; i++) {
    try {
      const response = await fetch('http://127.0.0.1:8931/mcp', { signal: AbortSignal.timeout(1000) });
      if (response.status < 500) {
        fs.writeFileSync(ready, 'ready\n', { mode: 0o600 });
        return;
      }
    } catch {}
    await delay(100);
  }
  await stop();
}
main().catch(() => { process.stderr.write('Browser service failed.\n'); process.exit(1); });
