import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { parseResolvedRunPlanWithSetupActions } from '../../model/parse.ts';
import type { ResolvedRunPlanV1 } from '../../model/types.ts';
import { resolveRunPlanWithSetupActions } from '../../planning/planner.ts';
import type { SetupActionRegistry } from '../../setup/registry.ts';
import type { PlanRunInput } from '../contract/usecase/planRun.ts';
import { createPlanRun } from './planRun.ts';

vi.mock('../../planning/planner.ts', () => ({
  resolveRunPlanWithSetupActions: vi.fn(),
}));
vi.mock('../../model/parse.ts', () => ({
  parseResolvedRunPlanWithSetupActions: vi.fn(),
}));

describe('createPlanRun', () => {
  it('resolves the selection and parses the plan with the injected setup actions', () => {
    const setupActions = {} as SetupActionRegistry;
    const input = { selection: {} } as PlanRunInput;
    const resolved = { resolved: true } as unknown as ResolvedRunPlanV1;
    const parsed = { parsed: true } as unknown as ResolvedRunPlanV1;
    vi.mocked(resolveRunPlanWithSetupActions).mockReturnValue(resolved);
    vi.mocked(parseResolvedRunPlanWithSetupActions).mockReturnValue(parsed);

    assert.equal(createPlanRun({ setupActions }).plan(input), parsed);
    assert.deepEqual(vi.mocked(resolveRunPlanWithSetupActions).mock.calls, [
      [input, setupActions],
    ]);
    assert.deepEqual(
      vi.mocked(parseResolvedRunPlanWithSetupActions).mock.calls,
      [[resolved, setupActions]],
    );
  });
});
