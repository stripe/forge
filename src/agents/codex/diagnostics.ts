import type {
  CommandCapture,
  CommandExecutionError,
  CommandResult,
} from '../../contracts/command.ts';
import {
  type AgentDiagnosticsCapture,
  type AgentEventSummary,
  type AgentInvocationRecord,
  agentInvocationSchema,
  eventSummarySchema,
  MAX_CLI_EVENT_EXCERPT_BYTES,
  MAX_CLI_EXCERPT_BYTES,
  MAX_INVOCATION_EVENTS,
  MAX_STDERR_EXCERPT_BYTES,
  type ProtocolRejection,
} from '../../diagnostics/agent.ts';
import {
  CodexStreamError,
  type CodexStreamOptions,
  isCodexAdvisory,
  MAX_CODEX_STREAM_LINE_BYTES,
} from './stream.ts';

const CLI_EXCERPT_METADATA_BYTES = 512;
const MAX_ERROR_MESSAGE_CHARACTERS = 8192;

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
  const eventType = eventSummarySchema.shape.event_type.safeParse(event?.type);
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

function failed(event: AgentEventSummary): boolean {
  return (
    event.event_type === 'error' ||
    event.event_type === 'turn.failed' ||
    event.event_type === 'unknown' ||
    event.item_type === 'error' ||
    event.item_type === 'unknown'
  );
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
  const now = input.now ?? (() => new Date());
  const monotonic = input.monotonicNow ?? (() => performance.now());
  const enabled = input.capture?.restrictedExcerpts === true;

  let invocation: AgentInvocationRecord = {
    sequence: input.sequence,
    operation: input.resume ? 'agent_resume' : 'agent_exec',
    cli_version: input.cliVersion,
    source: 'codex_exec_json',
    state: 'running',
    capture: 'observed',
    event_count: 0,
    tool_failure_count: 0,
    last_completed_turn: 0,
    events: [],
  };
  const streamState = {
    threadStarted: false,
    turnStarted: false,
    turnCompleted: false,
  };
  let lastFlush = monotonic();
  const excerpts: Array<{ line_index: number; text: string }> = [];
  let firstExcerpt: { line_index: number; text: string } | undefined;
  let eventsTruncated = false;
  let observedStderr = false;
  const stderr = enabled
    ? input.capture!.redactedTail(MAX_STDERR_EXCERPT_BYTES)
    : undefined;
  const safeRecord = async (
    body?: import('../../diagnostics/agent.ts').RestrictedAgentExcerpts,
    publication?: 'invocation_boundary',
  ) => {
    try {
      await input.capture?.record(
        structuredClone(invocation),
        body,
        publication,
      );
    } catch {
      /* Recording never controls execution. */
    }
  };
  function excerpt(line: string, lineIndex: number) {
    const redacted = input.capture?.redact(line) ?? line;
    // JSON escaping can expand a text excerpt by six times.
    const bytes = Buffer.from(redacted);
    if (bytes.length > MAX_CLI_EVENT_EXCERPT_BYTES) eventsTruncated = true;
    let text = bytes.subarray(0, MAX_CLI_EVENT_EXCERPT_BYTES).toString('utf8');
    while (Buffer.byteLength(text) > MAX_CLI_EVENT_EXCERPT_BYTES)
      text = text.slice(0, -1);
    return { line_index: lineIndex, text };
  }
  function onStdoutLine(line: string) {
    if (!line.trim()) {
      invocation = { ...invocation, event_count: invocation.event_count + 1 };
      return;
    }
    const event = parseEvent(line);
    const advisory = isCodexAdvisory(
      event,
      input.streamOptions ?? {},
      streamState,
    );
    const summary = summarizeCodexEvent(
      event,
      invocation.event_count + 1,
      now().toISOString(),
    );
    const isFailure = failed(summary) && !advisory;
    if (event?.type === 'thread.started') streamState.threadStarted = true;
    if (event?.type === 'turn.started') streamState.turnStarted = true;
    if (event?.type === 'turn.completed') streamState.turnCompleted = true;
    invocation = {
      ...invocation,
      event_count: summary.sequence,
      events: [...invocation.events, summary].slice(-MAX_INVOCATION_EVENTS),
      tool_failure_count:
        invocation.tool_failure_count +
        (summary.tool_exit_code !== undefined && summary.tool_exit_code !== 0
          ? 1
          : 0),
      last_completed_turn:
        summary.event_type === 'turn.completed'
          ? summary.sequence
          : invocation.last_completed_turn,
      ...(invocation.first_failure === undefined && isFailure
        ? { first_failure: summary }
        : {}),
    };
    if (enabled) {
      const next = excerpt(line, summary.sequence);
      if (!firstExcerpt && isFailure) firstExcerpt = next;
      excerpts.push(next);
      while (
        excerpts.length > MAX_INVOCATION_EVENTS ||
        Buffer.byteLength(
          JSON.stringify({ failure: firstExcerpt, events: excerpts }),
        ) >
          MAX_CLI_EXCERPT_BYTES - CLI_EXCERPT_METADATA_BYTES
      ) {
        excerpts.shift();
        eventsTruncated = true;
      }
    }
    if (monotonic() - lastFlush >= 5000) {
      lastFlush = monotonic();
      void safeRecord();
    }
  }
  return {
    start: () => safeRecord(undefined, 'invocation_boundary'),
    onStdoutLine,
    onStderrChunk(chunk: string) {
      if (stderr && chunk) {
        observedStderr = true;
        stderr.push(chunk);
      }
    },
    async finish(details: {
      result?: CommandResult;
      commandError?: CommandExecutionError;
      rejection?: ProtocolRejection;
      extractionRejection?: ProtocolRejection;
      stdout?: string;
    }) {
      const result = details.result;
      const partial: CommandCapture | undefined =
        details.commandError?.capture ?? result?.capture;
      const stdout = details.stdout ?? partial?.stdout ?? result?.stdout ?? '';
      const lines = stdout.split(/\r?\n/);
      if (stdout.endsWith('\n')) lines.pop();
      // Older/custom runners may not deliver observation callbacks.
      if (invocation.event_count === 0 && stdout) {
        for (const line of lines) onStdoutLine(line);
      }
      if (
        enabled &&
        partial?.stdoutTruncated &&
        stdout &&
        !stdout.endsWith('\n')
      ) {
        const lineIndex = lines.length;
        const safe = input.capture!.redactedTail(MAX_CLI_EVENT_EXCERPT_BYTES);
        safe.push(lines.at(-1) ?? '');
        const replacement = {
          line_index: lineIndex,
          text: safe.finish(true).text,
        };
        const index = excerpts.findIndex(
          (entry) => entry.line_index === lineIndex,
        );
        if (index !== -1) excerpts[index] = replacement;
        if (firstExcerpt?.line_index === lineIndex) firstExcerpt = replacement;
        eventsTruncated = true;
      }
      const rejection = details.rejection;
      const parserFailure = details.extractionRejection ?? rejection;
      if (
        parserFailure?.line_index !== undefined &&
        parserFailure.line_index <= invocation.event_count &&
        (invocation.first_failure === undefined ||
          parserFailure.line_index < invocation.first_failure.sequence)
      ) {
        const line = lines[parserFailure.line_index - 1];
        if (line?.trim()) {
          invocation = {
            ...invocation,
            first_failure: summarizeCodexLine(
              line,
              parserFailure.line_index,
              now().toISOString(),
            ),
          };
          if (enabled) {
            firstExcerpt =
              excerpts.find(
                (entry) => entry.line_index === parserFailure.line_index,
              ) ?? excerpt(line, parserFailure.line_index);
          }
        }
      }
      const process =
        partial ??
        (result === undefined
          ? undefined
          : {
              ...result,
              stdoutBytes: Buffer.byteLength(result.stdout),
              stderrBytes: Buffer.byteLength(result.stderr),
              stdoutTruncated: false,
              stderrTruncated: false,
            });
      invocation = {
        ...invocation,
        state: rejection || details.commandError ? 'failed' : 'completed',
        capture:
          process === undefined
            ? 'unsupported'
            : process.stdoutTruncated || process.stderrTruncated
              ? 'partial'
              : 'observed',
        ...(process === undefined
          ? details.commandError === undefined
            ? {}
            : { process: { error_code: details.commandError.code } }
          : {
              process: {
                duration_ms: process.durationMs,
                stdout_bytes: process.stdoutBytes,
                stderr_bytes: process.stderrBytes,
                stdout_truncated: process.stdoutTruncated,
                stderr_truncated: process.stderrTruncated,
                ...(process.exitCode === undefined
                  ? {}
                  : { exit_code: process.exitCode }),
                ...('signal' in process &&
                agentInvocationSchema.shape.process
                  .unwrap()
                  .shape.signal.safeParse(process.signal).success &&
                process.signal !== undefined
                  ? {
                      signal: process.signal as NonNullable<
                        AgentInvocationRecord['process']
                      >['signal'],
                    }
                  : {}),
                ...(details.commandError === undefined
                  ? {}
                  : { error_code: details.commandError.code }),
              },
            }),
        ...(rejection === undefined ? {} : { rejection }),
        ...(details.extractionRejection === undefined
          ? {}
          : { extraction_rejection: details.extractionRejection }),
      };
      if (!enabled || invocation.state !== 'failed') {
        await safeRecord(undefined, 'invocation_boundary');
        return;
      }
      if (!observedStderr)
        stderr!.push(partial?.stderr ?? result?.stderr ?? '');
      const tail = stderr!.finish(process?.stderrTruncated);
      while (
        Buffer.byteLength(
          JSON.stringify({ failure: firstExcerpt, events: excerpts }),
        ) >
        MAX_CLI_EXCERPT_BYTES - CLI_EXCERPT_METADATA_BYTES
      ) {
        if (excerpts.length === 0) break;
        excerpts.shift();
        eventsTruncated = true;
      }
      await safeRecord(
        {
          cli_events: JSON.stringify({
            invocation: invocation.sequence,
            operation: invocation.operation,
            failure: firstExcerpt ?? null,
            events: excerpts,
            truncated: eventsTruncated,
          }),
          stderr: tail.text,
          events_truncated: eventsTruncated,
          stderr_truncated:
            tail.truncated || (process?.stderrTruncated ?? false),
        },
        'invocation_boundary',
      );
    },
  };
}

export function codexRejection(error: unknown): ProtocolRejection {
  return error instanceof CodexStreamError
    ? error.rejection
    : { code: 'unknown' };
}
