import type { CommandRunner } from '../../contracts/command.ts';
import type {
  MutableWorkspace,
  ReadonlyWorkspace,
} from '../../contracts/runtime.ts';
import {
  EXPORT_PATH,
  MAX_NATIVE_BYTES,
  OpenCodeNativeError,
  parseJson,
  record,
  sessionId,
} from './native.ts';

const EXPORT_ATTEMPTS = 2;
const EXPORT_TIMEOUT_MS = 30_000;
const MAX_EXPORT_DIAGNOSTIC_BYTES = 64 * 1024;

/** Give the CLI a regular stdout file so exiting cannot discard pipe buffers. */
export const OPENCODE_EXPORT_LAUNCHER = `
const { openSync, closeSync, fstatSync, constants } = require('node:fs');
const { spawn } = require('node:child_process');
const [output, executable, ...args] = process.argv.slice(1);
const fd = openSync(output, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK);
if (!fstatSync(fd).isFile()) { closeSync(fd); process.exit(1); }
const child = spawn(executable, args, { stdio: ['ignore', fd, 'inherit'] });
closeSync(fd);
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
`;

export class OpenCodeExportParseError extends Error {
  constructor(
    readonly truncated: boolean,
    readonly byteCount: number,
  ) {
    super('OpenCode session export could not be parsed.');
  }
}

export async function readOpenCodeExport(input: {
  readonly state: ReadonlyWorkspace | undefined;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  if (!input.state) return undefined;
  sessionId(input.sessionId);
  const entry = await input.state.inspect(EXPORT_PATH);
  if (entry.kind === 'absent' || entry.size === 0) return undefined;
  if (entry.kind !== 'file' || (entry.size ?? 0) > MAX_NATIVE_BYTES)
    throw new OpenCodeNativeError();
  const body = await input.state.readFile(EXPORT_PATH, {
    maxBytes: MAX_NATIVE_BYTES,
  });
  input.signal.throwIfAborted();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try {
    text = decoder.decode(body, { stream: true });
  } catch {
    throw new OpenCodeExportParseError(false, body.byteLength);
  }
  try {
    decoder.decode();
  } catch {
    throw new OpenCodeExportParseError(true, body.byteLength);
  }
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Node's JSON parser reports EOF either directly or at the input length.
    const position = /at position (\d+)/.exec(error.message)?.[1];
    throw new OpenCodeExportParseError(
      /Unexpected end of JSON input|Unterminated string in JSON/.test(
        error.message,
      ) ||
        (position !== undefined && Number(position) === text.length),
      body.byteLength,
    );
  }
  const value = record(parsed);
  if (record(value.info).id !== input.sessionId)
    throw new OpenCodeNativeError();
  return { body, value };
}

/** Capture while commands are allowed; sealed evidence collection only reads. */
export async function captureOpenCodeExport(input: {
  readonly state: MutableWorkspace;
  readonly commands: CommandRunner;
  readonly stateDirectory: string;
  readonly executable: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  try {
    for (let attempt = 0; attempt < EXPORT_ATTEMPTS; attempt++) {
      input.signal.throwIfAborted();
      await input.state.writeFile(EXPORT_PATH, new Uint8Array(), {
        mode: 0o600,
      });
      const exported = await input.commands.run(
        [
          'node',
          '-e',
          OPENCODE_EXPORT_LAUNCHER,
          `${input.stateDirectory}/${EXPORT_PATH}`,
          input.executable,
          'export',
          input.sessionId,
        ],
        {
          cwd: '.',
          signal: input.signal,
          timeoutMs: EXPORT_TIMEOUT_MS,
          maxOutputBytes: MAX_EXPORT_DIAGNOSTIC_BYTES,
        },
      );
      input.signal.throwIfAborted();
      if (exported.exitCode !== 0) throw new OpenCodeNativeError();
      try {
        const captured = await readOpenCodeExport(input);
        if (captured) return;
      } catch (error) {
        input.signal.throwIfAborted();
        if (!(error instanceof OpenCodeExportParseError)) return;
      }
    }
  } catch {
    input.signal.throwIfAborted();
    await input.state
      .writeFile(EXPORT_PATH, new Uint8Array(), { mode: 0o600 })
      .catch(() => undefined);
  }
}
