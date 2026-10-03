import {spawn} from 'node:child_process';

export function runBoundedCommand(executable, argv, executionSignal) {
  return new Promise((resolve, reject) => {
    executionSignal.throwIfAborted();
    const child = spawn(executable, argv, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      executionSignal.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      reject(error);
    };
    const capture = (target, chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) {
        fail(new Error('The Docker bridge probe exceeded its output limit.'));
        return;
      }
      target.push(chunk);
    };
    const onAbort = () =>
      fail(
        executionSignal.reason instanceof Error
          ? executionSignal.reason
          : new Error('The Docker bridge probe was aborted.'),
      );
    executionSignal.addEventListener('abort', onAbort, {once: true});
    child.stdout.on('data', (chunk) => capture(stdout, chunk));
    child.stderr.on('data', (chunk) => capture(stderr, chunk));
    child.once('error', (error) => fail(error));
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      executionSignal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
}
