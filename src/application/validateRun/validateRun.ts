import type { PreflightEvalInput } from '../../execution/execute.ts';

/** Check a resolved plan against a composition without any authority-bearing work. */
export interface ValidateRun {
  validate(input: PreflightEvalInput): void;
}
