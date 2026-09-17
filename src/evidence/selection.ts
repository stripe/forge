import {
  ATIF_SCHEMA_VERSION,
  createNormalizedTrajectory,
  type AtifAgentStep,
  type AtifNormalizationWarning,
  type AtifTrajectoryV1_8,
  type AtifToolCall,
  type JsonObject,
  type JsonValue,
  type NormalizedTrajectory,
} from '../atif/index.js';
import type {
  AgentAdapter,
  AgentEvidenceIdentity,
  AgentNativeEvidenceResult,
  AgentToolCall,
} from '../contracts/agent.js';

// Keep deterministic fallback comfortably below the stricter whole-ATIF graph
// budgets. Authored one-shot prompts are independently capped at 1 MiB and Ava
// prompts at 500 characters, so exact user messages always retain headroom.
const MAX_COMPLETED_TURNS = 100;
const FALLBACK_ASSISTANT_CODE_UNIT_BUDGET = 8 * 1024 * 1024;
const FALLBACK_TOOL_CALL_BUDGET = 256;
const FALLBACK_TOOL_ARGUMENT_CODE_UNITS = 256;
const FALLBACK_TOOL_ARGUMENT_DEPTH = 16;

export interface CompletedEvidenceTurn {
  readonly user: string;
  readonly assistant: string;
  readonly toolCalls: readonly AgentToolCall[];
}

export interface SelectAgentEvidenceInput {
  readonly agent: AgentAdapter;
  readonly identity: AgentEvidenceIdentity;
  readonly model: string;
  readonly sessionId: string;
  readonly completedTurns: readonly CompletedEvidenceTurn[];
  readonly collected: AgentNativeEvidenceResult;
}

/** Validate the adapter's pure coding-agent identity before allocating authority. */
export function parseAgentEvidenceIdentity(
  input: unknown,
): AgentEvidenceIdentity {
  if (!isPlainRecord(input)) {
    throw new TypeError('Agent evidence identity must be a plain object.');
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'name' ||
    keys[1] !== 'version' ||
    !isSafeMetadataText(input.name) ||
    !isSafeMetadataText(input.version)
  ) {
    throw new TypeError('Agent evidence identity requires a safe name and version.');
  }
  return Object.freeze({name: input.name, version: input.version});
}

/**
 * Select score-bearing evidence. Native ATIF supplies detail only after the
 * completed driver ledger proves that every logical invocation is represented.
 */
export function selectAgentEvidence(
  input: SelectAgentEvidenceInput,
): NormalizedTrajectory {
  if (
    input.completedTurns.length === 0 ||
    input.completedTurns.length > MAX_COMPLETED_TURNS
  ) {
    throw new TypeError(
      `Agent evidence requires between 1 and ${MAX_COMPLETED_TURNS} completed turns.`,
    );
  }

  if (!isPlainRecord(input.collected)) {
    throw new TypeError('Agent returned an invalid native evidence result.');
  }
  if (input.collected.kind === 'unavailable') {
    return driverFallback(input, parseUnavailableReason(input.collected.reason));
  }
  if (input.collected.kind !== 'available') {
    throw new TypeError('Agent returned an invalid native evidence result.');
  }

  const candidate = createNormalizedTrajectory({
    trajectory: input.collected.trajectory,
    provenance: {
      source: input.collected.source,
      adapter: {id: input.agent.id, version: input.agent.version},
    },
    completeness: input.collected.warnings.length === 0 ? 'complete' : 'partial',
    warnings: input.collected.warnings,
  });
  const source = candidate.provenance.source;
  if (source.kind !== 'native_log' && source.kind !== 'atif') {
    throw new TypeError('Agent evidence candidates must identify a native source.');
  }
  if (
    source.sessionId !== input.sessionId ||
    candidate.trajectory.session_id !== input.sessionId
  ) {
    throw new TypeError('Native evidence did not identify the selected agent session.');
  }
  if (
    candidate.warnings.some(
      ({code}) => code !== 'unsupported_native_event' && code !== 'value_omitted',
    )
  ) {
    throw new TypeError(
      'Available native evidence contained a source-state or fallback warning.',
    );
  }
  if (!trajectoryCoversCompletedTurns(candidate.trajectory, input.completedTurns)) {
    return driverFallback(input, {
      code: 'source_incomplete',
      message: 'Native evidence did not cover every completed agent turn.',
    });
  }
  return candidate;
}

/** Structural coverage only; native and live protocols may be lossy projections. */
export function trajectoryCoversCompletedTurns(
  trajectory: AtifTrajectoryV1_8,
  completedTurns: readonly CompletedEvidenceTurn[],
): boolean {
  const nativeTurns: Array<{
    user: string;
    hasAgentStep: boolean;
    hasResponseEvidence: boolean;
  }> = [];
  let current:
    | {
        user: string;
        hasAgentStep: boolean;
        hasResponseEvidence: boolean;
      }
    | undefined;

  for (const step of trajectory.steps) {
    if (step.is_copied_context === true || step.source === 'system') continue;
    if (step.source === 'user') {
      if (typeof step.message !== 'string') return false;
      current = {
        user: step.message,
        hasAgentStep: false,
        hasResponseEvidence: false,
      };
      nativeTurns.push(current);
      continue;
    }
    if (current === undefined) return false;
    current.hasAgentStep = true;
    if (hasVisibleAgentEvidence(step)) current.hasResponseEvidence = true;
  }

  if (nativeTurns.length !== completedTurns.length) return false;
  return completedTurns.every((completed, index) => {
    const native = nativeTurns[index];
    if (native === undefined || native.user !== completed.user) return false;
    if (!native.hasAgentStep) return false;
    const driverHasResponse =
      completed.assistant.length > 0 || completed.toolCalls.length > 0;
    return !driverHasResponse || native.hasResponseEvidence;
  });
}

function hasVisibleAgentEvidence(step: AtifAgentStep): boolean {
  if (typeof step.message === 'string') {
    if (step.message.length > 0) return true;
  } else if (
    step.message.some((part) => part.type !== 'text' || part.text.length > 0)
  ) {
    return true;
  }
  return (step.tool_calls?.length ?? 0) > 0;
}

function driverFallback(
  input: SelectAgentEvidenceInput,
  reason: AtifNormalizationWarning,
): NormalizedTrajectory {
  const steps: AtifTrajectoryV1_8['steps'] = [];
  const nonemptyAssistantTurns = input.completedTurns.filter(
    ({assistant}) => assistant.length > 0,
  ).length;
  const assistantLimit =
    nonemptyAssistantTurns === 0
      ? 0
      : Math.max(
          1,
          Math.floor(
            FALLBACK_ASSISTANT_CODE_UNIT_BUDGET / nonemptyAssistantTurns,
          ),
        );
  const toolCallCounts = boundedToolCallCounts(input.completedTurns);
  let detailOmitted = false;

  for (const [turnIndex, turn] of input.completedTurns.entries()) {
    const assistant =
      turn.assistant.length <= assistantLimit
        ? turn.assistant
        : turn.assistant.slice(0, assistantLimit);
    if (assistant.length !== turn.assistant.length) detailOmitted = true;
    steps.push({
      step_id: steps.length + 1,
      source: 'user',
      message: turn.user,
    });
    const agentStepId = steps.length + 1;
    const retainedToolCallCount = toolCallCounts[turnIndex] ?? 0;
    const projectedTools = fallbackToolCalls(
      turn.toolCalls.slice(0, retainedToolCallCount),
      agentStepId,
    );
    if (
      retainedToolCallCount !== turn.toolCalls.length ||
      projectedTools.detailOmitted
    ) {
      detailOmitted = true;
    }
    steps.push({
      step_id: agentStepId,
      source: 'agent',
      model_name: input.model,
      message: assistant,
      ...(projectedTools.calls.length === 0
        ? {}
        : {tool_calls: projectedTools.calls}),
    });
  }

  return createNormalizedTrajectory({
    trajectory: {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: input.sessionId,
      agent: {
        name: input.identity.name,
        version: input.identity.version,
        model_name: input.model,
      },
      steps,
    },
    provenance: {
      source: {
        kind: 'driver_fallback',
        format: 'forge-driver-turns',
        sessionId: input.sessionId,
      },
      adapter: {id: input.agent.id, version: input.agent.version},
    },
    completeness: 'fallback',
    warnings: [
      reason,
      ...(detailOmitted
        ? [
            {
              code: 'value_omitted' as const,
              message:
                'Driver fallback truncated or omitted assistant or tool detail to remain within canonical ATIF bounds.',
            },
          ]
        : []),
      {
        code: 'fallback_used',
        message: 'Canonical ATIF was built from completed driver turns.',
      },
    ],
  });
}

function fallbackToolCalls(
  calls: readonly AgentToolCall[],
  stepId: number,
): {calls: AtifToolCall[]; detailOmitted: boolean} {
  const usedIds = new Set<string>();
  let detailOmitted = false;
  const projected = calls.map((call, index) => {
    const preferredId = call.id ?? `driver-call-${stepId}-${index + 1}`;
    let toolCallId = preferredId;
    let collision = 1;
    while (usedIds.has(toolCallId)) {
      toolCallId = `driver-call-${stepId}-${index + 1}-${collision}`;
      collision += 1;
    }
    usedIds.add(toolCallId);
    const toolArguments = fallbackToolArguments(call.input);
    if (toolArguments.detailOmitted) detailOmitted = true;
    return {
      tool_call_id: toolCallId,
      function_name: call.name,
      arguments: toolArguments.arguments,
    };
  });
  return {calls: projected, detailOmitted};
}

function boundedToolCallCounts(turns: readonly CompletedEvidenceTurn[]): number[] {
  const counts: number[] = turns.map(({toolCalls}) =>
    toolCalls.length > 0 ? 1 : 0,
  );
  let remaining =
    FALLBACK_TOOL_CALL_BUDGET -
    counts.reduce((total, count) => total + count, 0);
  for (const [index, turn] of turns.entries()) {
    if (remaining <= 0) break;
    const current = counts[index] ?? 0;
    const additional = Math.min(turn.toolCalls.length - current, remaining);
    counts[index] = current + additional;
    remaining -= additional;
  }
  return counts;
}

function fallbackToolArguments(value: unknown): {
  arguments: JsonObject;
  detailOmitted: boolean;
} {
  if (value === undefined) return {arguments: {}, detailOmitted: false};
  let lossy = false;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (key, nested) => {
      if (key === '__proto__') {
        lossy = true;
        return undefined;
      }
      if (
        typeof nested === 'undefined' ||
        typeof nested === 'function' ||
        typeof nested === 'symbol' ||
        typeof nested === 'bigint' ||
        (typeof nested === 'number' && !Number.isFinite(nested))
      ) {
        lossy = true;
        return null;
      }
      if (
        nested !== null &&
        typeof nested === 'object' &&
        !Array.isArray(nested)
      ) {
        const prototype = Object.getPrototypeOf(nested);
        if (prototype !== Object.prototype && prototype !== null) {
          lossy = true;
          return null;
        }
      }
      return nested;
    });
  } catch {
    return {arguments: {}, detailOmitted: true};
  }
  if (encoded === undefined || lossy) {
    return {arguments: {}, detailOmitted: true};
  }
  const json = JSON.parse(encoded) as JsonValue;
  const candidate =
    json !== null && typeof json === 'object' && !Array.isArray(json)
      ? json
      : {value: json};
  if (
    JSON.stringify(candidate).length > FALLBACK_TOOL_ARGUMENT_CODE_UNITS ||
    jsonDepth(candidate) > FALLBACK_TOOL_ARGUMENT_DEPTH
  ) {
    return {arguments: {}, detailOmitted: true};
  }
  return {arguments: candidate, detailOmitted: false};
}

function jsonDepth(value: JsonValue, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  let maximum = depth;
  for (const child of children) {
    maximum = Math.max(maximum, jsonDepth(child, depth + 1));
  }
  return maximum;
}

function parseUnavailableReason(input: unknown): AtifNormalizationWarning {
  if (!isPlainRecord(input)) {
    throw new TypeError('Unavailable native evidence requires a safe reason.');
  }
  if (
    input.code !== 'source_unavailable' &&
    input.code !== 'source_invalid' &&
    input.code !== 'source_incomplete'
  ) {
    throw new TypeError('Unavailable native evidence has an invalid reason code.');
  }
  if (!isSafeWarningMessage(input.message)) {
    throw new TypeError('Unavailable native evidence has an invalid reason message.');
  }
  return {code: input.code, message: input.message};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeMetadataText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSafeWarningMessage(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 * 1_024;
}
