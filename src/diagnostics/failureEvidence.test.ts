import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseAtifTrajectory } from '../atif/index.ts';
import { createRedactedTail } from '../security/diagnosticRedaction.ts';
import { redactSecrets } from '../security/redaction.ts';
import type { AgentDiagnosticsCapture } from './agent.ts';
import {
  createFailureEvidenceCapture,
  failureEvidenceSchema,
  MAX_FAILURE_EVIDENCE_BYTES,
} from './failureEvidence.ts';

const SECRET = 'synthetic-secret-value';
function capture(restrictedExcerpts = true): AgentDiagnosticsCapture {
  return {
    restrictedExcerpts,
    redact: (text) => redactSecrets(text, [SECRET]).value,
    redactedTail: (bytes) => createRedactedTail([SECRET], bytes),
    async record() {},
  };
}
function fixture(capability = capture(), requested = true) {
  return createFailureEvidenceCapture({
    capture: capability,
    requested,
    identity: { name: 'test-agent', version: '1' },
    model: 'test-model',
  });
}

describe('failure evidence projection', () => {
  it('keeps the latest completed turns within the byte bound, with explicit text, turn and tool omissions', () => {
    const recorder = fixture();
    for (let index = 0; index < 40; index++)
      recorder.completed(`Turn ${index}: ${SECRET}`, {
        text: `Answer ${index}: ${SECRET} ${'x'.repeat(6000)}`,
        sessionId: 'session-1',
        toolCalls: Array.from({ length: 30 }, (_, i) => ({
          id: `call-${index}-${i}`,
          name: 'test_tool',
          input: { command: SECRET },
        })),
      });
    const saved = recorder.finish();
    assert.equal(saved.record.partial_trajectory.state, 'truncated');
    assert.equal(saved.record.partial_trajectory.completed_turns, 40);
    assert.equal(saved.record.partial_trajectory.tool_calls, 1200);
    assert.ok(saved.record.partial_trajectory.retained_turns > 0);
    assert.ok(saved.record.partial_trajectory.retained_turns < 40);
    const body = saved.bodies.partial_trajectory!;
    assert.ok(Buffer.byteLength(body) <= MAX_FAILURE_EVIDENCE_BYTES);
    assert.doesNotMatch(body, new RegExp(SECRET));
    const trajectory = parseAtifTrajectory(JSON.parse(body));
    assert.equal(trajectory.steps.at(-2)!.message, 'Turn 39: [REDACTED]');
    assert.match(
      String(trajectory.steps.at(-1)!.message),
      /^Answer 39: \[REDACTED\]/,
    );
    assert.match(
      String(trajectory.steps.at(-1)!.message),
      /diagnostic text truncated/,
    );
    assert.ok(
      trajectory.steps.every((step, index) => step.step_id === index + 1),
    );
    const last = trajectory.steps.at(-1)!;
    assert.equal(last.source, 'agent');
    assert.equal(last.tool_calls!.length, 20);
    assert.equal(last.tool_calls![0]!.extra!.arguments_omitted, true);
  });

  for (const requested of [false, true])
    it(`retains only counts when text is ${requested ? 'unsupported' : 'disabled'}`, () => {
      const recorder = fixture(
        {
          ...capture(false),
          redact() {
            throw new Error('Text must stay untouched.');
          },
          redactedTail() {
            throw new Error('Text must stay untouched.');
          },
        },
        requested,
      );
      recorder.completed(SECRET, {
        text: SECRET,
        sessionId: 'session-1',
        toolCalls: [{ name: 'test', input: SECRET }],
      });
      recorder.nativeSession({
        format: 'claude-code-jsonl',
        sessionId: 'session-1',
        body: Buffer.from(SECRET),
        mediaType: 'text/plain',
        extension: 'jsonl',
      });
      const saved = recorder.finish();
      assert.deepEqual(saved.bodies, {});
      assert.deepEqual(saved.record.partial_trajectory, {
        state: requested ? 'unsupported' : 'disabled',
        completed_turns: 1,
        tool_calls: 1,
        retained_turns: 0,
      });
      assert.equal(
        saved.record.native_log.state,
        requested ? 'unsupported' : 'disabled',
      );
    });

  it('redacts native content before retaining its tail and marks its capture point', () => {
    const recorder = fixture();
    const native = {
      format: 'claude-code-jsonl',
      sessionId: 'session-1',
      body: Buffer.from(`${'x'.repeat(65530)}${SECRET}`),
      mediaType: 'text/plain',
      extension: 'jsonl',
    };
    recorder.nativeSession(native);
    recorder.completed('Prompt', {
      sessionId: 'session-1',
      text: 'Answer',
      toolCalls: [],
    });
    const saved = recorder.finish();
    assert.equal(saved.record.native_log.state, 'truncated');
    assert.equal(saved.record.native_log.capture_point, 'completed_turn');
    assert.equal(saved.record.native_log.source_bytes, native.body.length);
    assert.ok(
      Buffer.byteLength(saved.bodies.native_log!) <= MAX_FAILURE_EVIDENCE_BYTES,
    );
    assert.match(saved.bodies.native_log!, /\[REDACTED\]$/);
    assert.doesNotMatch(saved.bodies.native_log!, /secret-value/);
    assert.equal(
      recorder.finish(native).record.native_log.capture_point,
      'failure',
    );
  });

  it('rejects a completed export for another session', () => {
    const recorder = fixture();
    recorder.nativeSession({
      format: 'opencode-session-json',
      sessionId: 'other-session',
      body: Buffer.from('private native data'),
      mediaType: 'application/json',
      extension: 'json',
    });
    recorder.completed('Prompt', {
      sessionId: 'session-1',
      text: 'Answer',
      toolCalls: [],
    });
    const saved = recorder.finish();
    assert.equal(saved.record.native_log.state, 'unavailable');
    assert.equal(saved.bodies.native_log, undefined);
  });

  it('masks a secret that crosses the start of the retained native tail', () => {
    const saved = fixture().finish({
      format: 'claude-code-jsonl',
      sessionId: 'session-1',
      body: Buffer.from(SECRET + 'x'.repeat(MAX_FAILURE_EVIDENCE_BYTES - 5)),
      mediaType: 'text/plain',
      extension: 'jsonl',
    });
    assert.doesNotMatch(saved.bodies.native_log!, /value|secret/);
  });
  it('distinguishes no completed turns from a failed projection and rejects invented formats', () => {
    const empty = fixture().finish();
    assert.equal(empty.record.partial_trajectory.state, 'empty');
    assert.equal(empty.record.native_log.state, 'unavailable');
    const broken = fixture({
      ...capture(),
      redact() {
        throw new Error('Unavailable redaction');
      },
    });
    broken.completed('Prompt', {
      sessionId: 'session-1',
      text: 'Answer',
      toolCalls: [],
    });
    assert.equal(
      broken.finish().record.partial_trajectory.state,
      'unavailable',
    );
    const unsupported = fixture().finish({
      format: SECRET,
      sessionId: 'session-1',
      body: Buffer.from(SECRET),
      mediaType: 'text/plain',
      extension: 'txt',
    });
    assert.equal(unsupported.record.native_log.state, 'unavailable');
    assert.deepEqual(unsupported.bodies, {});
  });

  it('rejects unknown fields and contradictory evidence states', () => {
    const saved = fixture().finish().record;
    assert.deepEqual(failureEvidenceSchema.parse(saved), saved);
    for (const invalid of [
      { ...saved, prompt: SECRET },
      { ...saved, native_log: { ...saved.native_log, url: SECRET } },
      {
        ...saved,
        partial_trajectory: { ...saved.partial_trajectory, state: 'available' },
      },
      {
        ...saved,
        partial_trajectory: { ...saved.partial_trajectory, retained_turns: 1 },
      },
      {
        ...saved,
        partial_trajectory: { ...saved.partial_trajectory, completed_turns: 1 },
      },
    ])
      assert.equal(failureEvidenceSchema.safeParse(invalid).success, false);
  });
});
