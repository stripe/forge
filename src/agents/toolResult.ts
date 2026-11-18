import type { AgentToolResult } from '../contracts/agent.ts';

/** Keep observable text without embedding native media bytes or metadata. */
export function textToolResult(content: unknown): AgentToolResult {
  if (typeof content === 'string') return { content };
  let omitted = false;
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
      omitted = true;
      return [];
    })
    .join('\n');
  return {
    content: text,
    ...(omitted ? { omission: 'non_text_content' } : {}),
  };
}
