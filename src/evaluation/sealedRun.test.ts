import assert from 'node:assert/strict';
import { it } from 'vitest';
import type { AtifTrajectoryV1_8 } from '../atif/index.ts';
import { createMemoryWorkspace } from '../testing/memoryWorkspace.ts';
import { createTestResolvedRunPlan } from '../testing/plans.ts';
import { evaluateSealedRun } from './index.ts';

it("waits through the caller's retry hook before asking the judge again", async () => {
  const plan = createTestResolvedRunPlan({
    judgingCriteria: ['Creates the answer.'],
    judge: { provider: 'test-judge', model: 'test-model' },
  });
  const workspace = createMemoryWorkspace({ 'answer.txt': 'Done.' });
  workspace.seal();
  const trajectory: AtifTrajectoryV1_8 = {
    schema_version: 'ATIF-v1.8',
    agent: { name: 'test-agent', version: '1' },
    steps: [{ step_id: 1, source: 'agent', message: 'Completed.' }],
  };
  const waits: number[] = [];
  let calls = 0;
  const { evaluation } = await evaluateSealedRun({
    plan,
    trajectory,
    workspace: workspace.readonly,
    invokeJudge: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Retry this request.');
      return JSON.stringify({
        results: [{ index: 0, passed: true, explanation: 'Done.' }],
      });
    },
    secrets: [],
    signal: new AbortController().signal,
    waitBeforeRetry: async (failedAttempt) => {
      waits.push(failedAttempt);
    },
  });
  assert.deepEqual(waits, [1]);
  assert.equal(evaluation.judging_criteria_passed, 1);
});
