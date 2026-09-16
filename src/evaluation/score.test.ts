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

  it('uses the guideline ratio and gates a clean pass on checks', () => {
    expect(
      scoreEvaluation(
        [
          {guideline: 'one', passed: true, explanation: 'yes'},
          {guideline: 'two', passed: false, explanation: 'no'},
        ],
        [{name: 'file', passed: true}],
      ),
    ).toMatchObject({score: 0.5, status: 'partial'});
  });
});
