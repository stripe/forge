import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from './node_modules/playwright/index.mjs';

const html = `<!doctype html><html lang="en"><head><title>Forge browser fixture</title></head>
<body><h1>Forge browser fixture</h1><label>Name <input aria-label="Name"></label>
<button onclick="document.querySelector('#result').textContent='Hello, '+document.querySelector('input').value">Greet</button>
<p id="result" role="status"></p></body></html>`;
const app = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve, reject) => {
  app.once('error', reject);
  app.listen(3030, '127.0.0.1', resolve);
});
// The provider owns Chromium independently of individual MCP client sessions.
const browser = await chromium.launchPersistentContext('/tmp/browser-profile', {
  headless: true,
  viewport: { width: 1280, height: 720 },
  args: ['--no-sandbox', '--remote-debugging-port=9222'],
});
const controller = spawn(
  process.execPath,
  [
    '/opt/browser/node_modules/@playwright/mcp/cli.js',
    '--host',
    '127.0.0.1',
    '--port',
    '8931',
    '--headless',
    '--no-sandbox',
    '--no-webmcp',
    '--shared-browser-context',
    '--viewport-size',
    '1280x720',
    '--cdp-endpoint',
    'http://127.0.0.1:9222',
    '--output-dir',
    '/evidence',
  ],
  {
    env: {
      PATH: process.env.PATH,
      HOME: '/home/forge',
      TMPDIR: '/tmp',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  app.close();
  void browser.close();
  controller.kill('SIGTERM');
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
controller.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  stop();
});
controller.once('exit', (code) => {
  app.close();
  void browser.close();
  process.exit(stopping ? 0 : code || 1);
});
