import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  OPEN_CODE_MODEL,
  OPEN_CODE_SESSION,
  openCodeEvents,
  openCodeExport,
} from '../../../test/support/opencode.ts';
import { parseAtifTrajectory } from '../../atif/index.ts';
import { createJudgeTranscriptProjection } from '../../evaluation/judgeTranscript.ts';
import {
  selectAgentEvidence,
  trajectoryCoversCompletedTurns,
} from '../../evidence/selection.ts';
import { createMemoryWorkspace } from '../../testing/index.ts';
import {
  loadOpenCodeEvidence,
  loadOpenCodeNativeArtifact,
} from './evidence.ts';
import { createOpenCodeAdapter } from './index.ts';
import { parseOpenCodeStream } from './stream.ts';

const turns = [
  { prompt: 'First', response: 'Done.' },
  { prompt: 'Second', response: 'Again.', error: true },
];
function fixture(value: unknown = openCodeExport(turns)) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const state = createMemoryWorkspace({ 'session.json': body });
  return {
    body,
    input: {
      state: state.readonly,
      sessionId: OPEN_CODE_SESSION,
      model: OPEN_CODE_MODEL,
      agentVersion: '1.19.0',
      signal: new AbortController().signal,
    },
  };
}
describe('OpenCode native evidence', () => {
  it('uses the summary-free driver reply for compacted exports before native reconciliation', async () => {
    const summaryTurn = { prompt: 'First', response: 'Compaction summary' };
    const resumeTurn = { prompt: 'Continue', response: 'Done.' };
    const value = openCodeExport([summaryTurn, resumeTurn]);
    Object.assign(value.messages[1]!.parts[1]!, {
      type: 'text',
      text: 'Before.',
    });
    Object.assign(value.messages[3]!.parts[0]!, {
      synthetic: true,
      metadata: { compaction_continue: true },
      time: { start: 1790000000000, end: 1790000000001 },
    });
    const events = openCodeEvents(summaryTurn);
    events[1]!.type = 'text';
    events[1]!.part = value.messages[1]!.parts[1]!;
    const reply = parseOpenCodeStream(
      [
        ...events,
        {
          type: 'text',
          sessionID: OPEN_CODE_SESSION,
          part: value.messages[3]!.parts[0],
        },
        ...openCodeEvents(resumeTurn, 1),
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    );
    assert.equal(reply.text, 'Before.\n\nDone.');
    // Both the summary marker and the synthetic user part independently make
    // the export unavailable; compacted text never reaches reconciliation.
    for (const summary of [true, false]) {
      Object.assign(value.messages[2]!.info, { summary });
      const { input, body } = fixture(value);
      const collected = await loadOpenCodeEvidence(input);
      assert.equal(collected.kind, 'unavailable');
      const selected = selectAgentEvidence({
        agent: createOpenCodeAdapter(),
        identity: { name: 'opencode', version: '1.19.0' },
        model: OPEN_CODE_MODEL,
        sessionId: OPEN_CODE_SESSION,
        completedTurns: [
          {
            user: summaryTurn.prompt,
            assistant: reply.text,
            toolCalls: reply.toolCalls,
          },
        ],
        collected,
      });
      assert.equal(selected.provenance.source.kind, 'driver_fallback');
      assert.deepEqual(
        selected.warnings.map(({ code }) => code),
        ['source_incomplete', 'fallback_used'],
      );
      assert.equal(selected.trajectory.steps[1]!.message, reply.text);
      assert.equal(
        JSON.stringify(
          createJudgeTranscriptProjection(selected.trajectory),
        ).includes('Compaction summary'),
        false,
      );
      assert.equal(
        Buffer.from((await loadOpenCodeNativeArtifact(input))!.body).toString(),
        body,
      );
    }
  });
  it('keeps valid continued stop steps and correlates parallel tools by ID', async () => {
    const value = openCodeExport([turns[0]!]);
    Object.assign(value.messages[1]!.info, { finish: 'stop' });
    value.messages[1]!.parts[3]!.reason = 'stop';
    const second = structuredClone(value.messages[1]!.parts[2]!);
    Object.assign(second, { id: 'prt_second', callID: 'call_second' });
    value.messages[1]!.parts.splice(3, 0, second);
    const result = await loadOpenCodeEvidence(fixture(value).input);
    assert.equal(result.kind, 'available');
    if (result.kind !== 'available') return;
    const trajectory = parseAtifTrajectory(result.trajectory);
    const driver = [
      {
        user: turns[0]!.prompt,
        assistant: turns[0]!.response,
        toolCalls: ['call_second', 'call_0'].map((id) => ({
          id,
          name: 'bash',
          input: { command: 'printf complete > answer.txt' },
        })),
      },
    ];
    assert.equal(
      trajectoryCoversCompletedTurns(trajectory, driver, result.source),
      true,
    );
    driver[0]!.toolCalls[0]!.id = 'call_0';
    assert.equal(
      trajectoryCoversCompletedTurns(trajectory, driver, result.source),
      false,
    );
    Object.assign(value.messages[1]!.info, { summary: true });
    assert.equal(
      (await loadOpenCodeEvidence(fixture(value).input)).kind,
      'unavailable',
    );
  });
  it('normalizes turns, reasoning, correlated tools/errors, and usage without altering native bytes', async () => {
    const { input, body } = fixture();
    const evidence = await loadOpenCodeEvidence(input);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available') return;
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.equal(trajectory.steps.length, 6);
    assert.equal(trajectory.steps[1]!.source, 'agent');
    assert.equal(trajectory.steps[1]!.reasoning_content, 'Private reasoning.');
    for (const step of trajectory.steps.filter((step) => step.source === 'agent'))
      assert.deepEqual(step.metrics, {
        prompt_tokens: 12,
        completion_tokens: 3,
        cached_tokens: 3,
        cost_usd: 0.01,
        extra: {
          input_tokens: 5,
          output_tokens: 2,
          reasoning_tokens: 1,
          cache_read_tokens: 3,
          cache_write_tokens: 4,
        },
      });
    assert.equal(
      trajectory.steps[4]!.observation?.results[0]?.extra?.is_error,
      true,
    );
    const projected = JSON.stringify(
      createJudgeTranscriptProjection(trajectory),
    );
    assert.equal(projected.includes('Private reasoning.'), false);
    assert.ok(projected.includes('Command failed.'));
    assert.equal(
      Buffer.from((await loadOpenCodeNativeArtifact(input))!.body).toString(),
      body,
    );
  });
  it('omits missing native cost while preserving explicit zero and reported cost', async () => {
    const value = openCodeExport([turns[0]!]);
    Object.assign(value.messages[1]!.info, { cost: undefined });
    Object.assign(value.messages[2]!.info, { cost: 0 });
    const { input, body } = fixture(value);
    const evidence = await loadOpenCodeEvidence(input);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available') return;
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.equal(
      Object.hasOwn(trajectory.steps[1]!.metrics!, 'cost_usd'),
      false,
    );
    assert.equal(trajectory.steps[1]!.metrics?.prompt_tokens, 12);
    assert.equal(trajectory.steps[2]!.metrics?.cost_usd, 0);
    assert.equal(
      Buffer.from((await loadOpenCodeNativeArtifact(input))!.body).toString(),
      body,
    );
  });
  it('rejects malformed native cost rather than treating it as missing', async () => {
    for (const cost of [null, -1, '0.01']) {
      const value = openCodeExport([turns[0]!]);
      Object.assign(value.messages[1]!.info, { cost });
      const evidence = await loadOpenCodeEvidence(fixture(value).input);
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind === 'unavailable')
        assert.equal(evidence.reason.code, 'source_invalid');
    }
  });
  it('rejects wrong session/version/model and ambiguous native identities', async () => {
    const original = openCodeExport(turns);
    const mutations = [
      (v: typeof original) => {
        v.info.id = 'ses_other';
      },
      (v: typeof original) => {
        v.info.version = '1.18.0';
      },
      (v: typeof original) => {
        Object.assign(v.messages[1]!.info, { modelID: 'other' });
      },
      (v: typeof original) => {
        v.messages[1]!.parts[0]!.sessionID = 'ses_other';
      },
      (v: typeof original) => {
        v.messages[1]!.parts.push(v.messages[1]!.parts[0]!);
      },
      (v: typeof original) => {
        v.messages.push(v.messages[0]!);
      },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(original);
      mutate(value);
      const evidence = await loadOpenCodeEvidence(fixture(value).input);
      assert.equal(evidence.kind, 'unavailable');
    }
    assert.equal(
      await loadOpenCodeNativeArtifact(
        fixture({ ...original, info: { ...original.info, id: 'ses_other' } })
          .input,
      ),
      undefined,
    );
  });
  it('falls back for compaction, missing tool completion, unknown conversation, and attachments', async () => {
    for (const replacement of [
      { type: 'compaction', auto: true },
      { type: 'new-conversation-kind' },
      {
        type: 'tool',
        callID: 'call_0',
        tool: 'bash',
        state: { status: 'running', input: {} },
      },
      { type: 'file', mime: 'image/png', url: 'data:secret' },
    ]) {
      const value = openCodeExport(turns);
      value.messages[1]!.parts[2] = {
        ...value.messages[1]!.parts[2],
        ...replacement,
      };
      const test = fixture(value);
      const evidence = await loadOpenCodeEvidence(test.input);
      assert.equal(evidence.kind, 'unavailable');
      if (evidence.kind === 'unavailable')
        assert.equal(evidence.reason.code, 'source_incomplete');
      assert.ok(await loadOpenCodeNativeArtifact(test.input));
    }
  });
  it('requires every observed turn, text, call identity, and tool input in shared selection and verification', async () => {
    const result = await loadOpenCodeEvidence(fixture().input);
    assert.equal(result.kind, 'available');
    if (result.kind !== 'available') return;
    const trajectory = parseAtifTrajectory(result.trajectory);
    const driver = turns.map((turn, i) => ({
      user: turn.prompt,
      assistant: turn.response,
      toolCalls: [
        {
          id: `call_${i}`,
          name: 'bash',
          input: { command: 'printf complete > answer.txt' },
        },
      ],
    }));
    assert.equal(
      trajectoryCoversCompletedTurns(trajectory, driver, result.source),
      true,
    );
    const stale = { ...trajectory, steps: trajectory.steps.slice(0, 3) };
    assert.equal(
      trajectoryCoversCompletedTurns(stale, driver, result.source),
      false,
    );
    for (const key of ['message', 'tool_calls'] as const) {
      const changed = structuredClone(trajectory);
      if (key === 'message') changed.steps[2]!.message = 'Different response';
      else {
        const step = changed.steps[1]!;
        if (step.source === 'agent') delete step.tool_calls;
      }
      assert.equal(
        trajectoryCoversCompletedTurns(changed, driver, result.source),
        false,
      );
    }
    driver[0]!.toolCalls[0]!.input.command = 'different';
    assert.equal(
      trajectoryCoversCompletedTurns(trajectory, driver, result.source),
      false,
    );
  });
  it('bounds malformed exports and propagates cancellation', async () => {
    const input = fixture().input;
    const unavailable = await loadOpenCodeEvidence({
      ...input,
      state: createMemoryWorkspace({ 'session.json': '{' }).readonly,
    });
    assert.equal(unavailable.kind, 'unavailable');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(
      loadOpenCodeEvidence({ ...input, signal: controller.signal }),
      /cancelled/,
    );
    await assert.rejects(
      loadOpenCodeNativeArtifact({ ...input, signal: controller.signal }),
      /cancelled/,
    );
  });
});
