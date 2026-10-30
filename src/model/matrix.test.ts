import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { agentSelectionKey, getMatrixGroups } from './matrix.ts';
import type { ExperimentMatrixGroupV1, ExperimentMatrixV1 } from './types.ts';

describe('matrix group views', () => {
  const group: ExperimentMatrixGroupV1 = {
    cases: ['cases/case/a/case.yaml'],
    treatments: ['baseline'],
    agents: [{ adapter: 'codex', provider: 'openai', model: 'gpt' }],
  };

  it('views a flat matrix as one group without changing authored shape', () => {
    const matrix: ExperimentMatrixV1 = {
      ...structuredClone(group),
      repetitions: 2,
      retries: 1,
    };
    const before = structuredClone(matrix);
    const groups = getMatrixGroups(matrix);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0], group);
    assert.equal(groups[0]!.cases, matrix.cases);
    assert.equal(groups[0]!.treatments, matrix.treatments);
    assert.equal(groups[0]!.agents, matrix.agents);
    assert.deepEqual(Object.keys(groups[0]!).sort(), [
      'agents',
      'cases',
      'treatments',
    ]);
    assert.deepEqual(matrix, before);
    assert.equal(Object.hasOwn(matrix, 'groups'), false);
  });

  it('retains grouped order and boundaries without changing authored shape', () => {
    const matrix: ExperimentMatrixV1 = {
      groups: [
        structuredClone(group),
        { ...structuredClone(group), cases: ['cases/case-b.case.yaml'] },
      ],
      repetitions: 2,
      retries: 1,
    };
    const before = structuredClone(matrix);
    assert.equal(getMatrixGroups(matrix), matrix.groups);
    assert.deepEqual(
      getMatrixGroups(matrix).map(({ cases }) => cases),
      [['cases/case/a/case.yaml'], ['cases/case-b.case.yaml']],
    );
    assert.deepEqual(matrix, before);
    assert.equal(Object.hasOwn(matrix, 'cases'), false);
  });
});

describe('agent selection identity', () => {
  it('preserves the existing key bytes for current model profiles', () => {
    for (const [context, output] of [
      [32000, 4000],
      [128000, 16000],
    ] as const) {
      for (const reasoning of [false, true]) {
        for (const temperature of [false, true]) {
          for (const attachment of [false, true]) {
            // Deliberately reverse authored property order at both depths.
            const model_profile = {
              attachment,
              temperature,
              reasoning,
              limit: { output, context },
            };
            assert.equal(
              agentSelectionKey({
                adapter: 'opencode',
                provider: 'openai-compatible',
                model: 'gateway-code',
                model_profile,
              }),
              `["opencode","openai-compatible","gateway-code",null,[${context},${output},${reasoning},${temperature},${attachment}]]`,
            );
          }
        }
      }
    }
    assert.equal(
      agentSelectionKey({ adapter: 'codex', provider: 'openai', model: 'gpt' }),
      '["codex","openai","gpt","native",null]',
    );
  });
});
