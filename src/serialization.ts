/** JSON values accepted by Forge's deterministic wire serializer. */
export type SerializableJson =
  | null
  | boolean
  | number
  | string
  | SerializableJson[]
  | {[key: string]: SerializableJson};

/**
 * Serialize JSON with recursively sorted object keys and a trailing newline.
 * Arrays retain authored order. Undefined, non-finite numbers, cycles, and
 * non-plain objects are rejected instead of being silently projected.
 */
export function serializeCanonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalized = normalize(value, seen, '$');
  return `${JSON.stringify(normalized)}\n`;
}

function normalize(
  value: unknown,
  seen: Set<object>,
  path: string,
): SerializableJson {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at ${path}.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    enter(value, seen, path);
    try {
      return value.map((item, index) =>
        normalize(item, seen, `${path}[${index}]`),
      );
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}.`);
    }
    enter(value, seen, path);
    try {
      const output: {[key: string]: SerializableJson} = {};
      for (const key of Object.keys(value).sort(compareStrings)) {
        const child = (value as Record<string, unknown>)[key];
        if (child === undefined) {
          throw new TypeError(`Undefined value at ${path}.${key}.`);
        }
        defineOwnValue(output, key, normalize(child, seen, `${path}.${key}`));
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }
  throw new TypeError(`Non-JSON value at ${path}.`);
}

function defineOwnValue(
  output: {[key: string]: SerializableJson},
  key: string,
  value: SerializableJson,
): void {
  Object.defineProperty(output, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function enter(value: object, seen: Set<object>, path: string): void {
  if (seen.has(value)) throw new TypeError(`Cyclic value at ${path}.`);
  seen.add(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
