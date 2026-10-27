import type { AgentToolCall } from '../contracts/agent.ts';

/** Keep observable text without embedding native media bytes or metadata. */
export function textToolResult(
  content: unknown,
): NonNullable<AgentToolCall['result']> {
  if (typeof content === 'string') return { content };
  let truncated = false;
  const text = (Array.isArray(content) ? content : [content])
    .flatMap((part: unknown) => {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return [(part as { text: string }).text];
      }
      truncated = true;
      return [];
    })
    .join('\n');
  return {
    content:
      text +
      (truncated ? '\n[Forge omitted non-text tool result content.]' : ''),
    ...(truncated ? { truncated: true } : {}),
  };
}
