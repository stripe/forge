import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseEvalCase } from './parse.ts';
import { REQUIREMENT_LEVELS } from './types.ts';

const CASE = {
  id: 'sample/requirements',
  task: 'Implement a payment endpoint.',
};

describe('criterion requirement levels', () => {
  it('requires an explicit classification for every criterion', () => {
    for (const requirement_level of REQUIREMENT_LEVELS) {
      const criterion = {
        value: 'Sets billing mode to flexible.',
        requirement_level,
      };
      assert.deepEqual(
        parseEvalCase({ ...CASE, judging_criteria: [criterion] })
          .judging_criteria,
        [criterion],
      );
    }
    for (const criterion of [
      'Sets billing mode to flexible.',
      'MUST set billing mode to flexible.',
      { value: 'Sets billing mode to flexible.' },
      { value: 'Sets billing mode to flexible.', requirement_level: 'must' },
      {
        value: 'Sets billing mode to flexible.',
        requirement_level: 'REQUIRED',
      },
    ]) {
      assert.throws(() =>
        parseEvalCase({ ...CASE, judging_criteria: [criterion] }),
      );
    }
  });

  it('enforces every uppercase level and consumes negations as one keyword', () => {
    for (const textLevel of REQUIREMENT_LEVELS) {
      for (const declaredLevel of REQUIREMENT_LEVELS) {
        const definition = {
          ...CASE,
          judging_criteria: [
            {
              value: `The implementation ${textLevel} make a direct API request.`,
              requirement_level: declaredLevel,
            },
          ],
        };
        if (textLevel === declaredLevel) {
          assert.equal(
            parseEvalCase(definition).judging_criteria[0]?.requirement_level,
            textLevel,
          );
        } else {
          assert.throws(
            () => parseEvalCase(definition),
            /requirement_level must be/,
          );
        }
      }
    }
  });

  it('recognizes repeated keywords, punctuation, and line-wrapped negations', () => {
    for (const value of [
      'MUST NOT create a second subscription; MUST NOT create duplicate Prices.',
      '**MUST NOT** create a second subscription.',
      'The implementation MUST\nNOT create a second subscription.',
      'The implementation MUST\tNOT create a second subscription.',
    ]) {
      const criterion = { value, requirement_level: 'MUST NOT' };
      assert.equal(
        parseEvalCase({ ...CASE, judging_criteria: [criterion] })
          .judging_criteria[0]?.value,
        value,
      );
    }
  });

  it('rejects conflicting uppercase levels instead of choosing a priority', () => {
    for (const value of [
      'MUST create one subscription and SHOULD set billing mode to flexible.',
      'MUST create a subscription and MUST NOT create duplicate Prices.',
      'SHOULD create a subscription and MAY create a coupon.',
    ]) {
      assert.throws(
        () =>
          parseEvalCase({
            ...CASE,
            judging_criteria: [{ value, requirement_level: 'MUST' }],
          }),
        /conflicting uppercase requirement levels/,
      );
    }
  });

  it('matches whole uppercase keywords without inferring levels from ordinary prose', () => {
    for (const value of [
      'The implementation must set billing mode to flexible.',
      'The implementation Must set billing mode to flexible.',
      'The fixture contains MUSTARD, MAYBE, and SHOULD_NOT identifiers.',
    ]) {
      assert.equal(
        parseEvalCase({
          ...CASE,
          judging_criteria: [{ value, requirement_level: 'MAY' }],
        }).judging_criteria[0]?.requirement_level,
        'MAY',
      );
    }
  });
});
