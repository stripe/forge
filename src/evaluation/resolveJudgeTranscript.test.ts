import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createNormalizedTrajectory } from '../atif/index.ts';
import { MAX_CRITERION_JUDGE_PROMPT_BYTES } from './criterionJudge.ts';
import {
  createJudgeTranscriptProjection,
  EMPTY_JUDGE_TRANSCRIPT,
  parseJudgeTranscriptProjection,
} from './judgeTranscript.ts';
import {
  type RedactedJudgeEvidence,
  resolveJudgeTranscript,
} from './resolveJudgeTranscript.ts';

function candidate(native: boolean, text: string): RedactedJudgeEvidence {
  return {
    replacements: native ? 3 : 2,
    evidence: createNormalizedTrajectory({
      trajectory: {
        schema_version: 'ATIF-v1.8',
        agent: { name: 'test', version: '1' },
        steps: [{ step_id: 1, source: 'agent', message: text }],
      },
      provenance: {
        adapter: { id: 'test', version: '1' },
        source: native
          ? { kind: 'native_log', format: 'test' }
          : { kind: 'driver_fallback', format: 'forge-driver-turns' },
      },
      completeness: native ? 'complete' : 'fallback',
      warnings: native ? [] : [{ code: 'fallback_used', message: 'Fallback.' }],
    }),
  };
}

function bytes(selected: RedactedJudgeEvidence): number {
  return Buffer.byteLength(
    createJudgeTranscriptProjection(selected.evidence.trajectory)
      .transcriptJson,
    'utf8',
  );
}

describe('resolveJudgeTranscript', () => {
  it('keeps native evidence at the exact boundary without building a driver', () => {
    const selected = candidate(true, '界🙂');
    const resolved = resolveJudgeTranscript({
      selected,
      promptOverheadBytes: MAX_CRITERION_JUDGE_PROMPT_BYTES - bytes(selected),
      buildDriver: () =>
        assert.fail('Under-budget native evidence needs no driver.'),
    });
    assert.equal(resolved.redacted, selected);
    assert.equal(resolved.reason, 'within_budget');
    assert.deepEqual(
      resolved.transcript,
      createJudgeTranscriptProjection(selected.evidence.trajectory),
    );
  });

  it('builds a driver once after native overflow and retains its replacement count', () => {
    const selected = candidate(true, 'x'.repeat(1_000));
    const original = structuredClone(selected);
    const driver = candidate(false, 'Done.');
    let calls = 0;
    const resolved = resolveJudgeTranscript({
      selected,
      promptOverheadBytes: MAX_CRITERION_JUDGE_PROMPT_BYTES - bytes(driver),
      buildDriver: (reason) => {
        calls += 1;
        assert.equal(reason.code, 'value_omitted');
        assert.match(reason.message, /Native evidence exceeded/);
        return driver;
      },
    });
    assert.equal(calls, 1);
    assert.equal(resolved.redacted, driver);
    assert.equal(resolved.reason, 'native_budget_exceeded');
    assert.deepEqual(selected, original);
  });

  for (const native of [false, true]) {
    it(`omits an over-budget driver and preserves its input (native=${native})`, () => {
      const selected = candidate(native, 'x'.repeat(1_000));
      const driver = native ? candidate(false, 'y'.repeat(500)) : selected;
      const original = structuredClone(driver);
      let calls = 0;
      const resolved = resolveJudgeTranscript({
        selected,
        promptOverheadBytes:
          MAX_CRITERION_JUDGE_PROMPT_BYTES - bytes(driver) + 1,
        buildDriver: () => {
          calls += 1;
          return driver;
        },
      });
      assert.equal(calls, native ? 1 : 0);
      assert.equal(resolved.reason, 'judge_budget_exceeded');
      assert.equal(resolved.transcript, EMPTY_JUDGE_TRANSCRIPT);
      assert.deepEqual(
        parseJudgeTranscriptProjection(resolved.transcript),
        EMPTY_JUDGE_TRANSCRIPT,
      );
      assert.equal(resolved.redacted.replacements, driver.replacements);
      assert.ok(
        resolved.redacted.evidence.warnings.some(
          ({ code, message }) =>
            code === 'value_omitted' &&
            message.includes('workspace evidence only'),
        ),
      );
      assert.deepEqual(driver, original);
    });
  }

  it('rejects oversized mandatory text before building driver evidence', () => {
    assert.throws(
      () =>
        resolveJudgeTranscript({
          selected: candidate(true, 'Done.'),
          promptOverheadBytes: MAX_CRITERION_JUDGE_PROMPT_BYTES - 2,
          buildDriver: () =>
            assert.fail('Mandatory prompt overflow needs no driver.'),
        }),
      /Mandatory criterion judge prompt exceeds/,
    );
  });
});
