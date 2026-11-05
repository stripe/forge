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
