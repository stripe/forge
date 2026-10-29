import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseEvalCase, parseEvalCaseYaml } from './parse.ts';

const CASE = {
  id: 'sample/requirements',
  version: '0.1.0',
  task: 'Implement a payment endpoint.',
};

describe('criterion requirement levels', () => {
  it('normalizes string shorthand and omitted object levels to unlabeled SHOULD', () => {
    const text = 'The integration creates a Checkout Session.';
    const object = { value: `  ${text}  ` };
    const expected = { value: text, requirement_level: 'SHOULD' };
    assert.deepEqual(
      parseEvalCase({ ...CASE, judging_criteria: [`  ${text}  `, object] })
        .judging_criteria,
      [expected, expected],
    );
    assert.deepEqual(object, { value: `  ${text}  ` });
    assert.deepEqual(
      parseEvalCaseYaml(`id: sample/shorthand
version: 0.1.0
task: Complete the task.
judging_criteria:
  - ${text}
`).judging_criteria,
      [expected],
    );
  });

  it('materializes omitted classifications as SHOULD independently of RFC wording', () => {
    for (const requirement_level of [
      undefined,
      'SHOULD',
      'OPTIONAL',
    ] as const) {
      const criteria = [
        {
          value: 'MUST create one subscription.',
          ...(requirement_level === undefined ? {} : { requirement_level }),
        },
        { value: 'Returns a response.' },
      ];
      assert.deepEqual(
        parseEvalCase({ ...CASE, judging_criteria: criteria }).judging_criteria,
        criteria.map((criterion) => ({
          ...criterion,
          requirement_level: criterion.requirement_level ?? 'SHOULD',
        })),
      );
      assert.equal(Object.hasOwn(criteria[1]!, 'requirement_level'), false);
    }
  });

  it('requires uppercase MUST wording only for MUST classifications', () => {
    for (const value of [
      'MUST create one subscription.',
      '**MUST NOT** duplicate a subscription.',
      'MUST\nNOT duplicate a subscription.',
    ]) {
      const criterion = {
        value,
        requirement_level: 'MUST',
      };
      assert.equal(
        parseEvalCase({ ...CASE, judging_criteria: [criterion] })
          .judging_criteria[0]?.requirement_level,
        'MUST',
      );
    }
    for (const value of [
      'Creates one subscription.',
      'must create one subscription.',
      'Must create one subscription.',
      'Checks MUSTARD and MUST_NOT identifiers.',
    ]) {
      assert.throws(
        () =>
          parseEvalCase({
            ...CASE,
            judging_criteria: [
              {
                value,
                requirement_level: 'MUST',
              },
            ],
          }),
        /MUST criteria must use the uppercase RFC keyword MUST/,
      );
    }
  });

  it('rejects invalid classifications and the removed scoring flag', () => {
    for (const metadata of [
      { requirement_level: 'must' },
      { requirement_level: 'EXCLUDE' },
      { requirement_level: 'MUST NOT' },
      { requirement_level: 'SHOULD NOT' },
      { requirement_level: 'MAY' },
      { requirement_level: null },
      { criteria_requirement: 'SHOULD' },
      { requirement_level: false },
      { include_in_score: false },
      { include_in_score: true, requirement_level: 'SHOULD' },
    ]) {
      assert.throws(() =>
        parseEvalCase({
          ...CASE,
          judging_criteria: [
            {
              value: 'Creates one subscription.',
              ...metadata,
            },
          ],
        }),
      );
    }
    for (const criterion of ['', '  ', 'text\0', 'x'.repeat(64 * 1024 + 1)]) {
      assert.throws(() =>
        parseEvalCase({ ...CASE, judging_criteria: [criterion] }),
      );
    }
  });
});
