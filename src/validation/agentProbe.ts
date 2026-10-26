import type { CredentialReference } from '../contracts/credentials.ts';
import { createHttpModelProbe } from './httpProbe.ts';

/** Each built-in agent selects its own wire protocol and credential binding. */
export function createAgentModelProbe(options: {
  endpoint: string;
  credential: CredentialReference;
  model: string;
  protocol: 'messages' | 'responses' | 'chat';
  bearer?: boolean;
}) {
  const { protocol, model } = options;
  const messages = [{ role: 'user', content: 'Reply OK.' }];
  const body =
    protocol === 'responses'
      ? { model, input: messages, max_output_tokens: 64, store: false }
      : { model, messages, max_tokens: 64 };
  return createHttpModelProbe({
    endpoint: options.endpoint,
    credential: options.credential,
    headers: (secret) =>
      protocol === 'messages'
        ? {
            'anthropic-version': '2023-06-01',
            ...(options.bearer
              ? { authorization: `Bearer ${secret}` }
              : { 'x-api-key': secret }),
          }
        : { authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    accepts: (raw) => {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) return false;
      if (protocol === 'messages')
        return (
          value.type === 'message' &&
          Array.isArray(value.content) &&
          (value.stop_reason === 'max_tokens' ||
            value.content.some((block: unknown) => hasText(block, 'text')))
        );
      if (protocol === 'responses')
        return (
          value.object === 'response' &&
          Array.isArray(value.output) &&
          // Exhausting a small reasoning budget still proves the model accepted the request.
          ((value.status === 'incomplete' &&
            isRecord(value.incomplete_details) &&
            value.incomplete_details.reason === 'max_output_tokens') ||
            (value.status === 'completed' &&
              value.output.some(
                (item: unknown) =>
                  isRecord(item) &&
                  item.type === 'message' &&
                  Array.isArray(item.content) &&
                  item.content.some((block: unknown) =>
                    hasText(block, 'output_text'),
                  ),
              )))
        );
      return (
        Array.isArray(value.choices) &&
        value.choices.some(
          (choice: unknown) =>
            isRecord(choice) &&
            isRecord(choice.message) &&
            (choice.finish_reason === 'length' ||
              (typeof choice.message.content === 'string' &&
                choice.message.content.length > 0)),
        )
      );
    },
  });
}

function hasText(value: unknown, type: string): boolean {
  return (
    isRecord(value) &&
    value.type === type &&
    typeof value.text === 'string' &&
    value.text.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
