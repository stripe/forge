import {
  WEB_SEARCH_PLUGIN_PATH,
  WEB_SEARCH_PLUGIN_SHA256,
} from './webSearchPlugin.ts';

/** No prompt text enters argv or a shell. The runtime owns process-tree cancellation. */
export const OPENCODE_LAUNCHER = `
const { openSync, closeSync, existsSync, readFileSync, lstatSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
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
// The sole configured extension is Forge's pinned request transform, outside
// all discovery directories. Auth state and discovered extensions stay rejected.
try {
  const state = path.dirname(prompt);
  const plugin = path.join(state, '${WEB_SEARCH_PLUGIN_PATH}');
  const configs = [process.env.OPENCODE_CONFIG_CONTENT,
    existsSync(path.join(state, 'config.json')) ? readFileSync(path.join(state, 'config.json'), 'utf8') : undefined];
  for (const raw of configs) {
    if (raw === undefined) continue;
    const configured = JSON.parse(raw).plugin;
    if (configured === undefined) continue;
    if (!Array.isArray(configured) || configured.length !== 1 ||
        !Array.isArray(configured[0]) || configured[0].length !== 2 ||
        configured[0][0] !== pathToFileURL(plugin).href ||
        !configured[0][1] || Object.keys(configured[0][1]).length !== 1 ||
        !['native', 'exa'].includes(configured[0][1].engine) ||
        !lstatSync(plugin).isFile() ||
        createHash('sha256').update(readFileSync(plugin)).digest('hex') !== '${WEB_SEARCH_PLUGIN_SHA256}')
      throw new Error();
  }
} catch {
  process.stderr.write('OpenCode requires the exact Forge web search plugin.\\n');
  process.exit(1);
}
const fd = openSync(prompt, 'r');
const child = spawn(executable, args, { stdio: [fd, 'inherit', 'inherit'] });
closeSync(fd);
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
`;
