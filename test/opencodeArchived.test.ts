import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import {
  loadOpenCodeEvidence,
  loadOpenCodeNativeArtifact,
} from '../src/agents/opencode/evidence.ts';
import { createOpenCodeAdapter } from '../src/agents/opencode/index.ts';
import { parseOpenCodeStream } from '../src/agents/opencode/stream.ts';
import { parseAtifTrajectory } from '../src/atif/index.ts';
import {
  selectAgentEvidence,
  trajectoryCoversCompletedTurns,
} from '../src/evidence/selection.ts';
import { createMemoryWorkspace } from '../src/testing/index.ts';

interface ArchivedPart {
  type: string;
  text?: string;
  synthetic?: boolean;
  [key: string]: unknown;
}

interface ArchivedExport {
  info: { id: string; version: string };
  messages: {
    info: { role: string };
    parts: ArchivedPart[];
  }[];
}

async function fixture(name: string) {
  const body = await readFile(
    new URL(`./fixtures/opencode/archived/${name}.json`, import.meta.url),
    'utf8',
  );
  const value = JSON.parse(body) as ArchivedExport;
  return {
    body,
    value,
    input: {
      state: createMemoryWorkspace({ 'session.json': body }).readonly,
      sessionId: value.info.id,
      agentVersion: value.info.version,
      model: 'fixture-model',
      signal: new AbortController().signal,
    },
  };
}

// The archive retains exports, not CLI stdout. Replay real stored parts in
// export order with the JSON stream's event names. This checks part shapes,
// not original emission order or post-finish cleanup; see fixture_selection.md.
function replayTurns(value: ArchivedExport) {
  const turns: { user: string; events: unknown[] }[] = [];
  const names: Record<string, string> = {
    'step-start': 'step_start',
    'step-finish': 'step_finish',
    tool: 'tool_use',
  };
  for (const message of value.messages) {
    if (message.info.role === 'user') {
      const prompt = message.parts.filter(
        (part) => part.type === 'text' && part.synthetic !== true,
      );
      if (prompt.length) {
        turns.push({
          user: prompt.map((part) => part.text).join('\n\n'),
          events: [],
        });
      }
    }
    for (const part of message.parts) {
      // User prompts and compaction requests aren't CLI output. The pinned
      // CLI does emit the synthetic continuation's text part.
      if (message.info.role === 'user' && part.synthetic !== true) continue;
      assert.ok(turns.length);
      turns.at(-1)!.events.push({
        type: names[part.type] ?? part.type,
        sessionID: value.info.id,
        part,
      });
    }
  }
  return turns.map(({ user, events }) => ({
    user,
    ...parseOpenCodeStream(
      events.map((event) => JSON.stringify(event)).join('\n'),
      value.info.id,
    ),
  }));
}

describe('OpenCode 1.19.0 archived native exports', () => {
  for (const [name, replies, tools] of [
    ['plain-answer', ['Reply 1.'], []],
    ['tool-call', ['Reply 2.'], ['read']],
    ['tool-error', ['Reply 3.'], ['glob', 'webfetch']],
    ['resumed-retry', ['Reply 1.', 'Reply 2.', 'Reply 3.', 'Reply 4.'], []],
  ] as const) {
    it(`replays ${name} parts and reconciles the exact native session`, async () => {
      const { body, value, input } = await fixture(name);
      const turns = replayTurns(value);
      assert.deepEqual(
        turns.map((turn) => turn.text),
        replies,
      );
      assert.deepEqual(
        turns.flatMap((turn) => turn.toolCalls.map((call) => call.name)),
        tools,
      );
      assert.ok(turns.every((turn) => turn.sessionId === input.sessionId));
      const evidence = await loadOpenCodeEvidence(input);
      assert.equal(evidence.kind, 'available');
      if (evidence.kind !== 'available') return;
      assert.deepEqual(evidence.warnings, []);
      const trajectory = parseAtifTrajectory(evidence.trajectory);
      assert.equal(
        trajectory.steps.filter((step) => step.source === 'user').length,
        replies.length,
      );
      assert.equal(
        trajectoryCoversCompletedTurns(
          trajectory,
          turns.map((turn) => ({
            user: turn.user,
            assistant: turn.text,
            toolCalls: turn.toolCalls,
          })),
          evidence.source,
        ),
        true,
      );
      if (name === 'tool-error') {
        assert.deepEqual(
          trajectory.steps.flatMap(
            (step) =>
              step.observation?.results.map((result) => ({
                id: result.source_call_id,
                content: result.content,
                error: result.extra?.is_error,
              })) ?? [],
          ),
          [
            { id: 'call_1', content: 'Tool output.', error: false },
            { id: 'call_2', content: 'Tool failed.', error: true },
          ],
        );
      }
      if (name === 'resumed-retry') {
        assert.deepEqual(
          value.messages[5]!.parts.map((part) => part.type),
          ['step-start', 'step-start', 'reasoning', 'text', 'step-finish'],
        );
        assert.equal(
          trajectory.steps[5]!.reasoning_content,
          'Reasoning omitted.',
        );
      }
      assert.equal(
        Buffer.from((await loadOpenCodeNativeArtifact(input))!.body).toString(),
        body,
      );
    });
  }

  it('replays reused gateway call IDs across separate resumed turns', async () => {
    const { value, input, body } = await fixture('reused-call-id');
    const turns = replayTurns(value);
    assert.deepEqual(
      turns.map((turn) => turn.text),
      ['Reply 1.\n\nReply 2.', 'Reply 3.\n\nReply 4.'],
    );
    assert.deepEqual(
      turns.map((turn) => turn.toolCalls.map((call) => call.id)),
      [['call_1', 'call_2'], ['call_1']],
    );
    assert.equal(
      Buffer.from((await loadOpenCodeNativeArtifact(input))!.body).toString(),
      body,
    );
  });

  // stripe/forge#32 H3.3: session-wide gateway-ID uniqueness rejects two
  // distinct executions in different turns. Keep the intended behavior here
  // while the stream/ID follow-up owns the production fix and ATIF ID policy.
  it.fails('H3.3: loads distinct executions with a reused gateway call ID', async () => {
    const { input } = await fixture('reused-call-id');
    const evidence = await loadOpenCodeEvidence(input);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available') return;
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    const calls = trajectory.steps.flatMap((step) => step.tool_calls ?? []);
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((call) => call.tool_call_id)).size, 3);
    const observations = trajectory.steps.flatMap(
      (step) => step.observation?.results ?? [],
    );
    assert.deepEqual(
      observations.map((result) => result.source_call_id),
      calls.map((call) => call.tool_call_id),
    );
  });

  it('excludes the real compaction summary and explicitly selects driver fallback', async () => {
    const { body, value, input } = await fixture('compaction');
    const turns = replayTurns(value);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.text, 'Reply 1.\n\nReply 3.');
    const collected = await loadOpenCodeEvidence(input);
    assert.equal(collected.kind, 'unavailable');
    if (collected.kind !== 'unavailable') return;
    assert.equal(collected.reason.code, 'source_incomplete');
    const selected = selectAgentEvidence({
      agent: createOpenCodeAdapter(),
      identity: { name: 'opencode', version: input.agentVersion },
      model: input.model,
      sessionId: input.sessionId,
      completedTurns: turns.map((turn) => ({
        user: turn.user,
        assistant: turn.text,
        toolCalls: turn.toolCalls,
      })),
      collected,
    });
    assert.equal(selected.provenance.source.kind, 'driver_fallback');
    assert.deepEqual(
      selected.warnings.map((warning) => warning.code),
      ['source_incomplete', 'fallback_used'],
    );
    assert.equal(selected.trajectory.steps[1]!.message, turns[0]!.text);
    assert.equal(
      JSON.stringify(selected.trajectory).includes('Summary omitted.'),
      false,
    );
    assert.equal(
      Buffer.from((await loadOpenCodeNativeArtifact(input))!.body).toString(),
      body,
    );
  });
});
