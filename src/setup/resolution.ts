import type { JsonObject } from '../model/types.ts';
import { serializeCanonicalJson } from '../serialization.ts';

const MAX_SETUP_RESOLUTION_BYTES = 1024 * 1024;
const MAX_SETUP_RESOLUTION_DEPTH = 64;
const MAX_SETUP_RESOLUTION_NODES = 100_000;
const MAX_SETUP_RESOLUTION_COLLECTION_ENTRIES = 10_000;

export function normalizeSetupStepResolution(
  // biome-ignore lint/suspicious/noConfusingVoidType: Setup actions may complete without returning a resolution.
  input: JsonObject | void,
  uses: string,
): JsonObject | undefined {
  if (input === undefined) return undefined;
  if (!isPlainRecord(input)) {
    throw new TypeError(
      `Setup handler ${uses} returned an invalid resolution.`,
    );
  }
  assertBoundedPlainJson(input, uses);
  let serialized: string;
  try {
    serialized = serializeCanonicalJson(input);
  } catch (error) {
    throw new TypeError(
      `Setup handler ${uses} returned an invalid resolution.`,
      {
        cause: error,
      },
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SETUP_RESOLUTION_BYTES) {
    throw new TypeError(
      `Setup handler ${uses} returned an oversized resolution.`,
    );
  }
  return deepFreeze(JSON.parse(serialized) as JsonObject);
}

function assertBoundedPlainJson(input: JsonObject, uses: string): void {
  type Frame =
    | {
        readonly kind: 'enter';
        readonly value: unknown;
        readonly depth: number;
      }
    | { readonly kind: 'leave'; readonly value: object };
  const pending: Frame[] = [{ kind: 'enter', value: input, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.kind === 'leave') {
      ancestors.delete(frame.value);
      continue;
    }
    nodes += 1;
    if (
      nodes > MAX_SETUP_RESOLUTION_NODES ||
      frame.depth > MAX_SETUP_RESOLUTION_DEPTH
    ) {
      throw new TypeError(
        `Setup handler ${uses} returned an oversized resolution.`,
      );
    }
    const value = frame.value;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      continue;
    }
    if (typeof value !== 'object' || ancestors.has(value)) {
      throw new TypeError(
        `Setup handler ${uses} returned an invalid resolution.`,
      );
    }
    let children: readonly unknown[];
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
      if (
        keys.length !== value.length ||
        keys.some(
          (key, index) =>
            key !== String(index) ||
            Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true,
        )
      ) {
        throw new TypeError(
          `Setup handler ${uses} returned an invalid resolution.`,
        );
      }
      children = value;
    } else {
      if (!isPlainRecord(value)) {
        throw new TypeError(
          `Setup handler ${uses} returned an invalid resolution.`,
        );
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true,
        )
      ) {
        throw new TypeError(
          `Setup handler ${uses} returned an invalid resolution.`,
        );
      }
      children = (keys as string[]).map((key) => value[key]);
    }
    if (children.length > MAX_SETUP_RESOLUTION_COLLECTION_ENTRIES) {
      throw new TypeError(
        `Setup handler ${uses} returned an oversized resolution.`,
      );
    }
    ancestors.add(value);
    pending.push({ kind: 'leave', value });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        kind: 'enter',
        value: children[index],
        depth: frame.depth + 1,
      });
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
