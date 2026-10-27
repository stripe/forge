export const CODEX_MCP_PROBE_EXIT = Object.freeze({
  success: 0,
  discoveryFailed: 1,
  serverUnavailable: 2,
  authenticationUnavailable: 3,
  toolsUnavailable: 4,
});

/** Pinned app-server protocol: no thread/turn creation, model or MCP tool calls. */
export const CODEX_MCP_PROBE_SCRIPT = `
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const [executable, pluginId, encodedServers] = process.argv.slice(1);
const servers = JSON.parse(encodedServers);
const child = spawn(executable, ['app-server'], {stdio: ['pipe', 'pipe', 'ignore']});
let finished = false;
let statusRequestId = 2;
const rows = [];
const cursors = new Set();
const timer = setTimeout(() => finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed}), 80000);
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  child.kill('SIGKILL');
  process.exitCode = code;
}
child.on('error', () => finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed}));
child.on('exit', () => {if (!finished) finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed});});
child.stdin.on('error', () => finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed}));
function send(message) {child.stdin.write(JSON.stringify(message) + '\\n');}
function listStatuses(cursor) {
  send({id: statusRequestId, method: 'mcpServerStatus/list', params: {detail: 'toolsAndAuthOnly', limit: 100, ...(cursor === undefined ? {} : {cursor})}});
}
send({id: 1, method: 'initialize', params: {clientInfo: {name: 'forge', version: '1'}, capabilities: {experimentalApi: true}}});
let bufferBytes = 0;
child.stdout.on('data', chunk => {bufferBytes += chunk.length; if (bufferBytes > 1024 * 1024) finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed});});
createInterface({input: child.stdout}).on('line', line => {
  if (finished) return;
  try {
    const message = JSON.parse(line);
    if (message.error) {finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed}); return;}
    if (message.id === 1) {
      send({method: 'initialized', params: {}});
      listStatuses();
    }
    if (message.id === statusRequestId) {
      if (!Array.isArray(message.result?.data)) {finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed}); return;}
      rows.push(...message.result.data);
      if (rows.length > 10000) {finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed}); return;}
      const cursor = message.result.nextCursor;
      if (cursor !== null) {
        if (typeof cursor !== 'string' || cursor.length === 0 || cursors.has(cursor) || cursors.size >= 100) {finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed}); return;}
        cursors.add(cursor);
        statusRequestId += 1;
        listStatuses(cursor);
        return;
      }
      for (const name of servers) {
        const matches = rows.filter(row => row.pluginId === pluginId && row.name === name);
        if (matches.length !== 1) {finish(${CODEX_MCP_PROBE_EXIT.serverUnavailable}); return;}
        const row = matches[0];
        if (row.authStatus !== 'bearerToken') {finish(${CODEX_MCP_PROBE_EXIT.authenticationUnavailable}); return;}
        if (!row.serverInfo) {finish(${CODEX_MCP_PROBE_EXIT.serverUnavailable}); return;}
        if (!row.tools || typeof row.tools !== 'object' || Array.isArray(row.tools) || Object.keys(row.tools).length === 0) {finish(${CODEX_MCP_PROBE_EXIT.toolsUnavailable}); return;}
      }
      finish(${CODEX_MCP_PROBE_EXIT.success});
    }
  } catch {finish(${CODEX_MCP_PROBE_EXIT.discoveryFailed});}
});
`.trim();
