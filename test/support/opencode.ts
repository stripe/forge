/** Independent fixtures matching OpenCode 1.19.0's published session-v1 schema. */
export const OPEN_CODE_SESSION = 'ses_0123456789abcdefghij';
export const OPEN_CODE_MODEL = 'gateway/kimi-test';
export const OPEN_CODE_CONFIG = {
  provider: {
    forge: {
      models: {
        [OPEN_CODE_MODEL]: {
          limit: { context: 32000, output: 4000 },
          reasoning: false,
          temperature: true,
          attachment: false,
          tool_call: true,
        },
      },
    },
  },
};
export interface OpenCodeFixtureTurn {
  prompt: string;
  response: string;
  error?: boolean;
}
const time = { start: 1_790_000_000_000, end: 1_790_000_000_001 };
const tokens = {
  input: 5,
  output: 2,
  reasoning: 1,
  cache: { read: 3, write: 0 },
};

export function openCodeMessages(turn: OpenCodeFixtureTurn, index = 0) {
  const userId = `msg_user${index}`;
  const assistantId = `msg_tool${index}`;
  const finalId = `msg_final${index}`;
  const part = (
    messageID: string,
    id: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> => ({
    id,
    messageID,
    sessionID: OPEN_CODE_SESSION,
    ...data,
  });
  const assistant = (id: string, finish: string) => ({
    id,
    sessionID: OPEN_CODE_SESSION,
    role: 'assistant',
    parentID: userId,
    modelID: OPEN_CODE_MODEL,
    providerID: 'forge',
    agent: 'build',
    mode: 'build',
    time: { created: time.start, completed: time.end },
    cost: 0.01,
    tokens,
    finish,
  });
  return [
    {
      info: {
        id: userId,
        sessionID: OPEN_CODE_SESSION,
        role: 'user',
        time: { created: time.start },
        agent: 'build',
        model: { providerID: 'forge', modelID: OPEN_CODE_MODEL },
      },
      parts: [
        part(userId, `prt_user${index}`, { type: 'text', text: turn.prompt }),
      ],
    },
    {
      info: assistant(assistantId, 'tool-calls'),
      parts: [
        part(assistantId, `prt_start${index}`, { type: 'step-start' }),
        part(assistantId, `prt_reason${index}`, {
          type: 'reasoning',
          text: 'Private reasoning.',
          time,
        }),
        part(assistantId, `prt_tool${index}`, {
          type: 'tool',
          callID: `call_${index}`,
          tool: 'bash',
          state: {
            status: turn.error ? 'error' : 'completed',
            input: { command: 'printf complete > answer.txt' },
            ...(turn.error
              ? { error: 'Command failed.' }
              : {
                  output: 'Wrote answer.txt.',
                  title: 'Write answer',
                  metadata: {},
                }),
            time,
          },
        }),
        part(assistantId, `prt_finish${index}`, {
          type: 'step-finish',
          reason: 'tool-calls',
          cost: 0.01,
          tokens,
        }),
      ],
    },
    {
      info: assistant(finalId, 'stop'),
      parts: [
        part(finalId, `prt_finalstart${index}`, { type: 'step-start' }),
        part(finalId, `prt_text${index}`, {
          type: 'text',
          text: turn.response,
          time,
        }),
        part(finalId, `prt_finalfinish${index}`, {
          type: 'step-finish',
          reason: 'stop',
          cost: 0.01,
          tokens,
        }),
      ],
    },
  ];
}

export function openCodeExport(turns: readonly OpenCodeFixtureTurn[]) {
  return {
    info: {
      id: OPEN_CODE_SESSION,
      version: '1.19.0',
      time: { created: time.start, updated: time.end },
    },
    messages: turns.flatMap(openCodeMessages),
  };
}

export function openCodeEvents(turn: OpenCodeFixtureTurn, index = 0) {
  return openCodeMessages(turn, index)
    .slice(1)
    .flatMap((message) =>
      message.parts.map((part) => ({
        type:
          (
            {
              'step-start': 'step_start',
              'step-finish': 'step_finish',
              tool: 'tool_use',
            } as Record<string, string>
          )[String(part.type)] ?? part.type,
        timestamp: time.end,
        sessionID: OPEN_CODE_SESSION,
        part,
      })),
    );
}

export function openCodeStream(turn: OpenCodeFixtureTurn, index = 0): string {
  return openCodeEvents(turn, index)
    .map((event) => JSON.stringify(event))
    .join('\n');
}
