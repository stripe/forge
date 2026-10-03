import {describe, it} from 'node:test';

import {expect} from '../../test/support/expect.js';
import {scoreEvaluation} from './score.js';

describe('scoreEvaluation', () => {
  it('preserves the checks-only score-zero behavior', () => {
    expect(scoreEvaluation([], [{name: 'file', passed: true}])).toMatchObject({
      score: 0,
      status: 'passed',
    });
  });

  it('gates a clean pass on checks without reducing a full guideline score', () => {
    expect(
      scoreEvaluation(
        [
          {guideline: 'one', passed: true, explanation: 'yes'},
          {guideline: 'two', passed: true, explanation: 'yes'},
        ],
        [{name: 'file', passed: false}],
      ),
    ).toMatchObject({score: 1, status: 'partial', guidelines_passed: 2, guidelines_total: 2});
  });

  it('does not include deterministic checks in the guideline denominator', () => {
    const guidelines = [
      {guideline: 'one', passed: true, explanation: 'yes'},
      {guideline: 'two', passed: false, explanation: 'no'},
    ];
    for (const checks of [[], [{name: 'file', passed: true}], [{name: 'file', passed: false}]]) {
      expect(scoreEvaluation(guidelines, checks)).toMatchObject({
        score: 0.5, status: 'partial', guidelines_passed: 1, guidelines_total: 2,
      });
    }
  });

  it('requires actual successful checks to establish partial success when no guideline passes', () => {
    const guidelines = [{guideline: 'one', passed: false, explanation: 'no'}];
    expect(scoreEvaluation(guidelines, [])).toMatchObject({score: 0, status: 'failed'});
    expect(scoreEvaluation(guidelines, [{name: 'file', passed: true}])).toMatchObject({
      score: 0, status: 'partial',
    });
    expect(scoreEvaluation([], [{name: 'file', passed: false}])).toMatchObject({
      score: 0, status: 'failed', guidelines_passed: 0, guidelines_total: 0,
    });
  });
});
