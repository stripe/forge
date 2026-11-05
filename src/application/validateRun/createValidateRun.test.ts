import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import {
  type PreflightEvalInput,
  preflightEvalWithSetupActions,
} from '../../execution/execute.ts';
import type { SetupActionRegistry } from '../../setup/registry.ts';
import { createValidateRun } from './createValidateRun.ts';

vi.mock('../../execution/execute.ts', () => ({
  preflightEvalWithSetupActions: vi.fn(),
}));

describe('createValidateRun', () => {
  it('preflights the plan with the injected setup actions', () => {
    const setupActions = {} as SetupActionRegistry;
    const input = {} as PreflightEvalInput;

    createValidateRun({ setupActions }).validate(input);

    assert.deepEqual(vi.mocked(preflightEvalWithSetupActions).mock.calls, [
      [input, setupActions],
    ]);
  });

  it('surfaces a preflight failure', () => {
    vi.mocked(preflightEvalWithSetupActions).mockImplementation(() => {
      throw new Error('invalid plan');
    });

    assert.throws(
      () =>
        createValidateRun({ setupActions: {} as SetupActionRegistry }).validate(
          {} as PreflightEvalInput,
        ),
      /invalid plan/,
    );
  });
});
