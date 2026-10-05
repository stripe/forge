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

  it('gates a clean pass on checks without reducing a full guideline score', () => {
    {
      const actual = scoreEvaluation(
        [
          {guideline: 'one', passed: true, explanation: 'yes'},
          {guideline: 'two', passed: true, explanation: 'yes'},
        ],
        [{name: 'file', passed: false}],
      );
      assert.ok(actual);
      assert.equal(actual.score, 1);
      assert.equal(actual.status, 'partial');
      assert.equal(actual.guidelines_passed, 2);
      assert.equal(actual.guidelines_total, 2);
    }
  });

  it('does not include deterministic checks in the guideline denominator', () => {
    const guidelines = [
      {guideline: 'one', passed: true, explanation: 'yes'},
      {guideline: 'two', passed: false, explanation: 'no'},
    ];
    for (const checks of [[], [{name: 'file', passed: true}], [{name: 'file', passed: false}]]) {
      {
        const actual = scoreEvaluation(guidelines, checks);
        assert.ok(actual);
        assert.equal(actual.score, 0.5);
        assert.equal(actual.status, 'partial');
        assert.equal(actual.guidelines_passed, 1);
        assert.equal(actual.guidelines_total, 2);
      }
    }
  });

  it('requires actual successful checks to establish partial success when no guideline passes', () => {
    const guidelines = [{guideline: 'one', passed: false, explanation: 'no'}];
    {
      const actual = scoreEvaluation(guidelines, []);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'failed');
    }
    {
      const actual = scoreEvaluation(guidelines, [{name: 'file', passed: true}]);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'partial');
    }
    {
      const actual = scoreEvaluation([], [{name: 'file', passed: false}]);
      assert.ok(actual);
      assert.equal(actual.score, 0);
      assert.equal(actual.status, 'failed');
      assert.equal(actual.guidelines_passed, 0);
      assert.equal(actual.guidelines_total, 0);
    }
  });
});
