import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {getMatrixGroups} from './matrix.js';
import type {ExperimentMatrixGroupV1, ExperimentMatrixV1} from './types.js';

describe('matrix group views', () => {
  const group: ExperimentMatrixGroupV1 = {
    cases: ['case/a'],
    treatments: ['baseline'],
    agents: [{adapter: 'codex', provider: 'openai', model: 'gpt'}],
  };

  it('views a flat matrix as one group without changing authored shape', () => {
    const matrix: ExperimentMatrixV1 = {...structuredClone(group), repetitions: 2, retries: 1};
    const before = structuredClone(matrix);
    const groups = getMatrixGroups(matrix);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0], group);
    assert.equal(groups[0]!.cases, matrix.cases);
    assert.equal(groups[0]!.treatments, matrix.treatments);
    assert.equal(groups[0]!.agents, matrix.agents);
    assert.deepEqual(Object.keys(groups[0]!).sort(), ['agents', 'cases', 'treatments']);
    assert.deepEqual(matrix, before);
    assert.equal(Object.hasOwn(matrix, 'groups'), false);
  });

  it('retains grouped order and boundaries without changing authored shape', () => {
    const matrix: ExperimentMatrixV1 = {
      groups: [structuredClone(group), {...structuredClone(group), cases: ['case/b']}],
      repetitions: 2,
      retries: 1,
    };
    const before = structuredClone(matrix);
    assert.equal(getMatrixGroups(matrix), matrix.groups);
    assert.deepEqual(getMatrixGroups(matrix).map(({cases}) => cases), [['case/a'], ['case/b']]);
    assert.deepEqual(matrix, before);
    assert.equal(Object.hasOwn(matrix, 'cases'), false);
  });
});
