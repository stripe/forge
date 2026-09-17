import {
  ATIF_SCHEMA_VERSION,
  isAtifTimestamp,
  parseAtifTrajectory,
  type AtifAgentStep,
  type AtifObservationResult,
  type AtifStep,
  type AtifTrajectoryV1_8,
  type AtifToolCall,
  type JsonObject,
  type JsonValue,
} from '../../atif/index.js';
import type {
  AgentNativeEvidenceResult,
  AgentNativeEvidenceWarning,
} from '../../contracts/agent.js';
import type {ReadonlyWorkspace} from '../../contracts/runtime.js';
import {isSafeSessionId} from './stream.js';

const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_LINES = 100_000;
const MAX_SESSION_LINE_BYTES = 1024 * 1024;
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
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'stop_hook_summary',
  'turn_duration',
]);
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
  timestamp?: string;
  sessionId?: string;
  session_id?: string;
  isCompactSummary?: boolean;
  isMeta?: boolean;
  isSidechain?: boolean;
  attachment?: {type?: string};
  message?: {content?: string | SessionBlock[]};
}

export interface LoadClaudeEvidenceInput {
  readonly project: ReadonlyWorkspace | undefined;
  readonly sessionId: string;
  readonly agentVersion: string;
  readonly model: string;
  readonly signal: AbortSignal;
}

/** Load and normalize exact native evidence; Forge's engine owns fallback selection. */
export async function loadClaudeEvidence(
  input: LoadClaudeEvidenceInput,
): Promise<AgentNativeEvidenceResult> {
  const unavailable = (
    code: 'source_unavailable' | 'source_invalid' | 'source_incomplete',
    message: string,
  ): AgentNativeEvidenceResult => ({kind: 'unavailable', reason: {code, message}});

  if (!input.project || !isSafeSessionId(input.sessionId)) {
    return unavailable('source_unavailable', 'The exact Claude session is unavailable.');
  }
  input.signal.throwIfAborted();
  const relativePath = `${input.sessionId}.jsonl`;
  try {
    const entry = await input.project.inspect(relativePath);
    if (entry.kind !== 'file') {
      return unavailable('source_unavailable', 'The exact Claude session is unavailable.');
    }
    const bytes = await input.project.readFile(relativePath, {
      maxBytes: MAX_SESSION_BYTES,
    });
    const records = parseJsonl(Buffer.from(bytes).toString('utf8'), input.signal);
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

function recordsToAtif(
  records: readonly SessionRecord[],
  input: LoadClaudeEvidenceInput,
): {trajectory: AtifTrajectoryV1_8; warnings: AgentNativeEvidenceWarning[]} {
  const steps: AtifStep[] = [];
  const warnings: AgentNativeEvidenceWarning[] = [];
  let reportedSessionId: string | undefined;
  let lastAgentStep: AtifAgentStep | undefined;
  const toolStepsByCallId = new Map<string, AtifAgentStep>();

  const addStep = (step: Omit<AtifStep, 'step_id'>): void => {
    const completed = {...step, step_id: steps.length + 1} as AtifStep;
    steps.push(completed);
    lastAgentStep = completed.source === 'agent' ? completed : undefined;
    if (completed.source === 'agent') {
      for (const call of completed.tool_calls ?? []) {
        if (toolStepsByCallId.has(call.tool_call_id)) {
          throw new ClaudeSessionIncompleteError(
            'A Claude tool-call identity was reused across native steps.',
          );
        }
        toolStepsByCallId.set(call.tool_call_id, completed);
      }
    }
  };

  for (const [recordIndex, record] of records.entries()) {
    input.signal.throwIfAborted();
    if (record.isCompactSummary === true || record.subtype === 'compact_boundary') {
      throw new ClaudeSessionIncompleteError(
        'Compacted Claude sessions are not supported by normalization v2.',
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
        throw new Error('Claude session identity changed inside its native log.');
      }
    }
    if (record.type === 'user') {
      const content = record.message?.content;
      if (record.isMeta === true) {
        if (Array.isArray(content)) {
          attachToolResults(
            lastAgentStep,
            toolStepsByCallId,
            content.filter((block) => block.type === 'tool_result'),
            warnings,
            recordIndex,
          );
        }
        continue;
      }
      if (typeof content === 'string') {
        addStep({
          source: 'user',
          message: content,
          ...timestampField(record.timestamp, warnings, recordIndex),
        });
      } else if (Array.isArray(content)) {
        assertSupportedUserBlocks(content);
        const toolResults = content.filter((block) => block.type === 'tool_result');
        attachToolResults(
          lastAgentStep,
          toolStepsByCallId,
          toolResults,
          warnings,
          recordIndex,
        );
        const userText = content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
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
      const blocks = typeof content === 'string'
        ? [{type: 'text', text: content}]
        : Array.isArray(content)
          ? content
          : [];
      assertSupportedAssistantBlocks(blocks, warnings, recordIndex);
      const text = blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n');
      const reasoning = blocks
        .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
        .map((block) => block.thinking as string)
        .join('\n');
      const toolCalls = blocks
        .filter((block) => block.type === 'tool_use' && typeof block.name === 'string')
        .map((block, index): AtifToolCall => ({
          tool_call_id:
            typeof block.id === 'string'
              ? block.id
              : `claude-call-${steps.length + 1}-${index + 1}`,
          function_name: block.name as string,
          arguments: jsonObject(block.input, warnings, `line:${recordIndex + 1}`),
        }));
      addStep({
        source: 'agent',
        model_name: input.model,
        message: text,
        ...(reasoning ? {reasoning_content: reasoning} : {}),
        ...(toolCalls.length > 0 ? {tool_calls: toolCalls} : {}),
        ...timestampField(record.timestamp, warnings, recordIndex),
      });
    } else if (record.type !== undefined) {
      handleNonConversationRecord(record, warnings, recordIndex);
    } else {
      throw new ClaudeSessionIncompleteError(
        'A Claude session record did not identify its type.',
      );
    }
  }

  if (reportedSessionId !== undefined && reportedSessionId !== input.sessionId) {
    throw new Error('Claude session ID does not match the selected session.');
  }
  if (!steps.some(({source}) => source === 'user') || !steps.some(({source}) => source === 'agent')) {
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
    warnings,
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
    if (block.type === 'thinking' && typeof block.thinking === 'string') continue;
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
      continue;
    }
    const step = matchedStep ?? fallbackStep;
    const result: AtifObservationResult = {
      ...(matchedStep === undefined || requestedCallId === undefined
        ? {}
        : {source_call_id: requestedCallId}),
      content: nativeContent(block.content),
      ...(block.is_error === undefined
        ? {}
        : {extra: {is_error: block.is_error}}),
    };
    if (!step) {
      warnings.push({
        code: 'value_omitted',
        message: 'Claude tool results appeared without a preceding agent step.',
        path: `line:${recordIndex + 1}`,
      });
      continue;
    }
    step.observation = {
      results: [...(step.observation?.results ?? []), result],
    };
  }
}

function parseJsonl(raw: string, signal: AbortSignal): SessionRecord[] {
  const records: SessionRecord[] = [];
  let lineStart = 0;
  let lineCount = 0;
  for (let end = 0; end <= raw.length; end += 1) {
    if (end !== raw.length && raw.charCodeAt(end) !== 10) continue;
    signal.throwIfAborted();
    lineCount += 1;
    if (lineCount > MAX_SESSION_LINES) {
      throw new ClaudeSessionLimitError('Claude session exceeded its line limit.');
    }
    const line = raw.slice(lineStart, end);
    lineStart = end + 1;
    if (Buffer.byteLength(line, 'utf8') > MAX_SESSION_LINE_BYTES) {
      throw new ClaudeSessionLimitError('Claude session contained an oversized line.');
    }
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('Claude session contains malformed JSONL.');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Claude session contains a non-object record.');
    }
    records.push(value as SessionRecord);
  }
  return records;
}

class ClaudeSessionLimitError extends Error {}
class ClaudeSessionIncompleteError extends Error {}

function jsonObject(
  value: unknown,
  warnings: AgentNativeEvidenceWarning[],
  path: string,
): JsonObject {
  const json = jsonValue(value);
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) return json;
  if (value !== undefined) {
    warnings.push({
      code: 'value_omitted',
      message: 'A non-object Claude tool input was wrapped for ATIF.',
      path,
    });
  }
  return value === undefined ? {} : {value: json};
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
): {timestamp?: string} {
  if (value === undefined) return {};
  if (isAtifTimestamp(value)) return {timestamp: value};
  warnings.push({
    code: 'value_omitted',
    message: 'An invalid Claude timestamp was omitted.',
    path: `line:${recordIndex + 1}`,
  });
  return {};
}

function handleNonConversationRecord(
  record: SessionRecord,
  warnings: AgentNativeEvidenceWarning[],
  recordIndex: number,
): void {
  if (IGNORED_RECORD_TYPES.has(record.type ?? '')) {
    return;
  }
  if (
    record.type === 'system' &&
    IGNORED_SYSTEM_SUBTYPES.has(record.subtype ?? '')
  ) {
    return;
  }
  if (record.type === 'attachment') {
    const attachmentType = record.attachment?.type;
    if (attachmentType === 'queued_command') {
      throw new ClaudeSessionIncompleteError(
        'A Claude queued-command attachment may contain an unrepresented user turn.',
      );
    }
    if (
      attachmentType !== undefined &&
      OMITTED_ATTACHMENT_TYPES.has(attachmentType)
    ) {
      warnings.push({
        code: 'unsupported_native_event',
        message: 'Known Claude attachment context was omitted from ATIF.',
        path: `line:${recordIndex + 1}`,
      });
      return;
    }
  }
  throw new ClaudeSessionIncompleteError(
    'A Claude session contained an unsupported conversation record.',
  );
}

function safeSessionFailure(error: unknown): string {
  if (error instanceof ClaudeSessionLimitError) {
    return 'Claude session evidence exceeded a safety limit.';
  }
  return 'Claude session evidence could not be normalized safely.';
}
