import type { AgentEventSummary } from '../diagnostics/agent.ts';

/** Positive projections: untrusted event names and payloads never become metadata. */
export function summarizeNativeStreamLine(
  source: 'claude_stream_json' | 'opencode_run_json',
  line: string,
  sequence: number,
  observedAt: string,
): AgentEventSummary {
  const summary: AgentEventSummary = {
    sequence,
    observed_at: observedAt,
    event_type: 'unknown',
  };
  if (Buffer.byteLength(line) > 1024 * 1024) return summary;
  try {
    const event = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event))
      return summary;
    const known =
      source === 'claude_stream_json'
        ? (['system', 'assistant', 'user', 'result', 'stream_event'] as const)
        : ([
            'step_start',
            'step_finish',
            'text',
            'reasoning',
            'tool_use',
            'error',
          ] as const);
    const type = known.find((type) => type === event.type) ?? 'unknown';
    const failed =
      source === 'claude_stream_json'
        ? event.type === 'result' && event.is_error === true
        : event.type === 'error' ||
          (event.type === 'tool_use' && event.part?.state?.status === 'error');
    return {
      ...summary,
      event_type: type,
      ...(failed ? { status: 'failed' } : {}),
    };
  } catch {
    return summary;
  }
}
