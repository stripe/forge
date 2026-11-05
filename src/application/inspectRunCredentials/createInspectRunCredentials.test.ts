import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import {
  type EvalCredentialUse,
  inspectEvalCredentialsWithSetupActions,
  type PreflightEvalInput,
} from '../../execution/execute.ts';
import type { SetupActionRegistry } from '../../setup/registry.ts';
import { createInspectRunCredentials } from './createInspectRunCredentials.ts';

vi.mock('../../execution/execute.ts', () => ({
  inspectEvalCredentialsWithSetupActions: vi.fn(),
}));

describe('createInspectRunCredentials', () => {
  it('returns the plan credential uses found with the injected setup actions', () => {
    const setupActions = {} as SetupActionRegistry;
    const input = {} as PreflightEvalInput;
    const uses = [] as readonly EvalCredentialUse[];
    vi.mocked(inspectEvalCredentialsWithSetupActions).mockReturnValue(uses);

    assert.equal(
      createInspectRunCredentials({ setupActions }).inspect(input),
      uses,
    );
    assert.deepEqual(
      vi.mocked(inspectEvalCredentialsWithSetupActions).mock.calls,
      [[input, setupActions]],
    );
  });
});
