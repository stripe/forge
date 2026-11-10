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
  MAX_FAILURE_NATIVE_SOURCE_BYTES,
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
        ...(requested ? { reason: 'not_supported' } : {}),
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
    assert.equal(saved.record.native_log.through_turn, 1);
    assert.equal(saved.record.native_log.source_bytes, native.body.length);
    assert.ok(
      Buffer.byteLength(saved.bodies.native_log!) <= MAX_FAILURE_EVIDENCE_BYTES,
    );
    assert.match(saved.bodies.native_log!, /\[REDACTED\]$/);
    assert.doesNotMatch(saved.bodies.native_log!, /secret-value/);
    assert.equal(
      recorder.finish({ artifact: native }).record.native_log.capture_point,
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
    assert.equal(saved.record.native_log.reason, 'identity_conflict');
    assert.equal(saved.bodies.native_log, undefined);
  });

  it('masks a secret that crosses the start of the retained native tail', () => {
    const saved = fixture().finish({
      artifact: {
        format: 'claude-code-jsonl',
        sessionId: 'session-1',
        body: Buffer.from(SECRET + 'x'.repeat(MAX_FAILURE_EVIDENCE_BYTES - 5)),
        mediaType: 'text/plain',
        extension: 'jsonl',
      },
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
      artifact: {
        format: SECRET,
        sessionId: 'session-1',
        body: Buffer.from(SECRET),
        mediaType: 'text/plain',
        extension: 'txt',
      },
    });
    assert.equal(unsupported.record.native_log.state, 'unavailable');
    assert.equal(unsupported.record.native_log.reason, 'not_supported');
    assert.equal(
      broken.finish().record.partial_trajectory.reason,
      'read_failed',
    );
    assert.deepEqual(unsupported.bodies, {});
  });

  for (const escaped of [false, true])
    it(`retains a single oversized turn with ${escaped ? 'escaped' : 'plain'} tool identifiers as truncated ATIF`, () => {
      const recorder = fixture();
      const content = escaped ? '\u0001' : 'x';
      recorder.completed(content.repeat(6000), {
        sessionId: 'session-1',
        text: content.repeat(6000),
        toolCalls: Array.from({ length: 30 }, (_, index) => ({
          id: `id-${index}-${content.repeat(5000)}`,
          name: content.repeat(5000),
          input: { secret: SECRET },
        })),
      });
      const saved = recorder.finish();
      assert.equal(saved.record.partial_trajectory.state, 'truncated');
      assert.equal(saved.record.partial_trajectory.completed_turns, 1);
      assert.equal(saved.record.partial_trajectory.retained_turns, 1);
      assert.equal(saved.record.partial_trajectory.tool_calls, 30);
      const body = saved.bodies.partial_trajectory!;
      assert.ok(Buffer.byteLength(body) <= MAX_FAILURE_EVIDENCE_BYTES);
      const parsed = parseAtifTrajectory(JSON.parse(body));
      assert.equal(parsed.extra!.truncated, true);
      assert.equal(parsed.steps.length, 2);
      const calls = parsed.steps[1]!.tool_calls!;
      assert.ok(calls.length > 0 && calls.length <= 20);
      if (escaped) assert.ok(calls.length < 20);
      for (const call of calls) {
        assert.ok(Buffer.byteLength(call.tool_call_id) <= 256);
        assert.ok(Buffer.byteLength(call.function_name) <= 256);
        assert.equal(call.extra!.arguments_omitted, true);
      }
    });

  it('keeps closed failure reasons and accepts older evidence with no reason', () => {
    for (const reason of [
      'too_large',
      'timed_out',
      'identity_conflict',
      'not_supported',
      'read_failed',
      'not_started',
    ] as const) {
      const record = fixture().finish({ reason }).record;
      assert.equal(record.native_log.state, 'unavailable');
      assert.equal(record.native_log.reason, reason);
      assert.deepEqual(failureEvidenceSchema.parse(record), record);
      const old = structuredClone(record);
      delete old.native_log.reason;
      assert.deepEqual(failureEvidenceSchema.parse(old), old);
    }
    const oversized = fixture().finish({
      artifact: {
        format: 'claude-code-jsonl',
        sessionId: 'session-1',
        body: Buffer.alloc(MAX_FAILURE_NATIVE_SOURCE_BYTES + 1),
        mediaType: 'text/plain',
        extension: 'jsonl',
      },
    });
    assert.equal(oversized.record.native_log.reason, 'too_large');
    assert.equal(oversized.bodies.native_log, undefined);
  });

  it('labels an older completed export with the turn it actually covers', () => {
    const recorder = fixture();
    recorder.nativeSession({
      format: 'opencode-session-json',
      sessionId: 'session-1',
      body: Buffer.from('first export'),
      mediaType: 'application/json',
      extension: 'json',
    });
    recorder.completed('First', {
      sessionId: 'session-1',
      text: 'One',
      toolCalls: [],
    });
    recorder.nativeSessionUnavailable('too_large');
    recorder.completed('Second', {
      sessionId: 'session-1',
      text: 'Two',
      toolCalls: [],
    });
    const saved = recorder.finish({ reason: 'read_failed' });
    assert.equal(saved.record.native_log.through_turn, 1);
    assert.equal(saved.record.partial_trajectory.completed_turns, 2);
    assert.equal(saved.bodies.native_log, 'first export');
    assert.equal(saved.record.native_log.reason, 'read_failed');
    const timedOut = recorder.finish({ reason: 'timed_out' });
    assert.equal(timedOut.record.native_log.through_turn, 1);
    assert.equal(timedOut.record.native_log.reason, 'timed_out');
  });

  it('accepts old exports without coverage and rejects invented turn coverage', () => {
    const recorder = fixture();
    recorder.nativeSession({
      format: 'opencode-session-json',
      sessionId: 'session-1',
      body: Buffer.from('export'),
      mediaType: 'application/json',
      extension: 'json',
    });
    recorder.completed('Prompt', {
      sessionId: 'session-1',
      text: 'Answer',
      toolCalls: [],
    });
    const saved = recorder.finish();
    const descriptor = { bytes: 6, sha256: 'a'.repeat(64) };
    const record = {
      partial_trajectory: {
        ...saved.record.partial_trajectory,
        artifact: descriptor,
      },
      native_log: { ...saved.record.native_log, artifact: descriptor },
    };
    assert.deepEqual(failureEvidenceSchema.parse(record), record);
    const old = structuredClone(record);
    delete old.native_log.through_turn;
    assert.deepEqual(failureEvidenceSchema.parse(old), old);
    for (const native of [
      { ...record.native_log, through_turn: 2 },
      { ...record.native_log, through_turn: 0 },
      { ...record.native_log, capture_point: 'failure' },
    ])
      assert.equal(
        failureEvidenceSchema.safeParse({ ...record, native_log: native })
          .success,
        false,
      );
  });

  it('rejects unknown fields and contradictory evidence states', () => {
    const saved = fixture().finish().record;
    assert.deepEqual(failureEvidenceSchema.parse(saved), saved);
    for (const invalid of [
      { ...saved, prompt: SECRET },
      { ...saved, native_log: { ...saved.native_log, url: SECRET } },
      { ...saved, native_log: { ...saved.native_log, reason: SECRET } },
      { ...saved, native_log: { ...saved.native_log, through_turn: 1 } },
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
