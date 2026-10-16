import { z } from 'zod';

import { parseAtifSchema } from './schema.ts';
import type { AtifTrajectoryV1_8 } from './types.ts';

export type AtifValidationPath = readonly (string | number)[];

export type AtifValidationIssueCode =
  | 'invalid_json_value'
  | 'input_limit_exceeded'
  | 'schema_violation';

export interface AtifValidationIssue {
  code: AtifValidationIssueCode;
  path: AtifValidationPath;
  message: string;
}

export class AtifValidationError extends Error {
  readonly code = 'invalid_atif_trajectory' as const;
  readonly issues: readonly AtifValidationIssue[];

  constructor(issues: readonly AtifValidationIssue[]) {
    super(
      `ATIF trajectory validation failed with ${issues.length} issue${
        issues.length === 1 ? '' : 's'
      }.`,
    );
    this.name = 'AtifValidationError';
    this.issues = [...issues];
  }
}

const MAX_GRAPH_DEPTH = 64;
const MAX_GRAPH_NODES = 100_000;
const MAX_COLLECTION_ENTRIES = 100_000;
const MAX_TOTAL_STRING_CODE_UNITS = 16 * 1024 * 1024;

interface GraphBudget {
  nodes: number;
  collectionEntries: number;
  stringCodeUnits: number;
  ancestors: WeakSet<object>;
}

/**
 * Parse untrusted JSON-shaped data as the exact ATIF-v1.8 contract.
 *
 * The preflight rejects cyclic, exotic, sparse, non-finite, or unbounded
 * JavaScript values before the recursive schema is evaluated. The returned
 * object is a fresh schema projection and canonicalizes documented audio MIME
 * aliases.
 */
export function parseAtifTrajectory(input: unknown): AtifTrajectoryV1_8 {
  assertBoundedJsonValue(input);

  try {
    return parseAtifSchema(input);
  } catch (error) {
    if (error instanceof AtifValidationError) throw error;
    if (error instanceof z.ZodError) {
      throw new AtifValidationError(
        error.issues.map((issue) => ({
          code: 'schema_violation' as const,
          path: issue.path.map((segment) =>
            typeof segment === 'number' || typeof segment === 'string'
              ? segment
              : String(segment),
          ),
          message: issue.message,
        })),
      );
    }
    throw error;
  }
}

/** Internal shared JSON-graph preflight used before recursive wire parsing. */
export function assertBoundedJsonValue(input: unknown): void {
  const budget: GraphBudget = {
    nodes: 0,
    collectionEntries: 0,
    stringCodeUnits: 0,
    ancestors: new WeakSet<object>(),
  };
  visitJsonValue(input, [], 0, budget);
}

function visitJsonValue(
  value: unknown,
  path: (string | number)[],
  depth: number,
  budget: GraphBudget,
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_GRAPH_NODES) {
    failLimit(path, `input exceeds ${MAX_GRAPH_NODES} expanded values`);
  }
  if (depth > MAX_GRAPH_DEPTH) {
    failLimit(path, `input exceeds the maximum depth of ${MAX_GRAPH_DEPTH}`);
  }

  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      failJson(path, 'numbers must be finite JSON numbers');
    }
    return;
  }
  if (typeof value === 'string') {
    addStringBudget(value, path, budget);
    return;
  }
  if (typeof value !== 'object') {
    failJson(path, `unsupported JSON value type: ${typeof value}`);
  }

  const objectValue = value as object;
  if (budget.ancestors.has(objectValue)) {
    failJson(path, 'cyclic values are not valid JSON');
  }
  budget.ancestors.add(objectValue);

  try {
    if (Array.isArray(value)) {
      visitArray(value, path, depth, budget);
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      failJson(path, 'objects must be plain JSON objects');
    }
    visitObject(value as Record<string, unknown>, path, depth, budget);
  } finally {
    budget.ancestors.delete(objectValue);
  }
}

function visitArray(
  value: unknown[],
  path: (string | number)[],
  depth: number,
  budget: GraphBudget,
): void {
  // Array length is available without enumerating its keys. Charge it first so
  // an oversized dense array cannot force large temporary key arrays before it
  // is rejected by the collection budget.
  addCollectionBudget(value.length, path, budget);
  const enumerableKeys = Object.keys(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    enumerableKeys.length !== value.length ||
    enumerableKeys.some((key, index) => key !== String(index)) ||
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        (key !== 'length' && !isCanonicalArrayIndex(key, value.length)),
    )
  ) {
    failJson(path, 'arrays must be dense and cannot have named properties');
  }

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      failJson([...path, index], 'array entries must be plain data values');
    }
    visitJsonValue(descriptor.value, [...path, index], depth + 1, budget);
  }
}

function visitObject(
  value: Record<string, unknown>,
  path: (string | number)[],
  depth: number,
  budget: GraphBudget,
): void {
  const ownKeys = Reflect.ownKeys(value);
  addCollectionBudget(ownKeys.length, path, budget);

  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      failJson(path, 'symbol keys are not valid JSON object keys');
    }
    if (key === '__proto__') {
      failJson(
        [...path, key],
        '__proto__ is not accepted because it cannot be preserved safely',
      );
    }
    addStringBudget(key, [...path, key], budget);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      failJson(
        [...path, key],
        'object properties must be enumerable plain data values',
      );
    }
    visitJsonValue(descriptor.value, [...path, key], depth + 1, budget);
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function addCollectionBudget(
  count: number,
  path: (string | number)[],
  budget: GraphBudget,
): void {
  budget.collectionEntries += count;
  if (budget.collectionEntries > MAX_COLLECTION_ENTRIES) {
    failLimit(
      path,
      `input exceeds ${MAX_COLLECTION_ENTRIES} expanded collection entries`,
    );
  }
}

function addStringBudget(
  value: string,
  path: (string | number)[],
  budget: GraphBudget,
): void {
  budget.stringCodeUnits += value.length;
  if (budget.stringCodeUnits > MAX_TOTAL_STRING_CODE_UNITS) {
    failLimit(
      path,
      `input exceeds ${MAX_TOTAL_STRING_CODE_UNITS} total string code units`,
    );
  }
}

function failJson(path: AtifValidationPath, message: string): never {
  throw new AtifValidationError([
    { code: 'invalid_json_value', path, message },
  ]);
}

function failLimit(path: AtifValidationPath, message: string): never {
  throw new AtifValidationError([
    { code: 'input_limit_exceeded', path, message },
  ]);
}
