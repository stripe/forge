/** No prompt text enters argv or a shell. The runtime owns process-tree cancellation. */
export const OPENCODE_LAUNCHER = `
const { openSync, closeSync } = require('node:fs');
const { spawn } = require('node:child_process');
const [prompt, executable, ...args] = process.argv.slice(1);
const fd = openSync(prompt, 'r');
const child = spawn(executable, args, { stdio: [fd, 'inherit', 'inherit'] });
closeSync(fd);
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
`;
