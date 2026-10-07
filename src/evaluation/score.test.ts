import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {scoreEvaluation} from './score.js';

describe('scoreEvaluation', () => {
  it('preserves the checks-only score-zero behavior', () => {
    {
      const actual = scoreEvaluation([], [{name: 'file', passed: true}]);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'passed');
      assert.equal(Object.hasOwn(actual, 'schema_version'), false);
    }
  });

  it('gates a clean pass on checks without reducing a full criterion score', () => {
    {
      const actual = scoreEvaluation(
        [
          {criterion: 'one', passed: true, explanation: 'yes'},
          {criterion: 'two', passed: true, explanation: 'yes'},
        ],
        [{name: 'file', passed: false}],
      );
      assert.ok(actual);
      assert.equal(actual.score, 1);
      assert.equal(actual.status, 'partial');
      assert.equal(actual.judging_criteria_passed, 2);
      assert.equal(actual.judging_criteria_total, 2);
    }
  });

  it('does not include deterministic checks in the criterion denominator', () => {
    const criteria = [
      {criterion: 'one', passed: true, explanation: 'yes'},
      {criterion: 'two', passed: false, explanation: 'no'},
    ];
    for (const checks of [[], [{name: 'file', passed: true}], [{name: 'file', passed: false}]]) {
      {
        const actual = scoreEvaluation(criteria, checks);
        assert.ok(actual);
        assert.equal(actual.score, 0.5);
        assert.equal(actual.status, 'partial');
        assert.equal(actual.judging_criteria_passed, 1);
        assert.equal(actual.judging_criteria_total, 2);
      }
    }
  });

  it('requires actual successful checks to establish partial success when no criterion passes', () => {
    const criteria = [{criterion: 'one', passed: false, explanation: 'no'}];
    {
      const actual = scoreEvaluation(criteria, []);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'failed');
    }
    {
      const actual = scoreEvaluation(criteria, [{name: 'file', passed: true}]);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'partial');
    }
    {
      const actual = scoreEvaluation([], [{name: 'file', passed: false}]);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'failed');
      assert.equal(actual.judging_criteria_passed, 0);
      assert.equal(actual.judging_criteria_total, 0);
    }
  });
});
