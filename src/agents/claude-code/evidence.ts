import {
  ATIF_SCHEMA_VERSION,
  type AtifAgentStep,
  type AtifNormalizationWarning,
  type AtifObservationResult,
  type AtifStep,
  type AtifSystemStep,
  type AtifToolCall,
  type AtifTrajectoryV1_8,
  isAtifTimestamp,
  type JsonObject,
  type JsonValue,
  parseAtifTrajectory,
} from '../../atif/index.ts';
import { assertBoundedJsonValue } from '../../atif/parser.ts';
import type {
  AgentNativeArtifact,
  AgentNativeEvidenceResult,
  AgentNativeEvidenceSource,
  AgentNativeEvidenceUnavailable,
  AgentNativeEvidenceWarning,
} from '../../contracts/agent.ts';
import type { ReadonlyWorkspace } from '../../contracts/runtime.ts';
import { isSafeSessionId } from './stream.ts';

const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_LINES = 100_000;
const MAX_SESSION_LINE_BYTES = 1024 * 1024;
const MAX_RENDERED_ATTACHMENT_PARTS = 64;
const SAFE_ATTACHMENT_TYPE = /^[a-z][a-z0-9_-]{0,127}$/;
const HOOK_ATTACHMENT_RECORD_KEYS = new Set([
  'attachment',
  'cwd',
  'entrypoint',
  'gitBranch',
  'isSidechain',
  'parentUuid',
  'rendered',
  'sessionId',
  'timestamp',
  'type',
  'userType',
  'uuid',
  'version',
]);
const IGNORED_RECORD_TYPES = new Set([
  'agent-name',
  'ai-title',
  'custom-title',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'pr-link',
  'queue-operation',
  'summary',
]);
const IGNORED_SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'turn_duration']);
const OMITTED_ATTACHMENT_TYPES = new Set([
  'agent_listing_delta',
  'command_permissions',
  'compact_file_reference',
  'deferred_tools_delta',
  'dynamic_skill',
  'file',
  'invoked_skills',
  'mcp_instructions_delta',
  'nested_memory',
  'skill_listing',
  'task_reminder',
]);
const BOOKKEEPING_OMISSION_MESSAGES = {
  batching_reminder_sent:
    'Claude batching reminder bookkeeping was omitted from ATIF',
} as const;

type BookkeepingRecordType = keyof typeof BOOKKEEPING_OMISSION_MESSAGES;
interface BookkeepingOmission {
  count: number;
  firstLine: number;
}
type BookkeepingOmissions = Map<BookkeepingRecordType, BookkeepingOmission>;

interface SessionBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface SessionRecord {
  type?: string;
  subtype?: string;
  source?: string;
  timestamp?: string;
  sessionId?: string;
  session_id?: string;
  isCompactSummary?: boolean;
  isMeta?: boolean;
  isSidechain?: boolean;
  attachment?: unknown;
  rendered?: unknown;
  atis?: unknown;
  message?: { content?: string | SessionBlock[] };
}

interface LocatedSessionRecord {
  record: SessionRecord | undefined;
  line: number;
}

export interface LoadClaudeEvidenceInput {
  readonly project: ReadonlyWorkspace | undefined;
  readonly sessionId: string;
  readonly agentVersion: string;
  readonly model: string;
  readonly signal: AbortSignal;
}

/** A preservation-only projection, never a score-bearing evidence candidate. */
export interface ClaudeRecoveredEvidence {
  readonly kind: 'recovered';
  readonly trajectory: AtifTrajectoryV1_8;
  readonly source: AgentNativeEvidenceSource;
  readonly warnings: readonly AtifNormalizationWarning[];
}

export type ClaudeEvidenceRecoveryResult =
  | ClaudeRecoveredEvidence
  | AgentNativeEvidenceUnavailable;

type RecoveryOmissionKind = 'invalid_lines' | 'records' | 'blocks';
type RecoveryOmissions = Map<RecoveryOmissionKind, BookkeepingOmission>;

function unavailable(
  code: AgentNativeEvidenceUnavailable['reason']['code'],
  message: string,
): AgentNativeEvidenceUnavailable {
  return { kind: 'unavailable', reason: { code, message } };
}

/** Capture the exact selected Claude project JSONL without transforming it. */
export async function loadClaudeNativeArtifact(
  input: Pick<LoadClaudeEvidenceInput, 'project' | 'sessionId' | 'signal'>,
): Promise<AgentNativeArtifact | undefined> {
  if (!input.project || !isSafeSessionId(input.sessionId)) return undefined;
  input.signal.throwIfAborted();
  try {
    const bytes = await readExactSessionBytes(
      input.project,
      input.sessionId,
      input.signal,
    );
    if (bytes === undefined) return undefined;
    return {
      format: 'claude-code-jsonl',
      sessionId: input.sessionId,
      mediaType: 'application/x-ndjson',
      extension: 'jsonl',
      body: Uint8Array.from(bytes),
    };
  } catch {
    if (input.signal.aborted) input.signal.throwIfAborted();
    return undefined;
  }
}

/** Load and normalize exact native evidence; Forge's engine owns fallback selection. */
export async function loadClaudeEvidence(
  input: LoadClaudeEvidenceInput,
): Promise<AgentNativeEvidenceResult> {
  if (!input.project || !isSafeSessionId(input.sessionId)) {
    return unavailable(
      'source_unavailable',
      'The exact Claude session is unavailable.',
    );
  }
  input.signal.throwIfAborted();
  try {
    const bytes = await readExactSessionBytes(
      input.project,
      input.sessionId,
      input.signal,
    );
    if (bytes === undefined) {
      return unavailable(
        'source_unavailable',
        'The exact Claude session is unavailable.',
      );
    }
    const records = parseJsonl(
      Buffer.from(bytes).toString('utf8'),
      input.signal,
    );
    const converted = recordsToAtif(records, input);
    return {
      kind: 'available',
      // Adapters classify source parsing/normalization failures. The engine
      // authoritatively parses this fresh projection again at its trust boundary.
      trajectory: parseAtifTrajectory(converted.trajectory),
      source: {
        kind: 'native_log',
        format: 'claude-code-jsonl',
        sessionId: input.sessionId,
      },
      warnings: converted.warnings,
    };
  } catch (error) {
    if (input.signal.aborted) input.signal.throwIfAborted();
    const code =
      error instanceof ClaudeSessionLimitError ||
      error instanceof ClaudeSessionIncompleteError
        ? 'source_incomplete'
        : 'source_invalid';
    return unavailable(code, safeSessionFailure(error));
  }
}

/**
 * Preserve understood content from the exact session after strict normalization
 * fails. This API never produces an available or score-bearing candidate.
 * Callers own redaction and archival policy, including partial completeness.
 */
export async function recoverClaudeEvidence(
  input: LoadClaudeEvidenceInput,
): Promise<ClaudeEvidenceRecoveryResult> {
  input.signal.throwIfAborted();
  if (!input.project || !isSafeSessionId(input.sessionId)) {
    return unavailable(
      'source_unavailable',
      'The exact Claude session is unavailable.',
    );
  }
  try {
    const bytes = await readExactSessionBytes(
      input.project,
      input.sessionId,
      input.signal,
    );
    if (bytes === undefined) {
      return unavailable(
        'source_unavailable',
        'The exact Claude session is unavailable.',
      );
    }
    const omissions: RecoveryOmissions = new Map();
    const records = parseJsonl(
      Buffer.from(bytes).toString('utf8'),
      input.signal,
      omissions,
    );
    const converted = recordsToAtif(records, input, omissions);
    const trajectory = parseAtifTrajectory(converted.trajectory);
    input.signal.throwIfAborted();
    return {
      kind: 'recovered',
      trajectory,
      source: {
        kind: 'native_log',
        format: 'claude-code-jsonl',
        sessionId: input.sessionId,
      },
      warnings: [
        {
          code: 'source_incomplete',
          message:
            'Recovered Claude evidence is preservation-only; complete conversation coverage is not established.',
        },
        ...aggregateRecoveryWarnings(converted.warnings),
        ...recoveryWarnings(omissions),
      ],
    };
  } catch (error) {
    if (input.signal.aborted) input.signal.throwIfAborted();
    return unavailable(
      error instanceof ClaudeSessionLimitError ||
        error instanceof ClaudeSessionIncompleteError
        ? 'source_incomplete'
        : 'source_invalid',
      safeSessionFailure(error),
    );
  }
}

async function readExactSessionBytes(
  project: ReadonlyWorkspace,
  sessionId: string,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  signal.throwIfAborted();
  const relativePath = `${sessionId}.jsonl`;
  const entry = await project.inspect(relativePath);
  if (entry.kind !== 'file') return undefined;
  const bytes = await project.readFile(relativePath, {
    maxBytes: MAX_SESSION_BYTES,
  });
  signal.throwIfAborted();
  if (bytes.byteLength > MAX_SESSION_BYTES) {
    throw new ClaudeSessionLimitError(
      'Claude session exceeded its byte limit.',
    );
  }
  return bytes;
}

function recordsToAtif(
  records: readonly LocatedSessionRecord[],
  input: LoadClaudeEvidenceInput,
  recoveryOmissions?: RecoveryOmissions,
): {
  trajectory: AtifTrajectoryV1_8;
  warnings: AgentNativeEvidenceWarning[];
} {
  const steps: AtifStep[] = [];
  const warnings: AgentNativeEvidenceWarning[] = [];
  const bookkeepingOmissions: BookkeepingOmissions = new Map();
  const nativeToolCallCounts = recoveryOmissions
    ? recoveryToolCallCounts(records, input.sessionId)
    : undefined;
  let reportedSessionId: string | undefined;
  let lastAgentStep: AtifAgentStep | undefined;
  const toolStepsByCallId = new Map<string, AtifAgentStep>();

  // Commit steps, call identities, and observations together only after a
  // complete record converts. Omitting a failed record cannot alter prior steps.
  let pendingSteps: AtifStep[] = [];
  let pendingToolSteps = new Map<string, AtifAgentStep>();
  let pendingObservations = new Map<AtifAgentStep, AtifObservationResult[]>();
  let pendingLastAgentStep: AtifAgentStep | undefined;
  const addStep = (step: Omit<AtifStep, 'step_id'>): void => {
    const completed = {
      ...step,
      step_id: steps.length + pendingSteps.length + 1,
    } as AtifStep;
    if (completed.source === 'agent') {
      const callIds = new Set<string>();
      for (const call of completed.tool_calls ?? []) {
        if (
          toolStepsByCallId.has(call.tool_call_id) ||
          pendingToolSteps.has(call.tool_call_id) ||
          callIds.has(call.tool_call_id)
        ) {
          throw new ClaudeSessionIncompleteError(
            'A Claude tool-call identity was reused across native steps.',
          );
        }
        callIds.add(call.tool_call_id);
      }
      for (const call of completed.tool_calls ?? []) {
        // Generated IDs represent missing native identities and cannot establish
        // an explicit link from a later native tool result.
        if (
          !nativeToolCallCounts ||
          nativeToolCallCounts.get(call.tool_call_id) === 1
        ) {
          pendingToolSteps.set(call.tool_call_id, completed);
        }
      }
    }
    pendingSteps.push(completed);
    pendingLastAgentStep = completed.source === 'agent' ? completed : undefined;
  };
  const addObservation = (
    step: AtifAgentStep,
    result: AtifObservationResult,
  ): void => {
    const pending = pendingObservations.get(step) ?? [];
    pending.push(result);
    pendingObservations.set(step, pending);
  };

  for (const [position, located] of records.entries()) {
    const { line } = located;
    let { record } = located;
    const recordIndex = line - 1;
    input.signal.throwIfAborted();
    if (record === undefined) {
      lastAgentStep = undefined;
      continue;
    }
    if (
      record.isCompactSummary === true ||
      record.subtype === 'compact_boundary'
    ) {
      throw incompleteRecord(
        record,
        recordIndex,
        'Claude compaction may replace earlier turns; complete conversation coverage cannot be established.',
      );
    }
    if (record.isSidechain === true) {
      throw new ClaudeSessionIncompleteError(
        'Sidechain records are not supported in a primary Claude trajectory.',
      );
    }
    const recordSessionId = record.sessionId ?? record.session_id;
    if (typeof recordSessionId === 'string') {
      reportedSessionId ??= recordSessionId;
      if (recordSessionId !== input.sessionId) {
        throw new Error(
          'Claude session identity changed inside its native log.',
        );
      }
    }
    const omissionCount = recoveryOmissionCount(recoveryOmissions);
    const bookkeepingCount = recoveryOmissionCount(bookkeepingOmissions);
    if (recoveryOmissions && nativeToolCallCounts) {
      record = recoverConversationBlocks(
        record,
        nativeToolCallCounts,
        recoveryOmissions,
        line,
      );
    }
    if (record === undefined) {
      lastAgentStep = undefined;
      continue;
    }
    const omittedBlocks =
      recoveryOmissionCount(recoveryOmissions) !== omissionCount;
    pendingSteps = [];
    pendingToolSteps = new Map();
    pendingObservations = new Map();
    pendingLastAgentStep = omittedBlocks ? undefined : lastAgentStep;
    const warningCount = warnings.length;
    try {
      if (record.type === 'user') {
        const content = record.message?.content;
        if (record.isMeta === true) {
          if (Array.isArray(content)) {
            attachToolResults(
              pendingLastAgentStep,
              toolStepsByCallId,
              content.filter((block) => block.type === 'tool_result'),
              warnings,
              recordIndex,
              addObservation,
              recoveryOmissions !== undefined,
            );
          }
        } else {
          if (typeof content === 'string') {
            addStep({
              source: 'user',
              message: content,
              ...timestampField(record.timestamp, warnings, recordIndex),
            });
          } else if (Array.isArray(content)) {
            assertSupportedUserBlocks(content);
            const toolResults = content.filter(
              (block) => block.type === 'tool_result',
            );
            attachToolResults(
              pendingLastAgentStep,
              toolStepsByCallId,
              toolResults,
              warnings,
              recordIndex,
              addObservation,
              recoveryOmissions !== undefined,
            );
            const userText = content
              .filter(
                (block) =>
                  block.type === 'text' && typeof block.text === 'string',
              )
              .map((block) => block.text as string)
              .join('\n');
            if (userText) {
              addStep({
                source: 'user',
                message: userText,
                ...timestampField(record.timestamp, warnings, recordIndex),
              });
            }
          } else {
            throw new ClaudeSessionIncompleteError(
              'A Claude user record had unsupported conversation content.',
            );
          }
        }
      } else if (record.type === 'assistant') {
        const content = record.message?.content;
        if (
          content !== undefined &&
          typeof content !== 'string' &&
          !Array.isArray(content)
        ) {
          throw new ClaudeSessionIncompleteError(
            'A Claude assistant record had unsupported conversation content.',
          );
        }
        const blocks =
          typeof content === 'string'
            ? [{ type: 'text', text: content }]
            : Array.isArray(content)
              ? content
              : [];
        assertSupportedAssistantBlocks(blocks, warnings, recordIndex);
        const text = blocks
          .filter(
            (block) => block.type === 'text' && typeof block.text === 'string',
          )
          .map((block) => block.text as string)
          .join('\n');
        const reasoning = blocks
          .filter(
            (block) =>
              block.type === 'thinking' && typeof block.thinking === 'string',
          )
          .map((block) => block.thinking as string)
          .join('\n');
        const toolCalls = blocks
          .filter(
            (block) =>
              block.type === 'tool_use' && typeof block.name === 'string',
          )
          .map(
            (block, index): AtifToolCall => ({
              tool_call_id:
                typeof block.id === 'string'
                  ? block.id
                  : recoveredCallId(
                      steps.length + pendingSteps.length + 1,
                      index + 1,
                      nativeToolCallCounts,
                    ),
              function_name: block.name as string,
              arguments: jsonObject(
                block.input,
                warnings,
                `line:${recordIndex + 1}`,
              ),
            }),
          );
        addStep({
          source: 'agent',
          model_name: input.model,
          message: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...timestampField(record.timestamp, warnings, recordIndex),
        });
      } else if (record.type !== undefined) {
        handleNonConversationRecord(
          record,
          records[position + 1]?.record,
          warnings,
          bookkeepingOmissions,
          recordIndex,
          addStep,
        );
      } else {
        throw new ClaudeSessionIncompleteError(
          'A Claude session record did not identify its type.',
        );
      }
      for (const [step, results] of pendingObservations) {
        step.observation ??= { results: [] };
        for (const result of results) step.observation.results.push(result);
      }
      steps.push(...pendingSteps);
      for (const [id, step] of pendingToolSteps)
        toolStepsByCallId.set(id, step);
      const omittedContent =
        omittedBlocks ||
        (recoveryOmissions !== undefined &&
          (warnings.length > warningCount ||
            recoveryOmissionCount(bookkeepingOmissions) > bookkeepingCount));
      lastAgentStep = omittedContent ? undefined : pendingLastAgentStep;
    } catch (error) {
      if (!recoveryOmissions || input.signal.aborted) throw error;
      warnings.length = warningCount;
      recordRecoveryOmission(recoveryOmissions, 'records', line);
      lastAgentStep = undefined;
    }
  }

  if (
    reportedSessionId !== undefined &&
    reportedSessionId !== input.sessionId
  ) {
    throw new Error('Claude session ID does not match the selected session.');
  }
  if (
    recoveryOmissions
      ? steps.length === 0
      : !steps.some(({ source }) => source === 'user') ||
        !steps.some(({ source }) => source === 'agent')
  ) {
    throw new Error('Claude session contains no complete conversation.');
  }
  return {
    trajectory: {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: input.sessionId,
      agent: {
        name: 'claude-code',
        version: input.agentVersion,
        model_name: input.model,
      },
      steps,
    },
    warnings: [
      ...warnings,
      ...Array.from(
        bookkeepingOmissions,
        ([kind, { count, firstLine }]): AgentNativeEvidenceWarning => ({
          code: 'unsupported_native_event',
          message: `${BOOKKEEPING_OMISSION_MESSAGES[kind]} (records: ${count}).`,
          path: `line:${firstLine}`,
        }),
      ),
    ],
  };
}

function assertSupportedUserBlocks(blocks: readonly SessionBlock[]): void {
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new ClaudeSessionIncompleteError(
        'A Claude user record contained an invalid conversation block.',
      );
    }
    if (block.type === 'tool_result') continue;
    if (block.type === 'text' && typeof block.text === 'string') continue;
    throw new ClaudeSessionIncompleteError(
      'A Claude user record contained an unsupported conversation block.',
    );
  }
}

function assertSupportedAssistantBlocks(
  blocks: readonly SessionBlock[],
  warnings: AgentNativeEvidenceWarning[],
  recordIndex: number,
): void {
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new ClaudeSessionIncompleteError(
        'A Claude assistant record contained an invalid conversation block.',
      );
    }
    if (block.type === 'text' && typeof block.text === 'string') continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string')
      continue;
    if (block.type === 'tool_use' && typeof block.name === 'string') continue;
    if (block.type === 'redacted_thinking') {
      warnings.push({
        code: 'unsupported_native_event',
        message: 'A redacted Claude reasoning block was omitted.',
        path: `line:${recordIndex + 1}`,
      });
      continue;
    }
    throw new ClaudeSessionIncompleteError(
      'A Claude assistant record contained an unsupported conversation block.',
    );
  }
}

function attachToolResults(
  fallbackStep: AtifAgentStep | undefined,
  toolStepsByCallId: ReadonlyMap<string, AtifAgentStep>,
  blocks: readonly SessionBlock[],
  warnings: AgentNativeEvidenceWarning[],
  recordIndex: number,
  addObservation: (step: AtifAgentStep, result: AtifObservationResult) => void,
  resetFallbackOnOmission: boolean,
): void {
  if (blocks.length === 0) return;
  for (const block of blocks) {
    const requestedCallId =
      typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
    const matchedStep =
      requestedCallId === undefined
        ? undefined
        : toolStepsByCallId.get(requestedCallId);
    if (requestedCallId !== undefined && matchedStep === undefined) {
      warnings.push({
        code: 'value_omitted',
        message: 'A Claude tool result referenced an unknown ATIF tool call.',
        path: `line:${recordIndex + 1}`,
      });
      if (resetFallbackOnOmission) fallbackStep = undefined;
      continue;
    }
    const step = matchedStep ?? fallbackStep;
    const result: AtifObservationResult = {
      ...(matchedStep === undefined || requestedCallId === undefined
        ? {}
        : { source_call_id: requestedCallId }),
      content: nativeContent(block.content),
      ...(block.is_error === undefined
        ? {}
        : { extra: { is_error: block.is_error } }),
    };
    if (!step) {
      warnings.push({
        code: 'value_omitted',
        message: 'Claude tool results appeared without a preceding agent step.',
        path: `line:${recordIndex + 1}`,
      });
      continue;
    }
    addObservation(step, result);
  }
}

function parseJsonl(
  raw: string,
  signal: AbortSignal,
  recoveryOmissions?: RecoveryOmissions,
): LocatedSessionRecord[] {
  const records: LocatedSessionRecord[] = [];
  let lineStart = 0;
  let lineCount = 0;
  for (let end = 0; end <= raw.length; end += 1) {
    if (end !== raw.length && raw.charCodeAt(end) !== 10) continue;
    signal.throwIfAborted();
    lineCount += 1;
    if (lineCount > MAX_SESSION_LINES) {
      throw new ClaudeSessionLimitError(
        'Claude session exceeded its line limit.',
      );
    }
    const line = raw.slice(lineStart, end);
    lineStart = end + 1;
    if (Buffer.byteLength(line, 'utf8') > MAX_SESSION_LINE_BYTES) {
      throw new ClaudeSessionLimitError(
        'Claude session contained an oversized line.',
      );
    }
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (recoveryOmissions) {
        recordRecoveryOmission(recoveryOmissions, 'invalid_lines', lineCount);
        records.push({ record: undefined, line: lineCount });
        continue;
      }
      throw new Error('Claude session contains malformed JSONL.');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      if (recoveryOmissions) {
        recordRecoveryOmission(recoveryOmissions, 'invalid_lines', lineCount);
        records.push({ record: undefined, line: lineCount });
        continue;
      }
      throw new Error('Claude session contains a non-object record.');
    }
    if (recoveryOmissions) {
      // Native bytes remain bounded before this preflight. Unsafe JSON graphs
      // are fatal even when their record would otherwise be omitted.
      try {
        assertBoundedJsonValue(value);
      } catch {
        throw new ClaudeSessionLimitError(
          'Claude session contained unsafe JSON.',
        );
      }
    }
    records.push({ record: value as SessionRecord, line: lineCount });
  }
  return records;
}

function recordRecoveryOmission(
  omissions: RecoveryOmissions,
  kind: RecoveryOmissionKind,
  line: number,
): void {
  const previous = omissions.get(kind);
  omissions.set(kind, {
    count: (previous?.count ?? 0) + 1,
    firstLine: previous?.firstLine ?? line,
  });
}

function recoveryOmissionCount(
  omissions: ReadonlyMap<string, BookkeepingOmission> | undefined,
): number {
  return Array.from(omissions?.values() ?? []).reduce(
    (total, { count }) => total + count,
    0,
  );
}

function recoveryWarnings(
  omissions: RecoveryOmissions,
): AtifNormalizationWarning[] {
  const messages: Record<RecoveryOmissionKind, string> = {
    invalid_lines:
      'Malformed or non-object Claude JSONL lines were omitted from recovered ATIF',
    records: 'Unsupported Claude records were omitted from recovered ATIF',
    blocks:
      'Unsupported or ambiguous Claude conversation blocks were omitted from recovered ATIF',
  };
  return Array.from(omissions, ([kind, { count, firstLine }]) => ({
    code: kind === 'invalid_lines' ? 'source_invalid' : 'source_incomplete',
    message: `${messages[kind]} (count: ${count}).`,
    path: `line:${firstLine}`,
  }));
}

function aggregateRecoveryWarnings(
  warnings: readonly AgentNativeEvidenceWarning[],
): AtifNormalizationWarning[] {
  const aggregated = new Map<
    string,
    { warning: AgentNativeEvidenceWarning; count: number }
  >();
  for (const warning of warnings) {
    const key = `${warning.code}:${warning.message}`;
    const previous = aggregated.get(key);
    aggregated.set(key, {
      warning: previous?.warning ?? warning,
      count: (previous?.count ?? 0) + 1,
    });
  }
  return Array.from(aggregated.values(), ({ warning, count }) => ({
    ...warning,
    message:
      count === 1
        ? warning.message
        : `${warning.message} (occurrences: ${count}).`,
  }));
}

/** Validate attribution before omitting anything, including unknown records. */
function recoveryToolCallCounts(
  records: readonly LocatedSessionRecord[],
  sessionId: string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { record } of records) {
    if (record === undefined) continue;
    for (const id of [record.sessionId, record.session_id]) {
      if (id !== undefined && id !== sessionId) {
        throw new Error(
          'Claude session identity changed inside its native log.',
        );
      }
    }
    if (record.type !== 'assistant' || !Array.isArray(record.message?.content))
      continue;
    for (const block of record.message.content) {
      if (
        plainRecord(block)?.type === 'tool_use' &&
        typeof block.id === 'string'
      ) {
        counts.set(block.id, (counts.get(block.id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function recoveredCallId(
  step: number,
  call: number,
  nativeIds: ReadonlyMap<string, number> | undefined,
): string {
  let id = `claude-call-${step}-${call}`;
  while (nativeIds?.has(id)) id = `${id}-generated`;
  return id;
}

/** Keep understood blocks; unknown blocks cannot establish implicit tool links. */
function recoverConversationBlocks(
  record: SessionRecord,
  nativeCallCounts: ReadonlyMap<string, number>,
  omissions: RecoveryOmissions,
  line: number,
): SessionRecord | undefined {
  if (record.type !== 'user' && record.type !== 'assistant') return record;
  const content = record.message?.content;
  if (typeof content === 'string') return record;
  if (!Array.isArray(content)) {
    recordRecoveryOmission(omissions, 'records', line);
    return undefined;
  }
  const blocks = content.filter((block) => {
    let supported = false;
    if (plainRecord(block) !== undefined) {
      supported =
        (block.type === 'text' && typeof block.text === 'string') ||
        (record.type === 'assistant' &&
          ((block.type === 'thinking' && typeof block.thinking === 'string') ||
            block.type === 'redacted_thinking' ||
            (block.type === 'tool_use' &&
              typeof block.name === 'string' &&
              block.name.length > 0 &&
              (block.id === undefined ||
                (typeof block.id === 'string' &&
                  block.id.length > 0 &&
                  nativeCallCounts.get(block.id) === 1))))) ||
        (record.type === 'user' &&
          block.type === 'tool_result' &&
          (block.tool_use_id === undefined ||
            (typeof block.tool_use_id === 'string' &&
              block.tool_use_id.length > 0 &&
              nativeCallCounts.get(block.tool_use_id) === 1)) &&
          (block.is_error === undefined ||
            typeof block.is_error === 'boolean'));
    }
    if (!supported) recordRecoveryOmission(omissions, 'blocks', line);
    return supported;
  });
  if (
    record.type === 'assistant' &&
    blocks.every((block) => block.type === 'redacted_thinking')
  ) {
    recordRecoveryOmission(omissions, 'records', line);
    return undefined;
  }
  return { ...record, message: { ...record.message, content: blocks } };
}

class ClaudeSessionLimitError extends Error {}
class ClaudeSessionIncompleteError extends Error {
  constructor(
    message: string,
    readonly location?: { line: number; kind: string },
  ) {
    super(message);
  }
}

function jsonObject(
  value: unknown,
  warnings: AgentNativeEvidenceWarning[],
  path: string,
): JsonObject {
  const json = jsonValue(value);
  if (json !== null && typeof json === 'object' && !Array.isArray(json))
    return json;
  if (value !== undefined) {
    warnings.push({
      code: 'value_omitted',
      message: 'A non-object Claude tool input was wrapped for ATIF.',
      path,
    });
  }
  return value === undefined ? {} : { value: json };
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    return JSON.parse(encoded) as JsonValue;
  } catch {
    return null;
  }
}

function nativeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  const json = jsonValue(value);
  return JSON.stringify(json);
}

function timestampField(
  value: string | undefined,
  warnings: AgentNativeEvidenceWarning[],
  recordIndex: number,
): { timestamp?: string } {
  if (value === undefined) return {};
  if (isAtifTimestamp(value)) return { timestamp: value };
  warnings.push({
    code: 'value_omitted',
    message: 'An invalid Claude timestamp was omitted.',
    path: `line:${recordIndex + 1}`,
  });
  return {};
}

function handleNonConversationRecord(
  record: SessionRecord,
  nextRecord: SessionRecord | undefined,
  warnings: AgentNativeEvidenceWarning[],
  bookkeepingOmissions: BookkeepingOmissions,
  recordIndex: number,
  addStep: (step: Omit<AtifStep, 'step_id'>) => void,
): void {
  if (IGNORED_RECORD_TYPES.has(record.type ?? '')) {
    return;
  }
  if (record.type === 'atis-latch') {
    const latch = plainRecord(record);
    if (
      latch !== undefined &&
      hasExactKeys(latch, ['type', 'atis', 'sessionId']) &&
      record.atis === '' &&
      typeof record.sessionId === 'string'
    ) {
      return;
    }
    throw incompleteRecord(
      record,
      recordIndex,
      'A Claude ATIS latch record had an unsupported shape.',
    );
  }
  if (
    record.type === 'system' &&
    IGNORED_SYSTEM_SUBTYPES.has(record.subtype ?? '')
  ) {
    return;
  }
  if (
    record.type === 'system' &&
    record.subtype === 'api_error' &&
    record.source === 'request_retry'
  ) {
    return;
  }
  if (record.type === 'attachment') {
    const attachment = plainRecord(record.attachment);
    if (attachment === undefined) {
      throw incompleteRecord(
        record,
        recordIndex,
        'A Claude attachment did not identify a supported type.',
      );
    }
    const attachmentType = attachment.type;
    if (
      typeof attachmentType !== 'string' ||
      !SAFE_ATTACHMENT_TYPE.test(attachmentType)
    ) {
      throw incompleteRecord(
        record,
        recordIndex,
        'A Claude attachment did not identify a supported type.',
      );
    }
    if (attachmentType === 'queued_command') {
      addQueuedCommand(record, attachment, warnings, recordIndex, addStep);
      return;
    }
    if (attachmentType === 'batching_reminder_sent') {
      if (
        !hasExactKeys(attachment, ['type', 'model', 'text']) ||
        typeof attachment.model !== 'string' ||
        typeof attachment.text !== 'string' ||
        (record.rendered !== undefined &&
          (!Array.isArray(record.rendered) || record.rendered.length !== 0))
      ) {
        throw incompleteRecord(
          record,
          recordIndex,
          'A Claude batching reminder had unrepresented content.',
        );
      }
      recordBookkeepingOmission(
        bookkeepingOmissions,
        'batching_reminder_sent',
        recordIndex + 1,
      );
      return;
    }
    if (attachmentType === 'hook_success') {
      if (hasPairedHookContext(record, nextRecord)) return;
      throw incompleteRecord(
        record,
        recordIndex,
        'A Claude hook-success attachment had unrepresented content.',
      );
    }

    let rendered: string[];
    try {
      rendered = renderedAttachmentContent(record.rendered);
    } catch (error) {
      if (error instanceof ClaudeSessionIncompleteError) {
        throw incompleteRecord(record, recordIndex, error.message);
      }
      throw error;
    }
    if (rendered.length > 0) {
      const timestamp = timestampField(record.timestamp, warnings, recordIndex);
      for (const message of rendered) {
        const step: Omit<AtifSystemStep, 'step_id'> = {
          source: 'system',
          message,
          extra: {
            native_record_type: 'attachment',
            attachment_type: attachmentType,
          },
          ...timestamp,
        };
        addStep(step);
      }
      return;
    }

    if (attachmentType === 'session_context') {
      const context = plainRecord(attachment.context);
      if (
        hasExactKeys(attachment, ['type', 'context']) &&
        context !== undefined &&
        Object.keys(context).length === 0
      ) {
        return;
      }
      throw incompleteRecord(
        record,
        recordIndex,
        'A Claude session-context attachment had unrepresented content.',
      );
    }

    if (attachmentType === 'prompt_snapshot') {
      if (!isPromptSnapshot(attachment)) {
        throw incompleteRecord(
          record,
          recordIndex,
          'A Claude prompt snapshot had an unsupported shape.',
        );
      }
      warnings.push({
        code: 'unsupported_native_event',
        message:
          'Claude prompt snapshot detail was retained only in native evidence.',
        path: `line:${recordIndex + 1}`,
      });
      return;
    }

    if (OMITTED_ATTACHMENT_TYPES.has(attachmentType)) {
      warnings.push({
        code: 'unsupported_native_event',
        message: 'Known Claude attachment context was omitted from ATIF.',
        path: `line:${recordIndex + 1}`,
      });
      return;
    }
  }
  throw incompleteRecord(
    record,
    recordIndex,
    'A Claude session contained an unsupported conversation record.',
  );
}

function recordBookkeepingOmission(
  omissions: BookkeepingOmissions,
  kind: BookkeepingRecordType,
  line: number,
): void {
  const previous = omissions.get(kind);
  omissions.set(kind, {
    count: (previous?.count ?? 0) + 1,
    firstLine: previous?.firstLine ?? line,
  });
}

function addQueuedCommand(
  record: SessionRecord,
  attachment: Readonly<Record<string, unknown>>,
  warnings: AgentNativeEvidenceWarning[],
  recordIndex: number,
  addStep: (step: Omit<AtifStep, 'step_id'>) => void,
): void {
  let rendered: string[];
  try {
    rendered = renderedAttachmentContent(record.rendered);
  } catch {
    throw incompleteRecord(
      record,
      recordIndex,
      'A Claude queued command had unsupported rendered content.',
    );
  }
  if (
    !hasExactKeys(attachment, ['type', 'commandMode', 'prompt', 'timestamp']) ||
    typeof attachment.prompt !== 'string' ||
    attachment.prompt.length === 0 ||
    typeof attachment.timestamp !== 'string' ||
    rendered.length !== 1
  ) {
    throw incompleteRecord(
      record,
      recordIndex,
      'A Claude queued command had an unsupported shape.',
    );
  }
  const extra = {
    native_record_type: 'attachment',
    attachment_type: 'queued_command',
  };
  const timestamp = timestampField(record.timestamp, warnings, recordIndex);
  if (
    attachment.commandMode === 'task-notification' &&
    rendered[0] !== undefined &&
    isRenderedTaskNotification(attachment.prompt, rendered[0])
  ) {
    addStep({ source: 'system', message: rendered[0], extra, ...timestamp });
    return;
  }
  throw incompleteRecord(
    record,
    recordIndex,
    'A Claude queued command could not be represented faithfully.',
  );
}

function isRenderedTaskNotification(prompt: string, rendered: string): boolean {
  const reminderStart = '<system-reminder>\n';
  const reminderEnd = '\n</system-reminder>';
  const notificationStart = '<task-notification>';
  const notificationEnd = '</task-notification>';
  const start = rendered.indexOf(notificationStart);
  const end = rendered.indexOf(notificationEnd, start);
  return (
    rendered.startsWith(reminderStart) &&
    start >= reminderStart.length &&
    rendered[start - 1] === '\n' &&
    rendered.indexOf(notificationStart, start + notificationStart.length) ===
      -1 &&
    end >= start &&
    rendered.slice(start, end + notificationEnd.length) === prompt &&
    rendered.slice(end + notificationEnd.length) === reminderEnd
  );
}

/** Accept a hook outcome only when its entire context is in the next rendered record. */
function hasPairedHookContext(
  record: SessionRecord,
  nextRecord: SessionRecord | undefined,
): boolean {
  const envelope = plainRecord(record);
  const attachment = plainRecord(record.attachment);
  const nextEnvelope = plainRecord(nextRecord);
  const nextAttachment = plainRecord(nextRecord?.attachment);
  if (
    envelope === undefined ||
    nextEnvelope === undefined ||
    !hasOnlyKeys(envelope, HOOK_ATTACHMENT_RECORD_KEYS) ||
    !hasOnlyKeys(nextEnvelope, HOOK_ATTACHMENT_RECORD_KEYS) ||
    record.rendered !== undefined ||
    nextRecord?.type !== 'attachment' ||
    typeof record.sessionId !== 'string' ||
    nextRecord.sessionId !== record.sessionId ||
    attachment === undefined ||
    nextAttachment === undefined ||
    !hasExactKeys(attachment, [
      'type',
      'command',
      'content',
      'durationMs',
      'exitCode',
      'hookEvent',
      'hookName',
      'stderr',
      'stdout',
      'toolUseID',
    ]) ||
    !hasExactKeys(nextAttachment, [
      'type',
      'content',
      'hookEvent',
      'hookName',
      'toolUseID',
    ]) ||
    nextAttachment.type !== 'hook_additional_context' ||
    typeof attachment.command !== 'string' ||
    attachment.content !== '' ||
    typeof attachment.durationMs !== 'number' ||
    !Number.isFinite(attachment.durationMs) ||
    attachment.durationMs < 0 ||
    attachment.exitCode !== 0 ||
    typeof attachment.hookEvent !== 'string' ||
    attachment.hookEvent.length === 0 ||
    typeof attachment.hookName !== 'string' ||
    attachment.stderr !== '' ||
    typeof attachment.stdout !== 'string' ||
    typeof attachment.toolUseID !== 'string' ||
    nextAttachment.hookEvent !== attachment.hookEvent ||
    typeof nextAttachment.hookName !== 'string' ||
    typeof nextAttachment.toolUseID !== 'string'
  ) {
    return false;
  }

  let stdout: unknown;
  try {
    stdout = JSON.parse(attachment.stdout);
  } catch {
    return false;
  }
  const output = plainRecord(stdout);
  const hookOutput = plainRecord(output?.hookSpecificOutput);
  // Captured Claude sessions use different hook names and tool-use IDs for
  // these records. Match the event and exact context instead of those labels.
  if (
    output === undefined ||
    !hasExactKeys(output, ['hookSpecificOutput']) ||
    hookOutput === undefined ||
    !hasExactKeys(hookOutput, ['hookEventName', 'additionalContext']) ||
    hookOutput.hookEventName !== attachment.hookEvent ||
    typeof hookOutput.additionalContext !== 'string' ||
    hookOutput.additionalContext.length === 0 ||
    !Array.isArray(nextAttachment.content) ||
    nextAttachment.content.length !== 1 ||
    nextAttachment.content[0] !== hookOutput.additionalContext
  ) {
    return false;
  }

  const rendered = nextRecord.rendered;
  if (!Array.isArray(rendered) || rendered.length !== 1) return false;
  const renderedPart = plainRecord(rendered[0]);
  return (
    renderedPart !== undefined &&
    hasExactKeys(renderedPart, ['content']) &&
    typeof renderedPart.content === 'string' &&
    renderedPart.content.includes(hookOutput.additionalContext)
  );
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function incompleteRecord(
  record: SessionRecord,
  recordIndex: number,
  message: string,
): ClaudeSessionIncompleteError {
  return new ClaudeSessionIncompleteError(message, {
    line: recordIndex + 1,
    kind: safeRecordKind(record),
  });
}

/** Diagnostic labels are literals, never untrusted native field values. */
function safeRecordKind(record: SessionRecord): string {
  if (record.isCompactSummary === true) return 'compact summary';
  if (record.subtype === 'compact_boundary') return 'system/compact_boundary';
  if (record.type === 'attachment') {
    const attachmentType = plainRecord(record.attachment)?.type;
    switch (attachmentType) {
      case 'hook_success':
      case 'queued_command':
      case 'session_context':
      case 'prompt_snapshot':
      case 'batching_reminder_sent':
        return `attachment/${attachmentType}`;
      default:
        return 'attachment';
    }
  }
  switch (record.type) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'atis-latch':
      return record.type;
    default:
      return 'unrecognized record';
  }
}

function renderedAttachmentContent(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RENDERED_ATTACHMENT_PARTS) {
    throw new ClaudeSessionIncompleteError(
      'A Claude attachment had unsupported rendered content.',
    );
  }
  return value.map((part) => {
    const record = plainRecord(part);
    if (record === undefined || typeof record.content !== 'string') {
      throw new ClaudeSessionIncompleteError(
        'A Claude attachment had unsupported rendered content.',
      );
    }
    return record.content;
  });
}

function isPromptSnapshot(value: Readonly<Record<string, unknown>>): boolean {
  const systemPrompt = value.systemPrompt;
  const cliPrefix = value.cliPrefix;
  const tools = value.tools;
  return (
    (hasExactKeys(value, ['type', 'systemPrompt']) ||
      hasExactKeys(value, ['type', 'systemPrompt', 'cliPrefix', 'tools'])) &&
    Array.isArray(systemPrompt) &&
    systemPrompt.every((part) => typeof part === 'string') &&
    (cliPrefix === undefined ||
      cliPrefix === null ||
      typeof cliPrefix === 'string') &&
    (tools === undefined ||
      tools === null ||
      (Array.isArray(tools) &&
        tools.every((tool) => plainRecord(tool) !== undefined)))
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

function safeSessionFailure(error: unknown): string {
  if (error instanceof ClaudeSessionLimitError) {
    return 'Claude session evidence exceeded a safety limit.';
  }
  if (error instanceof ClaudeSessionIncompleteError && error.location) {
    if (
      error.location.kind === 'compact summary' ||
      error.location.kind === 'system/compact_boundary'
    ) {
      return `Claude compaction may replace earlier turns; complete conversation coverage cannot be established (${error.location.kind} at line ${error.location.line}).`;
    }
    return `Claude session evidence could not be normalized safely (${error.location.kind} at line ${error.location.line}).`;
  }
  return 'Claude session evidence could not be normalized safely.';
}
