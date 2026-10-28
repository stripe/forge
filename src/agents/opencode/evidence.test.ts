import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  OPEN_CODE_MODEL,
  OPEN_CODE_SESSION,
  openCodeExport,
} from '../../../test/support/opencode.ts';
import { parseAtifTrajectory } from '../../atif/index.ts';
import { createJudgeTranscriptProjection } from '../../evaluation/judgeTranscript.ts';
import { trajectoryCoversCompletedTurns } from '../../evidence/selection.ts';
import { createMemoryWorkspace } from '../../testing/index.ts';
import {
  loadOpenCodeEvidence,
  loadOpenCodeNativeArtifact,
} from './evidence.ts';

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
    assert.equal(trajectory.steps[1]!.metrics?.cached_tokens, 3);
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

it('keeps native transcript evidence while omitting malformed optional usage metrics', async () => {
  for (const tokens of [
    null,
    'invalid',
    { input: 1.5, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
  ]) {
    const value = openCodeExport(turns);
    Object.assign(value.messages[1]!.info, { tokens });
    const evidence = await loadOpenCodeEvidence(fixture(value).input);
    assert.equal(evidence.kind, 'available');
    if (evidence.kind !== 'available') continue;
    const trajectory = parseAtifTrajectory(evidence.trajectory);
    assert.equal(trajectory.steps[1]!.metrics, undefined);
    assert.equal(trajectory.steps[1]!.tool_calls!.length, 1);
    assert.ok(
      evidence.warnings.some((warning) => warning.code === 'value_omitted'),
    );
    assert.ok(!JSON.stringify(evidence.warnings).includes('invalid'));
  }
});
