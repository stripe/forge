import type { AgentToolResult } from '../contracts/agent.ts';
import type { InteractionToolResultV1 } from '../results/types.ts';

export const MAX_TOOL_RESULT_CODE_UNITS = 1024 * 1024;
/** Total tool-result text retained across one run's interaction ledger. */
export const MAX_RUN_TOOL_RESULT_CODE_UNITS = 16 * 1024 * 1024;

/**
 * Bound already-redacted output before retaining it in the driver ledger. Cut
 * content keeps no Forge text; consumers render the marker from `truncated`,
 * which callers must have cleared of adapter-supplied values.
 */
export function boundToolResult(
  result: AgentToolResult,
  limit = MAX_TOOL_RESULT_CODE_UNITS,
): AgentToolResult {
  const common = {
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.omission === undefined ? {} : { omission: result.omission }),
  };
  const content = result.content;
  if (content === undefined) return common;
  if (content.length <= limit) {
    return {
      content,
      ...common,
      ...(result.truncated === true ? { truncated: true } : {}),
    };
  }
  let end = limit;
  if (/[\uD800-\uDBFF]/.test(content[end - 1] ?? '')) end -= 1;
  return { content: content.slice(0, end), ...common, truncated: true };
}

/** Persist a bounded ledger result with the artifact's snake_case spelling. */
export function interactionToolResult(
  result: AgentToolResult,
): InteractionToolResultV1 {
  return {
    ...(result.content === undefined ? {} : { content: result.content }),
    ...(result.isError === undefined ? {} : { is_error: result.isError }),
    ...(result.omission === undefined ? {} : { omission: result.omission }),
    ...(result.truncated === true ? { truncated: true } : {}),
  };
}
