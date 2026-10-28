import type { AgentToolCall } from '../contracts/agent.ts';

export const MAX_TOOL_RESULT_CODE_UNITS = 1024 * 1024;
const TRUNCATION_MARKER = '\n[Forge truncated the tool result.]';

/** Bound already-redacted output before retaining it in the driver ledger. */
export function boundToolResult(
  result: NonNullable<AgentToolCall['result']>,
): NonNullable<AgentToolCall['result']> {
  if (result.content.length <= MAX_TOOL_RESULT_CODE_UNITS) {
    return {
      content: result.content,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      ...(result.truncated === undefined
        ? {}
        : { truncated: result.truncated }),
    };
  }
  let end = MAX_TOOL_RESULT_CODE_UNITS - TRUNCATION_MARKER.length;
  if (/[\uD800-\uDBFF]/.test(result.content[end - 1] ?? '')) end -= 1;
  return {
    content: result.content.slice(0, end) + TRUNCATION_MARKER,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    truncated: true,
  };
}
