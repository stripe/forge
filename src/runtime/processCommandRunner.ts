import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CommandResult } from '../contracts/command.js';
import { CommandExecutionError } from '../contracts/command.js';

export interface HostCommandOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly onStdoutLine?: (line: string) => void;
}

export interface HostCommandRunner {
  run(
    argv: readonly string[],
    options: HostCommandOptions,
  ): Promise<CommandResult>;
}

/** Plain subprocess runner used for Docker CLI invocations. Never uses a shell. */
export function createHostCommandRunner(): HostCommandRunner {
  return {
    run(argv, options) {
      validateArgv(argv);
      positive(options.timeoutMs, 'timeoutMs');
      positive(options.maxOutputBytes, 'maxOutputBytes');
      options.signal?.throwIfAborted();

      return new Promise<CommandResult>((resolve, reject) => {
        const startedAt = Date.now();
        const child = spawn(argv[0]!, argv.slice(1), {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: { ...process.env, ...options.environment },
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let lineBuffer = '';
        const stdoutDecoder = new StringDecoder('utf8');
        let failure: CommandExecutionError | undefined;
        let finished = false;

        const terminate = (error: CommandExecutionError): void => {
          if (failure) return;
          failure = error;
          killProcessTree(child.pid, 'SIGTERM');
          setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 250).unref();
        };
        const capture = (
          target: Buffer[],
          chunk: Buffer,
          stdoutChunk: boolean,
        ): void => {
          outputBytes += chunk.byteLength;
          if (outputBytes > options.maxOutputBytes) {
            terminate(
              new CommandExecutionError(
                'Command exceeded its output limit.',
                'command_output_limit',
              ),
            );
            return;
          }
          target.push(chunk);
          if (stdoutChunk && options.onStdoutLine) {
            lineBuffer += stdoutDecoder.write(chunk);
            const lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop() ?? '';
            for (const line of lines) options.onStdoutLine(line);
          }
        };

        child.stdout.on('data', (chunk: Buffer) =>
          capture(stdout, chunk, true),
        );
        child.stderr.on('data', (chunk: Buffer) =>
          capture(stderr, chunk, false),
        );
        child.once('error', (cause) => {
          terminate(
            new CommandExecutionError(
              'Command could not be started.',
              'command_start_failed',
              { cause },
            ),
          );
        });

        const timer = setTimeout(
          () =>
            terminate(
              new CommandExecutionError(
                'Command timed out.',
                'command_timeout',
              ),
            ),
          options.timeoutMs,
        );
        timer.unref();
        const abort = (): void =>
          terminate(
            new CommandExecutionError(
              'Command was aborted.',
              'command_aborted',
              {
                cause: options.signal?.reason,
              },
            ),
          );
        options.signal?.addEventListener('abort', abort, { once: true });

        child.once('close', (exitCode, signal) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          if (options.onStdoutLine) {
            lineBuffer += stdoutDecoder.end();
            if (lineBuffer) options.onStdoutLine(lineBuffer);
          }
          if (failure) {
            reject(failure);
            return;
          }
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode: exitCode ?? (signal ? 128 : 1),
            durationMs: Date.now() - startedAt,
          });
        });
      });
    },
  };
}

function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error as NodeJS.ErrnoException).code !== 'ESRCH'
    ) {
      // The close/error event remains authoritative. A failed best-effort kill
      // must not throw from an abort listener or timer callback.
    }
  }
}

function validateArgv(argv: readonly string[]): void {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some(
      (argument) => typeof argument !== 'string' || argument.includes('\0'),
    )
  ) {
    throw new TypeError('Command argv must contain non-NUL strings.');
  }
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}
