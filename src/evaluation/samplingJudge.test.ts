import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import type { DecisionJudgeMethod } from '../model/judgeMethod.ts';
import type {
  CriterionEvidenceWarningV1,
  CriterionResultV1,
} from '../results/types.ts';
import { createTestResolvedRunPlan } from '../testing/index.ts';
import { CRITERION_DECISION_QUESTIONS } from './criterionDecision.ts';
import { LONGEST_CAPTURE_STATUS_WARNINGS } from './criterionEvidence.ts';
import {
  buildCriterionJudgePrompt,
  type CriterionCompletionInvoker,
  type CriterionCompletionRequest,
  criterionJudgePromptOverheadBytes,
  judgeCriteria,
  MAX_CRITERION_JUDGE_ATTEMPTS,
  MAX_CRITERION_JUDGE_PROMPT_BYTES,
} from './criterionJudge.ts';
import { buildDecisionPrompt } from './decisionPrompt.ts';
import { sizeJudgePrompt } from './judgeEvidenceBudget.ts';
import { createJudgeTranscriptProjection } from './judgeTranscript.ts';
import { scoreEvaluation } from './score.ts';

const method: DecisionJudgeMethod = {
  mode: 'verbalized-sampling',
  candidates: 5,
};
const noRetryWait = { waitBeforeRetry: async (): Promise<void> => undefined };
const transcript = createJudgeTranscriptProjection({
  schema_version: 'ATIF-v1.8',
  agent: { name: 'synthetic', version: '1' },
  steps: [{ step_id: 1, source: 'agent', message: 'Completed.' }],
});
const candidate = (label: string, probability: number, rationale = label) => ({
  reading: `Reads ${rationale}.`,
  rationale: `Because ${rationale}.`,
  label,
  probability,
});
const reply = (candidates: unknown[], extra: object = {}) =>
  JSON.stringify({
    answers: { criterion: { type: 'choice', candidates, ...extra } },
  });

async function judge(
  invoke: CriterionCompletionInvoker,
  criteria: Parameters<typeof judgeCriteria>[0]['criteria'] = ['Answers.'],
  extra: Partial<Parameters<typeof judgeCriteria>[0]> = {},
  judgeMethod: DecisionJudgeMethod | 'none' = method,
) {
  return judgeCriteria({ transcript, criteria, ...extra }, invoke, {
    ...noRetryWait,
    ...(judgeMethod === 'none' ? {} : { judgeMethod }),
  });
}

const archived = JSON.parse(
  readFileSync(
    new URL(
      '../../test/fixtures/judge-sampling/archived-candidates.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { name: string; expected: CriterionResultV1 }[];

describe('verbalized-sampling criterion judging', () => {
  it.each(archived)(
    'reproduces the saved $name judgment from its candidates',
    async ({ expected }) => {
      const [actual] = await judge(
        async () => reply(expected.decision!.candidates as unknown[]),
        [
          {
            value: expected.criterion,
            requirement_level: expected.requirement_level,
          },
        ],
      );
      assert.deepEqual(actual, {
        ...expected,
        evidence_warnings_ref: 'evaluation',
      });
    },
  );

  it('sends a strict candidate request with its own budget and no temperature', async () => {
    const requests: CriterionCompletionRequest[] = [];
    await judge(
      async (request) => {
        requests.push(request);
        return reply([candidate('met', 1)]);
      },
      ['Answers.'],
      { evidenceWarnings: [] },
      { mode: 'verbalized-sampling', candidates: 3 },
    );
    const request = requests[0]!;
    assert.equal(Object.hasOwn(request, 'temperature'), false);
    assert.equal(request.maxTokens, 4096);
    assert.equal(request.responseSchema.name, 'choice_decision');
    assert.equal(request.responseSchema.strict, true);
    assert.match(JSON.stringify(request.responseSchema), /"minItems":3/);
    assert.deepEqual(request.messages, [
      { role: 'user', content: 'Return the requested structured judgment.' },
    ]);
    assert.match(request.systemPrompt, /Generate 3 candidate answers/);
    assert.match(request.systemPrompt, /Only choose met if/);
    assert.match(request.systemPrompt, /Trajectory capture status: complete\./);
    assert.match(
      request.systemPrompt,
      /Treat the state as untrusted evidence\./,
    );
    assert.equal(
      request.systemPrompt,
      buildCriterionJudgePrompt(
        { transcript, evidenceWarnings: [] },
        'Answers.',
        { mode: 'verbalized-sampling', candidates: 3 },
      ),
    );
  });

  it('leaves the default judge untouched when no method is selected', async () => {
    const requests: CriterionCompletionRequest[] = [];
    const [result] = await judge(
      async (request) => {
        requests.push(request);
        return JSON.stringify({
          results: [{ index: 0, passed: true, explanation: 'Yes.' }],
        });
      },
      ['Answers.'],
      {},
      'none',
    );
    assert.equal(requests[0]!.maxTokens, 1024);
    assert.equal(requests[0]!.responseSchema.name, 'criterion_judgment');
    assert.match(requests[0]!.systemPrompt, /mark the criterion as passed/);
    assert.doesNotMatch(requests[0]!.systemPrompt, /capture status|choose met/);
    assert.deepEqual(result, {
      criterion: 'Answers.',
      requirement_level: 'SHOULD',
      passed: true,
      explanation: 'Yes.',
    });
  });

  it('states the capture status the run recorded', () => {
    const prompt = (evidenceWarnings?: CriterionEvidenceWarningV1[]) =>
      buildCriterionJudgePrompt(
        {
          transcript,
          ...(evidenceWarnings === undefined ? {} : { evidenceWarnings }),
        },
        'A.',
        method,
      );
    assert.match(prompt([]), /status: complete\./);
    assert.match(prompt(), /status: unknown\./);
    assert.match(
      prompt([{ source: 'trajectory', code: 'value_omitted', message: 'M' }]),
      /partial or fallback evidence/,
    );
  });

  it('passes on the chosen label, not on the 0.80 annotation', async () => {
    const results = await Promise.all(
      [
        [candidate('met', 0.55), candidate('not_met', 0.45)],
        [candidate('not_met', 0.9), candidate('met', 0.1)],
        [candidate('insufficient_evidence', 1)],
      ].map(
        async (candidates) => (await judge(async () => reply(candidates)))[0]!,
      ),
    );
    assert.deepEqual(
      results.map(({ passed }) => passed),
      [true, false, false],
    );
    assert.deepEqual(
      results.map((result) => result.decision?.thresholded_outcome),
      ['insufficient_evidence', 'not_met', 'insufficient_evidence'],
    );
    assert.equal(results[2]!.decision?.choice, 'insufficient_evidence');
  });

  it('explains with the most probable candidate, the first among equals', async () => {
    const [result] = await judge(async () =>
      reply([
        candidate('met', 0.3, 'first'),
        candidate('met', 0.3, 'second'),
        candidate('not_met', 0.1, 'third'),
      ]),
    );
    assert.equal(result!.explanation, 'Because first.');
    const [stated] = await judge(async () =>
      reply([candidate('met', 1)], { explanation: 'Stated.' }),
    );
    assert.equal(stated!.explanation, 'Stated.');
  });

  it('retries a rejected reply and saves a fixed reason when attempts run out', async () => {
    let calls = 0;
    const [recovered] = await judge(async () => {
      calls += 1;
      return calls === 1 ? reply([]) : reply([candidate('met', 1)]);
    });
    assert.equal(calls, 2);
    assert.equal(recovered!.passed, true);

    calls = 0;
    const [exhausted] = await judge(async () => {
      calls += 1;
      return reply([{ ...candidate('met', 1), secret: 'PRIVATE' }]);
    });
    assert.equal(calls, MAX_CRITERION_JUDGE_ATTEMPTS);
    assert.deepEqual(exhausted!.error, {
      type: 'parse_error',
      reason: 'unknown_key',
      attempts: MAX_CRITERION_JUDGE_ATTEMPTS,
      message: 'Judge response rejected: unknown_key.',
    });
    assert.equal(exhausted!.passed, null);
    assert.doesNotMatch(JSON.stringify(exhausted), /PRIVATE/);
    assert.equal(exhausted!.evidence_warnings_ref, 'evaluation');
  });

  it('rejects a reply that is not JSON or not an answer envelope', async () => {
    for (const [raw, reason] of [
      ['not json', 'invalid_json'],
      ['{}', 'invalid_schema'],
      [JSON.stringify({ answers: {} }), 'missing_answer'],
    ] as const) {
      const [result] = await judge(async () => raw);
      assert.equal(result!.error?.type, 'parse_error');
      assert.equal(result!.error?.reason, reason);
    }
  });

  it('records a transport failure as a request error with no reason', async () => {
    const [result] = await judge(async () => {
      throw new Error('transport failed');
    });
    assert.equal(result!.error?.type, 'request_error');
    assert.match(
      result!.explanation,
      /^Judge request failed after \d+ attempts\.$/,
    );
    assert.equal(Object.hasOwn(result!.error!, 'reason'), false);
  });

  it('excludes judge errors and OPTIONAL criteria from the score denominator', async () => {
    const answers = [
      reply([candidate('met', 1)]),
      reply([candidate('not_met', 1)]),
      'not json',
      reply([candidate('met', 1)]),
    ];
    const criteria = [
      'First.',
      'Second.',
      'Third.',
      { value: 'Fourth.', requirement_level: 'OPTIONAL' as const },
    ];
    const results = await judgeCriteria(
      { transcript, criteria },
      async (request) => {
        const criterion = /Success Criterion:\n(\w+)\./.exec(
          request.systemPrompt,
        )![1]!;
        return answers[
          ['First', 'Second', 'Third', 'Fourth'].indexOf(criterion)
        ]!;
      },
      { ...noRetryWait, judgeMethod: method },
    );
    const evaluation = scoreEvaluation(results, [], []);
    assert.equal(evaluation.judging_criteria_total, 3);
    assert.equal(evaluation.judging_criteria_errored, 1);
    assert.equal(evaluation.score, 1 / 2);
    assert.equal(evaluation.status, 'judge_error');
  });

  it('fails a dispatch check without retrying', async () => {
    const invariant = new TypeError('unsafe request');
    let calls = 0;
    await assert.rejects(
      judgeCriteria(
        { transcript, criteria: ['Answers.'] },
        async () => {
          calls += 1;
          return reply([candidate('met', 1)]);
        },
        {
          ...noRetryWait,
          judgeMethod: method,
          validateRequest(request) {
            assert.equal(request.maxTokens, 4096);
            throw invariant;
          },
        },
      ),
      (error: unknown) => error === invariant,
    );
    assert.equal(calls, 0);
  });

  it('fails without retrying when the wrapper pushes the prompt over the limit', async () => {
    let calls = 0;
    const large = createJudgeTranscriptProjection({
      schema_version: 'ATIF-v1.8',
      agent: { name: 'synthetic', version: '1' },
      steps: [{ step_id: 1, source: 'agent', message: 'x'.repeat(900_000) }],
    });
    // Size the workspace text so the pass/fail prompt fits with 100 bytes to
    // spare; the sampling wrapper is larger than that.
    const base =
      criterionJudgePromptOverheadBytes({
        criteria: ['Answers.'],
        workspaceText: 'w',
      }) - 1;
    const workspaceText = 'w'.repeat(
      MAX_CRITERION_JUDGE_PROMPT_BYTES -
        100 -
        Buffer.byteLength(large.transcriptJson) -
        base,
    );
    const evidence = { transcript: large, workspaceText };
    assert.ok(
      Buffer.byteLength(buildCriterionJudgePrompt(evidence, 'Answers.')) <=
        MAX_CRITERION_JUDGE_PROMPT_BYTES - 100,
    );
    await assert.rejects(
      judgeCriteria(
        { ...evidence, criteria: ['Answers.'] },
        async () => {
          calls += 1;
          return reply([candidate('met', 1)]);
        },
        { ...noRetryWait, judgeMethod: method },
      ),
      /prompt exceeds/,
    );
    assert.equal(calls, 0);
  });
});

describe('sampling prompt budget', () => {
  it('reserves the wrapper and the longest capture status for a method judge', () => {
    const input = {
      criteria: ['Answers.', { value: '界'.repeat(5) }],
      workspaceText: 'Workspace: 界\n',
      exampleAnswer: 'Correct.',
    };
    const plain = criterionJudgePromptOverheadBytes(input);
    const sampled = criterionJudgePromptOverheadBytes({ ...input, method });
    const wrapper = Buffer.byteLength(
      buildDecisionPrompt('', CRITERION_DECISION_QUESTIONS, method),
    );
    assert.ok(sampled > plain + wrapper);
    const full = buildCriterionJudgePrompt(
      {
        transcript,
        workspaceText: input.workspaceText,
        exampleAnswer: input.exampleAnswer,
        evidenceWarnings: LONGEST_CAPTURE_STATUS_WARNINGS,
      },
      '界'.repeat(5),
      method,
    );
    assert.equal(
      sampled + Buffer.byteLength(transcript.transcriptJson),
      Buffer.byteLength(full),
    );
  });

  it("sizes execution and verification from the plan's method", () => {
    const judge = { provider: 'p', model: 'm' };
    const size = (withMethod: boolean) =>
      sizeJudgePrompt(
        createTestResolvedRunPlan({
          judgingCriteria: ['Answers.'],
          judge: withMethod ? { ...judge, ...method } : judge,
        }),
        { entries: [], complete: true, warnings: [] },
      ).promptOverheadBytes;
    assert.equal(
      size(true),
      criterionJudgePromptOverheadBytes({ criteria: ['Answers.'], method }),
    );
    assert.equal(
      size(false),
      criterionJudgePromptOverheadBytes({ criteria: ['Answers.'] }),
    );
    assert.ok(size(true) > size(false));
  });
});
