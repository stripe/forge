import { isDeepStrictEqual } from 'node:util';
import {
  ATIF_SCHEMA_VERSION,
  type AtifAgentStep,
  type AtifNormalizationSource,
  type AtifNormalizationWarning,
  type AtifObservationResult,
  type AtifToolCall,
  type AtifTrajectoryV1_8,
  createNormalizedTrajectory,
  type JsonObject,
  type JsonValue,
  type NormalizedTrajectory,
} from '../atif/index.ts';
import type {
  AgentAdapter,
  AgentEvidenceIdentity,
  AgentNativeEvidenceResult,
  AgentToolCall,
} from '../contracts/agent.ts';
import type { SecretRedactor } from '../security/redaction.ts';

// Keep deterministic fallback comfortably below the stricter whole-ATIF graph
// budgets. Authored prompts are independently capped at 1 MiB and generated
// Ava prompts at 500 characters, so exact user messages always retain headroom.
const MAX_COMPLETED_TURNS = 100;
const FALLBACK_ASSISTANT_CODE_UNIT_BUDGET = 8 * 1024 * 1024;
const FALLBACK_TOOL_CALL_BUDGET = 256;
const FALLBACK_TOOL_ARGUMENT_CODE_UNITS = 4096;
const FALLBACK_TOOL_RESULT_CODE_UNITS = 8192;
const FALLBACK_TOOL_ARGUMENT_DEPTH = 16;
const TRUNCATION_MARKER = '\n[Forge truncated driver evidence.]';

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
  /**
   * Redacts fallback assistant text, tool arguments, and tool results right
   * before each is cut, so a clipped prefix never retains part of a secret.
   * Native coverage always compares the raw completed turns.
   */
  readonly redactor?: SecretRedactor;
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
    throw new TypeError(
      'Agent evidence identity requires a safe name and version.',
    );
  }
  return Object.freeze({ name: input.name, version: input.version });
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
    return createDriverFallbackEvidence(
      input,
      parseUnavailableReason(input.collected.reason),
    );
  }
  if (input.collected.kind !== 'available') {
    throw new TypeError('Agent returned an invalid native evidence result.');
  }

  const candidate = createNormalizedTrajectory({
    trajectory: input.collected.trajectory,
    provenance: {
      source: input.collected.source,
      adapter: { id: input.agent.id, version: input.agent.version },
    },
    completeness:
      input.collected.warnings.length === 0 ? 'complete' : 'partial',
    warnings: input.collected.warnings,
  });
  const source = candidate.provenance.source;
  if (source.kind !== 'native_log' && source.kind !== 'atif') {
    throw new TypeError(
      'Agent evidence candidates must identify a native source.',
    );
  }
  if (
    source.sessionId !== input.sessionId ||
    candidate.trajectory.session_id !== input.sessionId
  ) {
    throw new TypeError(
      'Native evidence did not identify the selected agent session.',
    );
  }
  if (
    candidate.warnings.some(
      ({ code }) =>
        code !== 'unsupported_native_event' && code !== 'value_omitted',
    )
  ) {
    throw new TypeError(
      'Available native evidence contained a source-state or fallback warning.',
    );
  }
  if (
    !trajectoryCoversCompletedTurns(
      candidate.trajectory,
      input.completedTurns,
      source,
    )
  ) {
    return createDriverFallbackEvidence(input, {
      code: 'source_incomplete',
      message: 'Native evidence did not cover every completed agent turn.',
    });
  }
  return candidate;
}

interface NativeTurnCoverage {
  user: string;
  hasAgentStep: boolean;
  hasResponseEvidence: boolean;
  hasAssistantText: boolean;
  toolCounts: Map<string, number>;
  text: string[];
  calls: AtifToolCall[];
}

/**
 * Shared selection/verification policy. Codex reconciles comparable tool kinds;
 * OpenCode reconciles identical part snapshots. Other native formats and
 * bounded driver fallback retain structural coverage only.
 */
export function trajectoryCoversCompletedTurns(
  trajectory: AtifTrajectoryV1_8,
  completedTurns: readonly CompletedEvidenceTurn[],
  source: Pick<AtifNormalizationSource, 'kind' | 'format'>,
): boolean {
  const reconcileCodex =
    source.kind === 'native_log' && source.format === 'codex-rollout-jsonl';
  const reconcileOpenCode =
    source.kind === 'native_log' && source.format === 'opencode-session-json';
  const nativeTurns: NativeTurnCoverage[] = [];
  let current: NativeTurnCoverage | undefined;

  for (const step of trajectory.steps) {
    if (step.is_copied_context === true || step.source === 'system') continue;
    if (step.source === 'user') {
      if (typeof step.message !== 'string') return false;
      current = {
        user: step.message,
        hasAgentStep: false,
        hasResponseEvidence: false,
        hasAssistantText: false,
        toolCounts: new Map(),
        text: [],
        calls: [],
      };
      nativeTurns.push(current);
      continue;
    }
    if (current === undefined) return false;
    current.hasAgentStep = true;
    if (hasVisibleAgentEvidence(step)) current.hasResponseEvidence = true;
    if (hasAssistantText(step)) current.hasAssistantText = true;
    if (reconcileOpenCode) {
      if (typeof step.message !== 'string') return false;
      if (step.message.length > 0) current.text.push(step.message);
      current.calls.push(...(step.tool_calls ?? []));
    }
    if (reconcileCodex) {
      for (const call of step.tool_calls ?? []) {
        const category = codexToolCategory(call.function_name, 'native');
        if (category !== undefined)
          incrementCount(current.toolCounts, category);
      }
    }
  }

  if (nativeTurns.length !== completedTurns.length) return false;
  return completedTurns.every((completed, index) => {
    const native = nativeTurns[index];
    if (native === undefined || native.user !== completed.user) return false;
    if (!native.hasAgentStep) return false;
    if (reconcileOpenCode) {
      if (native.text.join('\n\n') !== completed.assistant) return false;
      if (native.calls.length !== completed.toolCalls.length) return false;
      const nativeCalls = new Map(
        native.calls.map((call) => [call.tool_call_id, call]),
      );
      if (nativeCalls.size !== native.calls.length) return false;
      const driverCallIds = new Set(completed.toolCalls.map((call) => call.id));
      if (driverCallIds.size !== completed.toolCalls.length) return false;
      if (
        !completed.toolCalls.every((call) => {
          // The live stream emits completion order; the export retains call
          // creation order. Unique IDs correlate parallel tools without loss.
          const observed =
            call.id === undefined ? undefined : nativeCalls.get(call.id);
          return (
            observed !== undefined &&
            observed.function_name === call.name &&
            isDeepStrictEqual(observed.arguments, call.input)
          );
        })
      )
        return false;
    }
    if (reconcileCodex) {
      if (completed.assistant.length > 0 && !native.hasAssistantText)
        return false;
      const driverToolCounts = new Map<string, number>();
      for (const call of completed.toolCalls) {
        const category = codexToolCategory(call.name, 'live');
        // A new live tool kind needs a deliberate native mapping; unrelated
        // native activity must not make unsupported coverage look complete.
        if (category === undefined) return false;
        incrementCount(driverToolCounts, category);
      }
      for (const [category, count] of driverToolCounts) {
        if ((native.toolCounts.get(category) ?? 0) < count) return false;
      }
    }
    const driverHasResponse =
      completed.assistant.length > 0 || completed.toolCalls.length > 0;
    return !driverHasResponse || native.hasResponseEvidence;
  });
}

function hasAssistantText(step: AtifAgentStep): boolean {
  return typeof step.message === 'string'
    ? step.message.length > 0
    : step.message.some((part) => part.type === 'text' && part.text.length > 0);
}

function incrementCount(counts: Map<string, number>, category: string): void {
  counts.set(category, (counts.get(category) ?? 0) + 1);
}

/**
 * Compare protocol categories, never tool IDs or argument bytes. Command
 * snapshots use command_execution while rollout calls use exec_command or
 * write_stdin; several native polling calls may describe one live command.
 * Discovery-only tool_search has no live counterpart and cannot cover a
 * missing execution/MCP call. Preserve tool-name case and only strip the
 * built-in functions namespace, not arbitrary user-defined namespaces.
 */
function codexToolCategory(
  name: string,
  protocol: 'live' | 'native',
): string | undefined {
  if (protocol === 'native' && name.startsWith('functions.')) {
    name = name.slice('functions.'.length);
  }
  if (name.startsWith('mcp__')) {
    if (protocol === 'native') {
      const namespaceEnd = name.indexOf('.', 'mcp__'.length);
      // Pinned Codex server IDs permit __ but not dots. The first dot is the
      // native namespace separator; preserve any dots in the tool-name suffix.
      if (namespaceEnd > 'mcp__'.length) {
        name = `${name.slice(0, namespaceEnd)}__${name.slice(namespaceEnd + 1)}`;
      }
    }
    const separator = name.indexOf('__', 'mcp__'.length);
    return separator > 'mcp__'.length && separator + 2 < name.length
      ? name
      : undefined;
  }
  if (protocol === 'live') {
    return [
      'command_execution',
      'file_change',
      'todo_list',
      'web_search',
    ].includes(name)
      ? name
      : undefined;
  }
  switch (name) {
    case 'exec_command':
    case 'write_stdin':
      return 'command_execution';
    case 'apply_patch':
      return 'file_change';
    case 'update_plan':
      return 'todo_list';
    case 'web_search':
      return 'web_search';
    default:
      return undefined;
  }
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

/** Internal reuse of the same bounded driver trajectory for judge-budget fallback. */
export function createDriverFallbackEvidence(
  input: Omit<SelectAgentEvidenceInput, 'collected'>,
  reason: AtifNormalizationWarning,
): NormalizedTrajectory {
  const completedTurns = input.completedTurns;
  const redactor = input.redactor;
  const steps: AtifTrajectoryV1_8['steps'] = [];
  const nonemptyAssistantTurns = completedTurns.filter(
    ({ assistant }) => assistant.length > 0,
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
  const toolCallCounts = boundedToolCallCounts(completedTurns);
  let detailOmitted = false;

  for (const [turnIndex, turn] of completedTurns.entries()) {
    const visibleAssistant =
      redactor === undefined ? turn.assistant : redactor.text(turn.assistant);
    let assistant = boundedPrefix(visibleAssistant, assistantLimit);
    if (assistant.length !== visibleAssistant.length) detailOmitted = true;
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
      redactor,
    );
    if (
      retainedToolCallCount !== turn.toolCalls.length ||
      projectedTools.detailOmitted
    ) {
      detailOmitted = true;
    }
    if (retainedToolCallCount !== turn.toolCalls.length) {
      assistant += '\n[Forge omitted additional tool calls and results.]';
    }
    steps.push({
      step_id: agentStepId,
      source: 'agent',
      model_name: input.model,
      message: assistant,
      ...(projectedTools.calls.length === 0
        ? {}
        : { tool_calls: projectedTools.calls }),
      ...(projectedTools.results.length === 0
        ? {}
        : {
            observation: { results: projectedTools.results },
          }),
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
      adapter: { id: input.agent.id, version: input.agent.version },
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
  redactor: SecretRedactor | undefined,
): {
  calls: AtifToolCall[];
  results: AtifObservationResult[];
  detailOmitted: boolean;
} {
  const usedIds = new Set<string>();
  const results: AtifObservationResult[] = [];
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
    const toolArguments = fallbackToolArguments(call.input, redactor);
    if (toolArguments.detailOmitted) detailOmitted = true;
    if (call.result !== undefined) {
      const safeContent =
        redactor === undefined
          ? call.result.content
          : redactor.text(call.result.content);
      const content = boundedPrefix(
        safeContent +
          (call.result.truncated === true
            ? '\n[Forge tool result is incomplete.]'
            : ''),
        FALLBACK_TOOL_RESULT_CODE_UNITS,
      );
      if (content !== safeContent) detailOmitted = true;
      results.push({
        source_call_id: toolCallId,
        content,
        ...(call.result.isError === undefined
          ? {}
          : { extra: { is_error: call.result.isError } }),
      });
    }
    return {
      tool_call_id: toolCallId,
      function_name: call.name,
      arguments: toolArguments.arguments,
    };
  });
  return { calls: projected, results, detailOmitted };
}

function boundedToolCallCounts(
  turns: readonly CompletedEvidenceTurn[],
): number[] {
  const counts: number[] = turns.map(({ toolCalls }) =>
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

function fallbackToolArguments(
  value: unknown,
  redactor: SecretRedactor | undefined,
): {
  arguments: JsonObject;
  detailOmitted: boolean;
} {
  if (value === undefined) return { arguments: {}, detailOmitted: false };
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
    return omittedArguments();
  }
  if (encoded === undefined || lossy) {
    return omittedArguments();
  }
  // Only now is the value known to be JSON, so redact here, before measuring
  // and cutting it.
  const parsed = JSON.parse(encoded) as JsonValue;
  const json = redactor === undefined ? parsed : redactor.json(parsed);
  const candidate =
    json !== null && typeof json === 'object' && !Array.isArray(json)
      ? json
      : { value: json };
  const serialized = JSON.stringify(candidate);
  if (
    serialized.length > FALLBACK_TOOL_ARGUMENT_CODE_UNITS ||
    jsonDepth(candidate) > FALLBACK_TOOL_ARGUMENT_DEPTH ||
    countJsonValues(candidate) > 128
  ) {
    return {
      arguments: {
        forge_truncated_arguments: boundedPrefix(
          `${serialized}${TRUNCATION_MARKER}`,
          FALLBACK_TOOL_ARGUMENT_CODE_UNITS,
        ),
      },
      detailOmitted: true,
    };
  }
  return { arguments: candidate, detailOmitted: false };
}

function omittedArguments(): { arguments: JsonObject; detailOmitted: boolean } {
  return {
    arguments: {
      forge_omitted_arguments: '[Forge omitted unavailable tool arguments.]',
    },
    detailOmitted: true,
  };
}

function boundedPrefix(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - TRUNCATION_MARKER.length);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
  return text.slice(0, end) + TRUNCATION_MARKER;
}

function countJsonValues(value: JsonValue): number {
  if (value === null || typeof value !== 'object') return 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  return (
    1 +
    children.reduce<number>((total, child) => total + countJsonValues(child), 0)
  );
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
    throw new TypeError(
      'Unavailable native evidence has an invalid reason code.',
    );
  }
  if (!isSafeWarningMessage(input.message)) {
    throw new TypeError(
      'Unavailable native evidence has an invalid reason message.',
    );
  }
  return { code: input.code, message: input.message };
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
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 64 * 1_024
  );
}
