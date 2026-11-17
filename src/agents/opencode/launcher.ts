/** No prompt text enters argv or a shell. The runtime owns process-tree cancellation. */
export const OPENCODE_LAUNCHER = `
const { openSync, closeSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const [prompt, executable, ...args] = process.argv.slice(1);
// Project config is disabled, but the pinned CLI still loads these global sources.
// Refuse implicit configuration rather than deep-merging it into the recorded model.
const globalRoot = process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'opencode');
const extra = globalRoot ? ['config', 'config.json', 'opencode.json', 'opencode.jsonc',
  'agent', 'agents', 'mode', 'modes', 'command', 'commands', 'plugin', 'plugins', 'skill', 'skills', 'AGENTS.md']
  .map(name => path.join(globalRoot, name)) : [];
if (process.env.HOME) extra.push(path.join(process.env.HOME, '.opencode'));
if (process.env.XDG_DATA_HOME) extra.push(path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'));
if (extra.some(file => existsSync(file))) {
  process.stderr.write('OpenCode implicit global configuration is unsupported. Use the experiment agent selection and forge/plugin.\\n');
  process.exit(1);
}
const fd = openSync(prompt, 'r');
const child = spawn(executable, args, { stdio: [fd, 'inherit', 'inherit'] });
closeSync(fd);
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
`;

/** Native stdout goes to an owned regular file, outside runtime output capture. */
export const OPENCODE_EXPORT_LAUNCHER = `
const { openSync, closeSync, fstatSync, unlinkSync, constants } = require('node:fs');
const { spawn } = require('node:child_process');
const [destination, maxBytes, executable, session] = process.argv.slice(1);
const partial = destination + '.partial';
const fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
if (!fstatSync(fd).isFile()) { closeSync(fd); process.exit(1); }
// POSIX shells count 512-byte blocks; some shells use 1024-byte blocks.
// The process can write at most twice maxBytes; eligibility keeps the exact cap.
const blocks = Math.floor(Number(maxBytes) / 512);
const child = spawn('sh', ['-c', 'ulimit -f "$1" || exit 1; shift; exec "$@"',
  'forge-opencode-export', String(blocks), executable, 'export', session],
  { stdio: ['ignore', fd, 'inherit'] });
child.on('error', () => { process.exitCode = 1; });
child.on('close', (code) => {
  const eligible = code === 0 && fstatSync(fd).size <= Number(maxBytes);
  closeSync(fd);
  if (!eligible) { unlinkSync(partial); process.exitCode = 1; }
});
`;
