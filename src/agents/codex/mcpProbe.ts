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
const timer = setTimeout(() => finish(1), 80000);
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  child.kill('SIGKILL');
  process.exitCode = code;
}
child.on('error', () => finish(1));
child.on('exit', () => {if (!finished) finish(1);});
child.stdin.on('error', () => finish(1));
function send(message) {child.stdin.write(JSON.stringify(message) + '\\n');}
function listStatuses(cursor) {
  send({id: statusRequestId, method: 'mcpServerStatus/list', params: {detail: 'toolsAndAuthOnly', limit: 100, ...(cursor === undefined ? {} : {cursor})}});
}
send({id: 1, method: 'initialize', params: {clientInfo: {name: 'forge', version: '1'}, capabilities: {experimentalApi: true}}});
let bufferBytes = 0;
child.stdout.on('data', chunk => {bufferBytes += chunk.length; if (bufferBytes > 1024 * 1024) finish(1);});
createInterface({input: child.stdout}).on('line', line => {
  if (finished) return;
  try {
    const message = JSON.parse(line);
    if (message.error) {finish(1); return;}
    if (message.id === 1) {
      send({method: 'initialized', params: {}});
      listStatuses();
    }
    if (message.id === statusRequestId) {
      if (!Array.isArray(message.result?.data)) {finish(1); return;}
      rows.push(...message.result.data);
      if (rows.length > 10000) {finish(1); return;}
      const cursor = message.result.nextCursor;
      if (cursor !== null) {
        if (typeof cursor !== 'string' || cursor.length === 0 || cursors.has(cursor) || cursors.size >= 100) {finish(1); return;}
        cursors.add(cursor);
        statusRequestId += 1;
        listStatuses(cursor);
        return;
      }
      const valid = servers.every(name => {
        const matches = rows.filter(row => row.pluginId === pluginId && row.name === name);
        return matches.length === 1 && matches[0].serverInfo && matches[0].authStatus === 'bearerToken' && matches[0].tools && typeof matches[0].tools === 'object';
      });
      finish(valid ? 0 : 1);
    }
  } catch {finish(1);}
});
`.trim();
