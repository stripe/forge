import { assertBoundedJsonValue } from '../../atif/parser.ts';

export const MAX_NATIVE_BYTES = 16 * 1024 * 1024;
export const OPENCODE_FORMAT = 'opencode-session-json';
export const EXPORT_PATH = 'session.json';
export type NativeRecord = Record<string, unknown>;

/** Safe diagnostics never interpolate native payloads or provider errors. */
export class OpenCodeNativeError extends Error {
  constructor(readonly incomplete = false) {
    super('OpenCode returned invalid or unsupported session data.');
  }
}

export function parseJson(text: string, maxBytes = MAX_NATIVE_BYTES): unknown {
  if (Buffer.byteLength(text) > maxBytes) throw new OpenCodeNativeError(true);
  const value: unknown = JSON.parse(text);
  assertBoundedJsonValue(value);
  return value;
}

export function record(value: unknown): NativeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new OpenCodeNativeError();
  return value as NativeRecord;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new OpenCodeNativeError();
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== 'string') throw new OpenCodeNativeError();
  return value;
}

export function identifier(value: unknown): string {
  const id = string(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes('..'))
    throw new OpenCodeNativeError();
  return id;
}

/** Gateway call IDs are opaque data, never filesystem path components. */
export function opaqueId(value: unknown): string {
  const id = string(value);
  if (
    !id.length ||
    id.length > 4_096 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(id)
  )
    throw new OpenCodeNativeError();
  return id;
}

export function sessionId(value: unknown): string {
  const id = identifier(value);
  if (!id.startsWith('ses_')) throw new OpenCodeNativeError();
  return id;
}

export function nonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new OpenCodeNativeError();
  return value;
}

export function terminal(reason: unknown): boolean {
  if (reason === 'tool-calls') return false;
  if (reason === 'stop' || reason === 'length') return true;
  throw new OpenCodeNativeError(true);
}

export function tool(part: NativeRecord) {
  const state = record(part.state);
  if (state.status !== 'completed' && state.status !== 'error')
    throw new OpenCodeNativeError(true);
  opaqueId(part.callID);
  return {
    // A gateway can reuse callID across retries or turns. OpenCode's part ID
    // identifies the execution in both the driver ledger and normalized ATIF.
    id: identifier(part.id),
    name: identifier(part.tool),
    input: record(state.input),
  };
}
