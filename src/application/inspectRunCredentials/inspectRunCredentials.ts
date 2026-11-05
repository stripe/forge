import type {
  EvalCredentialUse,
  PreflightEvalInput,
} from '../../execution/execute.ts';

/** List the credentials a plan would use, before any source is bound. */
export interface InspectRunCredentials {
  inspect(input: PreflightEvalInput): readonly EvalCredentialUse[];
}
