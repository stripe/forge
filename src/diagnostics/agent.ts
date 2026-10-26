import { z } from 'zod';

const count = z.number().int().nonnegative().safe();
export const MAX_AGENT_DIAGNOSTICS_BYTES = 64 * 1024;
export const MAX_CLI_EXCERPT_BYTES = 128 * 1024;
export const MAX_STDERR_EXCERPT_BYTES = 32 * 1024;
export const protocolRejectionSchema = z
  .object({
    code: z.enum([
      'process_nonzero_exit',
      'item_error',
      'turn_failed',
      'invalid_json',
      'unexpected_field',
      'invalid_event_order',
      'unsupported_event_type',
      'output_limit',
      'unknown',
    ]),
    line_index: count.positive().optional(),
    schema_path: z.enum(['event', 'event.item', 'event.usage']).optional(),
  })
  .strict();
export type ProtocolRejection = z.infer<typeof protocolRejectionSchema>;
export const eventSummarySchema = z
  .object({
    sequence: count.positive(),
    observed_at: z.string().datetime(),
    event_type: z.enum([
      'thread.started',
      'turn.started',
      'turn.completed',
      'turn.failed',
      'item.started',
      'item.updated',
      'item.completed',
      'error',
      'unknown',
    ]),
    item_type: z
      .enum([
        'agent_message',
        'reasoning',
        'command_execution',
        'file_change',
        'mcp_tool_call',
        'web_search',
        'todo_list',
        'error',
        'unknown',
      ])
      .optional(),
    status: z.enum(['in_progress', 'completed', 'failed']).optional(),
    tool_exit_code: z.number().int().safe().optional(),
    http_status: z.number().int().min(100).max(599).optional(),
    http_origin: z.literal('agent_reported').optional(),
  })
  .strict();
export type AgentEventSummary = z.infer<typeof eventSummarySchema>;
export const agentInvocationSchema = z
  .object({
    sequence: count.positive(),
    operation: z.enum(['agent_exec', 'agent_resume']),
    cli_version: z.string().min(1).max(4096),
    source: z.literal('codex_exec_json'),
    state: z.enum(['running', 'completed', 'failed']),
    process: z
      .object({
        exit_code: z.number().int().safe().optional(),
        signal: z
          .enum([
            'SIGTERM',
            'SIGKILL',
            'SIGINT',
            'SIGHUP',
            'SIGQUIT',
            'SIGABRT',
            'SIGSEGV',
            'SIGPIPE',
            'SIGBUS',
            'SIGILL',
            'SIGFPE',
            'SIGTRAP',
            'SIGSYS',
            'SIGXCPU',
            'SIGXFSZ',
            'SIGALRM',
            'SIGUSR1',
            'SIGUSR2',
          ])
          .optional(),
        error_code: z
          .enum([
            'command_aborted',
            'command_output_limit',
            'command_start_failed',
            'command_timeout',
            'command_runner_closed',
          ])
          .optional(),
        duration_ms: z.number().finite().nonnegative().optional(),
        stdout_bytes: count.optional(),
        stderr_bytes: count.optional(),
        stdout_truncated: z.boolean().optional(),
        stderr_truncated: z.boolean().optional(),
      })
      .strict()
      .optional(),
    capture: z.enum(['observed', 'partial', 'unsupported']),
    event_count: count,
    tool_failure_count: count,
    last_completed_turn: count,
    events: z.array(eventSummarySchema).max(20),
    first_failure: eventSummarySchema.optional(),
    rejection: protocolRejectionSchema.optional(),
    extraction_rejection: protocolRejectionSchema.optional(),
  })
  .strict();
export type AgentInvocationRecord = z.infer<typeof agentInvocationSchema>;
export const restrictedDescriptorSchema = z
  .object({
    invocation: count.positive(),
    cli_events: z
      .object({
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: count.max(MAX_CLI_EXCERPT_BYTES),
      })
      .strict(),
    stderr: z
      .object({
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: count.max(MAX_STDERR_EXCERPT_BYTES),
      })
      .strict(),
    redacted: z.literal(true),
    events_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
  })
  .strict();
export interface RestrictedAgentExcerpts {
  readonly cli_events: string;
  readonly stderr: string;
  readonly events_truncated: boolean;
  readonly stderr_truncated: boolean;
}

export interface RedactedDiagnosticTail {
  push(chunk: string): void;
  finish(sourceTruncated?: boolean): {
    readonly text: string;
    readonly truncated: boolean;
  };
}

/** Explicit execution capability; callbacks must not change the agent outcome. */
export interface AgentDiagnosticsCapture {
  readonly restrictedExcerpts: boolean;
  /** Exact secret values remain inside execution; adapters receive only redaction authority. */
  redact(text: string): string;
  redactedTail(maximumBytes: number): RedactedDiagnosticTail;
  record(
    record: AgentInvocationRecord,
    excerpts?: RestrictedAgentExcerpts,
    /** Use only before or after the command, never during execution. */
    publication?: 'invocation_boundary',
  ): Promise<void>;
}
