import {parseAtifTrajectory} from './parser.js';
import type {
  AtifTrajectoryV1_8,
  JsonObject,
  JsonValue,
} from './types.js';

/**
 * Serialize an ATIF trajectory to deterministic UTF-8 JSON text.
 *
 * ATIF specifies a data model, not canonical bytes. Forge recursively sorts
 * object keys, retains array order, uses two-space indentation, and appends one
 * final LF. The input is parsed again so typed callers cannot bypass runtime
 * validation or alias normalization.
 */
export function serializeAtifTrajectory(
  trajectory: AtifTrajectoryV1_8,
): string {
  const parsed = parseAtifTrajectory(trajectory);
  return `${JSON.stringify(sortJsonValue(parsed as unknown as JsonValue), null, 2)}\n`;
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== 'object') return value;

  const sorted: JsonObject = Object.create(null) as JsonObject;
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    sorted[key] = sortJsonValue(value[key]!);
  }
  return sorted;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
