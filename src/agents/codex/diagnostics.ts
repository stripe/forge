import type {
  AgentDiagnosticsCapture,
  AgentEventSummary,
  ProtocolRejection,
} from '../../diagnostics/agent.ts';
import { eventSummarySchema } from '../../diagnostics/agent.ts';
import { createInvocationCapture } from '../invocationDiagnostics.ts';
import {
  CodexStreamError,
  type CodexStreamOptions,
  isCodexAdvisory,
  isSafeCodexSessionId,
  MAX_CODEX_STREAM_LINE_BYTES,
} from './stream.ts';

const MAX_ERROR_MESSAGE_CHARACTERS = 8192;
const codexEventType = eventSummarySchema.shape.event_type.extract([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
  'unknown',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseEvent(line: string): Record<string, unknown> | undefined {
  let event: Record<string, unknown> | undefined;
  if (Buffer.byteLength(line) <= MAX_CODEX_STREAM_LINE_BYTES) {
    try {
      event = record(JSON.parse(line));
    } catch {
      /* Malformed lines still get a location. */
    }
  }
  return event;
}

export function summarizeCodexLine(
  line: string,
  sequence: number,
  observedAt: string,
): AgentEventSummary {
  return summarizeCodexEvent(parseEvent(line), sequence, observedAt);
}

function summarizeCodexEvent(
  event: Record<string, unknown> | undefined,
  sequence: number,
  observedAt: string,
): AgentEventSummary {
  const item = record(event?.item);
  const eventType = codexEventType.safeParse(event?.type);
  const itemType = eventSummarySchema.shape.item_type.safeParse(item?.type);
  const status = eventSummarySchema.shape.status.safeParse(item?.status);
  const toolExit =
    item?.type === 'command_execution' && Number.isSafeInteger(item.exit_code)
      ? (item.exit_code as number)
      : undefined;
  const failure =
    event?.type === 'error' ||
    event?.type === 'turn.failed' ||
    item?.type === 'error';
  const error = record(event?.error) ?? item;
  const reportedStatus = error?.http_status ?? error?.status_code;
  let httpStatus =
    typeof reportedStatus === 'number' &&
    Number.isInteger(reportedStatus) &&
    reportedStatus >= 100 &&
    reportedStatus <= 599
      ? reportedStatus
      : undefined;
  if (failure && httpStatus === undefined) {
    const message = error?.message ?? event?.message;
    if (typeof message === 'string') {
      const match =
        /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?[ :]+)([1-5]\d\d)\b/i.exec(
          message.slice(0, MAX_ERROR_MESSAGE_CHARACTERS),
        );
      if (match) httpStatus = Number(match[1]);
    }
  }
  return {
    sequence,
    observed_at: observedAt,
    event_type: eventType.success ? eventType.data : 'unknown',
    ...(item === undefined
      ? {}
      : { item_type: itemType.success ? itemType.data : 'unknown' }),
    ...(status.success && status.data !== undefined
      ? { status: status.data }
      : {}),
    ...(toolExit === undefined ? {} : { tool_exit_code: toolExit }),
    ...(failure && httpStatus !== undefined
      ? { http_status: httpStatus, http_origin: 'agent_reported' }
      : {}),
  };
}

export function createCodexInvocationCapture(input: {
  sequence: number;
  resume: boolean;
  cliVersion: string;
  capture?: AgentDiagnosticsCapture | undefined;
  streamOptions?: CodexStreamOptions;
  now?: () => Date;
  monotonicNow?: () => number;
}) {
  const state = {
    threadStarted: false,
    turnStarted: false,
    turnCompleted: false,
  };
  return createInvocationCapture({
    ...input,
    source: 'codex_exec_json',
    summarizeLine: summarizeCodexLine,
    isAdvisory(line) {
      const event = parseEvent(line);
      const advisory = isCodexAdvisory(event, input.streamOptions ?? {}, state);
      if (event?.type === 'thread.started') {
        state.threadStarted = true;
        if (
          typeof event.thread_id === 'string' &&
          isSafeCodexSessionId(event.thread_id)
        ) {
          try {
            input.capture?.observeSessionId?.(event.thread_id);
          } catch {
            /* Observation cannot control execution. */
          }
        }
      }
      if (event?.type === 'turn.started') state.turnStarted = true;
      if (event?.type === 'turn.completed') state.turnCompleted = true;
      return advisory;
    },
  });
}

export function codexRejection(error: unknown): ProtocolRejection {
  return error instanceof CodexStreamError
    ? error.rejection
    : { code: 'unknown' };
}
