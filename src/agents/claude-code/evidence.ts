import {
  ATIF_SCHEMA_VERSION,
  createNormalizedTrajectory,
  isAtifTimestamp,
  type AtifAgentStep,
  type AtifNormalizationWarning,
  type AtifObservationResult,
  type AtifStep,
  type AtifTrajectoryV1_8,
  type AtifToolCall,
  type JsonObject,
  type JsonValue,
  type NormalizedTrajectory,
} from '../../atif/index.js';
import type {
  AgentEvidenceFallbackTurn,
  AgentToolCall,
} from '../../contracts/agent.js';
import type {ReadonlyWorkspace} from '../../contracts/runtime.js';
import {isSafeSessionId} from './stream.js';

const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_LINES = 100_000;
const MAX_SESSION_LINE_BYTES = 1024 * 1024;

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
  message?: {content?: string | SessionBlock[]};
}

export interface LoadClaudeEvidenceInput {
  readonly project: ReadonlyWorkspace | undefined;
  readonly sessionId: string;
  readonly fallbackTurns: readonly AgentEvidenceFallbackTurn[];
  readonly agentVersion: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly model: string;
  readonly signal: AbortSignal;
}

/** Select exact native evidence and fall back to completed driver turns safely. */
export async function loadClaudeEvidence(
  input: LoadClaudeEvidenceInput,
): Promise<NormalizedTrajectory> {
  const unavailable = async (
    code: 'source_unavailable' | 'source_invalid' | 'source_incomplete',
    message: string,
  ): Promise<NormalizedTrajectory> =>
    fallbackTrajectory(input, [
      {code, message},
      {code: 'fallback_used', message: 'Canonical ATIF was built from completed driver turns.'},
    ]);

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
    return createNormalizedTrajectory({
      trajectory: converted.trajectory,
      provenance: {
        source: {
          kind: 'native_log',
          format: 'claude-code-jsonl',
          sessionId: input.sessionId,
        },
        adapter: {id: input.adapterId, version: input.adapterVersion},
      },
      completeness: converted.warnings.length === 0 ? 'complete' : 'partial',
      warnings: converted.warnings,
    });
  } catch (error) {
    if (input.signal.aborted) input.signal.throwIfAborted();
    const code = error instanceof ClaudeSessionLimitError
      ? 'source_incomplete'
      : 'source_invalid';
    return unavailable(code, safeSessionFailure(error));
  }
}

function recordsToAtif(
  records: readonly SessionRecord[],
  input: LoadClaudeEvidenceInput,
): {trajectory: AtifTrajectoryV1_8; warnings: AtifNormalizationWarning[]} {
  const steps: AtifStep[] = [];
  const warnings: AtifNormalizationWarning[] = [];
  let reportedSessionId: string | undefined;
  let lastAgentStep: AtifAgentStep | undefined;

  const addStep = (step: Omit<AtifStep, 'step_id'>): void => {
    const completed = {...step, step_id: steps.length + 1} as AtifStep;
    steps.push(completed);
    lastAgentStep = completed.source === 'agent' ? completed : undefined;
  };

  for (const [recordIndex, record] of records.entries()) {
    input.signal.throwIfAborted();
    if (record.isCompactSummary === true || record.subtype === 'compact_boundary') {
      throw new Error('Compacted Claude sessions are not supported by normalization v1.');
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
      if (typeof content === 'string') {
        addStep({
          source: 'user',
          message: content,
          ...timestampField(record.timestamp, warnings, recordIndex),
        });
      } else if (Array.isArray(content)) {
        const toolResults = content.filter((block) => block.type === 'tool_result');
        attachToolResults(lastAgentStep, toolResults, warnings, recordIndex);
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
      }
    } else if (record.type === 'assistant') {
      const content = record.message?.content;
      const blocks = typeof content === 'string'
        ? [{type: 'text', text: content}]
        : Array.isArray(content)
          ? content
          : [];
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
    } else if (record.type && !isMetadataRecord(record.type)) {
      warnings.push({
        code: 'unsupported_native_event',
        message: 'An unsupported Claude session event was omitted.',
        path: `line:${recordIndex + 1}`,
      });
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

function attachToolResults(
  step: AtifAgentStep | undefined,
  blocks: readonly SessionBlock[],
  warnings: AtifNormalizationWarning[],
  recordIndex: number,
): void {
  if (blocks.length === 0) return;
  const callIds = new Set((step?.tool_calls ?? []).map(({tool_call_id}) => tool_call_id));
  const results: AtifObservationResult[] = blocks.map((block) => {
    const sourceId = typeof block.tool_use_id === 'string' && callIds.has(block.tool_use_id)
      ? block.tool_use_id
      : undefined;
    if (!sourceId && block.tool_use_id) {
      warnings.push({
        code: 'value_omitted',
        message: 'A Claude tool result referenced a call outside its ATIF step.',
        path: `line:${recordIndex + 1}`,
      });
    }
    return {
      ...(sourceId === undefined ? {} : {source_call_id: sourceId}),
      content: nativeContent(block.content),
      ...(block.is_error === undefined
        ? {}
        : {extra: {is_error: block.is_error}}),
    };
  });
  if (!step) {
    warnings.push({
      code: 'value_omitted',
      message: 'Claude tool results appeared without a preceding agent step.',
      path: `line:${recordIndex + 1}`,
    });
    return;
  }
  step.observation = {results};
}

function fallbackTrajectory(
  input: LoadClaudeEvidenceInput,
  warnings: readonly AtifNormalizationWarning[],
): NormalizedTrajectory {
  const steps: AtifStep[] = [];
  for (const turn of input.fallbackTurns) {
    steps.push({step_id: steps.length + 1, source: 'user', message: turn.user});
    steps.push({
      step_id: steps.length + 1,
      source: 'agent',
      model_name: input.model,
      message: turn.assistant,
      ...(turn.toolCalls.length === 0
        ? {}
        : {tool_calls: fallbackToolCalls(turn.toolCalls, steps.length + 1)}),
    });
  }
  if (steps.length === 0) {
    // ATIF requires at least one step. This path is only reachable after an
    // adapter bug because lifecycle records a completed send before evidence.
    throw new Error('Cannot create fallback ATIF without completed turns.');
  }
  return createNormalizedTrajectory({
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
    provenance: {
      source: {
        kind: 'driver_fallback',
        format: 'forge-driver-turns',
        sessionId: input.sessionId,
      },
      adapter: {id: input.adapterId, version: input.adapterVersion},
    },
    completeness: 'fallback',
    warnings,
  });
}

function fallbackToolCalls(
  calls: readonly AgentToolCall[],
  stepId: number,
): AtifToolCall[] {
  return calls.map((call, index) => ({
    tool_call_id: call.id ?? `driver-call-${stepId}-${index + 1}`,
    function_name: call.name,
    arguments: jsonObject(call.input, [], `fallback:${stepId}`),
  }));
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

function jsonObject(
  value: unknown,
  warnings: AtifNormalizationWarning[],
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
  warnings: AtifNormalizationWarning[],
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

function isMetadataRecord(type: string): boolean {
  return ['system', 'summary', 'file-history-snapshot', 'queue-operation'].includes(type);
}

function safeSessionFailure(error: unknown): string {
  if (error instanceof ClaudeSessionLimitError) {
    return 'Claude session evidence exceeded a safety limit.';
  }
  return 'Claude session evidence could not be normalized safely.';
}
