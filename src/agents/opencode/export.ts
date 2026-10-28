import {
  CommandExecutionError,
  type CommandRunner,
} from '../../contracts/command.ts';
import type {
  MutableWorkspace,
  ReadonlyWorkspace,
} from '../../contracts/runtime.ts';
import { NativeArtifactReadError } from '../nativeArtifactError.ts';
import { isJsonPrefix } from './jsonPrefix.ts';
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
const EXPORT_SIZE_CHECK_INTERVAL_MS = 10;
const EMPTY_EXPORT_PATH = 'session-export-empty.json';
const MAX_EMPTY_EXPORT_RECEIPT_BYTES = 512;

/** Give the CLI a regular stdout file so exiting cannot discard pipe buffers. */
export const OPENCODE_EXPORT_LAUNCHER = `
const { openSync, closeSync, fstatSync, unlinkSync, constants } = require('node:fs');
const { spawn } = require('node:child_process');
const [output, executable, ...args] = process.argv.slice(1);
const fd = openSync(output, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK);
if (!fstatSync(fd).isFile()) { closeSync(fd); process.exit(1); }
const child = spawn(executable, args, { stdio: ['ignore', fd, 'inherit'] });
let oversized = false;
const checkSize = () => {
  if (fstatSync(fd).size > ${MAX_NATIVE_BYTES}) {
    oversized = true;
    child.kill('SIGKILL');
  }
};
const monitor = setInterval(checkSize, ${EXPORT_SIZE_CHECK_INTERVAL_MS});
child.on('error', () => { process.exitCode = 1; });
child.on('close', (code) => {
  clearInterval(monitor);
  checkSize();
  closeSync(fd);
  if (oversized) unlinkSync(output);
  process.exitCode = oversized ? 1 : (code ?? 1);
});
`;

export class OpenCodeExportParseError extends Error {
  constructor(
    readonly truncated: boolean,
    readonly byteCount: number,
  ) {
    super('OpenCode session export could not be parsed.');
  }
}

export async function invalidateOpenCodeExport(state: MutableWorkspace) {
  for (const path of [EXPORT_PATH, EMPTY_EXPORT_PATH])
    await state.writeFile(path, new Uint8Array(), { mode: 0o600 });
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
  if (entry.kind === 'absent') return undefined;
  if (entry.kind === 'file' && entry.size === 0) {
    const receipt = await input.state.inspect(EMPTY_EXPORT_PATH);
    if (receipt.kind === 'absent' || receipt.size === 0) return undefined;
    const body = await input.state.readFile(EMPTY_EXPORT_PATH, {
      maxBytes: MAX_EMPTY_EXPORT_RECEIPT_BYTES,
    });
    input.signal.throwIfAborted();
    const value = record(
      parseJson(new TextDecoder('utf-8', { fatal: true }).decode(body)),
    );
    if (
      Object.keys(value).length !== 2 ||
      value.sessionId !== input.sessionId ||
      value.byteCount !== 0
    )
      throw new OpenCodeNativeError();
    throw new OpenCodeExportParseError(true, 0);
  }
  if (entry.kind !== 'file') throw new OpenCodeNativeError();
  if ((entry.size ?? 0) > MAX_NATIVE_BYTES)
    throw new NativeArtifactReadError('too_large');
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
    throw new OpenCodeExportParseError(
      isJsonPrefix(`${text}\uFFFD`),
      body.byteLength,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new OpenCodeExportParseError(isJsonPrefix(text), body.byteLength);
  }
  const value = record(parsed);
  if (record(value.info).id !== input.sessionId)
    throw new NativeArtifactReadError('identity_conflict');
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
    input.signal.throwIfAborted();
    await invalidateOpenCodeExport(input.state);
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
        if (attempt === EXPORT_ATTEMPTS - 1)
          await input.state.writeFile(
            EMPTY_EXPORT_PATH,
            Buffer.from(
              JSON.stringify({ sessionId: input.sessionId, byteCount: 0 }),
            ),
            { mode: 0o600 },
          );
      } catch (error) {
        input.signal.throwIfAborted();
        const entry = await input.state.inspect(EXPORT_PATH);
        if (entry.kind === 'file' && (entry.size ?? 0) > MAX_NATIVE_BYTES)
          throw error;
        if (!(error instanceof OpenCodeExportParseError)) return;
      }
    }
  } catch (error) {
    input.signal.throwIfAborted();
    await invalidateOpenCodeExport(input.state).catch(() => undefined);
    if (error instanceof CommandExecutionError) {
      if (error.code === 'command_output_limit')
        throw new NativeArtifactReadError('too_large');
      if (error.code === 'command_timeout')
        throw new NativeArtifactReadError('timed_out');
    }
    throw error;
  }
}
