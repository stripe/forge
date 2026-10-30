import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  buildCriterionJudgePrompt,
  criterionJudgePromptOverheadBytes,
  MAX_CRITERION_JUDGE_PROMPT_BYTES,
} from './criterionJudge.ts';
import {
  LONGEST_CAPTURE_STATUS_WARNINGS,
  renderTrajectoryCaptureStatus,
} from './criterionEvidence.ts';
import { selectJudgeEvidence } from './judgeEvidenceBudget.ts';
import { createJudgeTranscriptProjection } from './judgeTranscript.ts';

const transcript = createJudgeTranscriptProjection({
  schema_version: 'ATIF-v1.8',
  agent: { name: 'test', version: '1' },
  steps: [{ step_id: 1, source: 'agent', message: 'Done. 界🙂' }],
});
const transcriptBytes = Buffer.byteLength(transcript.transcriptJson, 'utf8');

describe('whole-prompt judge evidence budget', () => {
  it('reserves the longest capture-status line for every evidence source', () => {
    const reserved = Buffer.byteLength(
      renderTrajectoryCaptureStatus(LONGEST_CAPTURE_STATUS_WARNINGS),
    );
    const trajectory = (code: string) => [
      { source: 'trajectory' as const, code, message: 'm' },
    ];
    for (const warnings of [
      undefined,
      [],
      trajectory('evidence_completeness_unknown'),
      trajectory('trajectory_incomplete'),
      trajectory('value_omitted'),
      trajectory('source_unavailable'),
    ]) {
      assert.ok(
        Buffer.byteLength(renderTrajectoryCaptureStatus(warnings)) <= reserved,
      );
    }
  });

  for (const workspaceText of [undefined, 'Workspace: 界🙂\n']) {
    for (const exampleAnswer of [undefined, 'Correct answer: 界🙂']) {
      it(`measures exact prompt bytes with workspace=${!!workspaceText}, example=${!!exampleAnswer}`, () => {
        const input = {
          ...(workspaceText === undefined ? {} : { workspaceText }),
          ...(exampleAnswer === undefined ? {} : { exampleAnswer }),
        };
        // The multibyte criterion is shorter in code units but larger in UTF-8.
        const criteria = ['a'.repeat(10), { value: '界'.repeat(5) }];
        const overhead = criterionJudgePromptOverheadBytes({
          ...input,
          criteria,
        });
        const fullPrompt = buildCriterionJudgePrompt(
          {
            ...input,
            transcript,
            evidenceWarnings: LONGEST_CAPTURE_STATUS_WARNINGS,
          },
          '界'.repeat(5),
        );
        assert.equal(
          overhead + transcriptBytes,
          Buffer.byteLength(fullPrompt, 'utf8'),
        );
        const result = selectJudgeEvidence({
          promptOverheadBytes: overhead,
          nativeTranscriptBytes: transcriptBytes,
          driverTranscriptBytes: 3,
        });
        assert.equal(
          result.transcriptBudgetBytes,
          MAX_CRITERION_JUDGE_PROMPT_BYTES - overhead,
        );
        assert.equal(result.evidence, 'native');
      });
    }
  }

  it('includes native and driver evidence at the boundary, and degrades one byte over', () => {
    const promptOverheadBytes = MAX_CRITERION_JUDGE_PROMPT_BYTES - 100;
    assert.deepEqual(
      selectJudgeEvidence({
        promptOverheadBytes,
        nativeTranscriptBytes: 100,
        driverTranscriptBytes: 50,
      }),
      { transcriptBudgetBytes: 100, evidence: 'native' },
    );
    assert.equal(
      selectJudgeEvidence({
        promptOverheadBytes,
        nativeTranscriptBytes: 101,
        driverTranscriptBytes: 100,
      }).evidence,
      'driver',
    );
    assert.equal(
      selectJudgeEvidence({
        promptOverheadBytes,
        nativeTranscriptBytes: 101,
        driverTranscriptBytes: 101,
      }).evidence,
      'omitted',
    );
    assert.equal(
      selectJudgeEvidence({ promptOverheadBytes, driverTranscriptBytes: 100 })
        .evidence,
      'driver',
    );
    assert.equal(
      selectJudgeEvidence({ promptOverheadBytes, driverTranscriptBytes: 101 })
        .evidence,
      'omitted',
    );
  });

  it('reserves the three empty-transcript bytes at the mandatory-prompt boundary', () => {
    assert.deepEqual(
      selectJudgeEvidence({
        promptOverheadBytes: MAX_CRITERION_JUDGE_PROMPT_BYTES - 3,
        driverTranscriptBytes: 4,
      }),
      { transcriptBudgetBytes: 3, evidence: 'omitted' },
    );
    for (const extraBytes of [1, 2, 3]) {
      assert.throws(
        () =>
          selectJudgeEvidence({
            promptOverheadBytes:
              MAX_CRITERION_JUDGE_PROMPT_BYTES - 3 + extraBytes,
            driverTranscriptBytes: 4,
          }),
        /Mandatory criterion judge prompt exceeds/,
      );
    }
    assert.throws(
      () =>
        buildCriterionJudgePrompt(
          {
            transcript,
            workspaceText: 'x'.repeat(MAX_CRITERION_JUDGE_PROMPT_BYTES),
          },
          'Criterion',
        ),
      /prompt exceeds/,
    );
  });

  it('can select native evidence before driver evidence is built', () => {
    assert.equal(
      selectJudgeEvidence({
        promptOverheadBytes: 100,
        nativeTranscriptBytes: 100,
      }).evidence,
      'native',
    );
  });
});
