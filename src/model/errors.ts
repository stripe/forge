export type BenchmarkModelErrorCode =
  | 'invalid_manifest'
  | 'invalid_case'
  | 'invalid_experiment_config'
  | 'invalid_plan'
  | 'invalid_yaml'
  | 'unsafe_path'
  | 'dataset_integrity_mismatch';

/** Stable, sanitized failure raised while loading public benchmark inputs. */
export class BenchmarkModelError extends Error {
  readonly code: BenchmarkModelErrorCode;

  constructor(
    code: BenchmarkModelErrorCode,
    message: string,
    options: {cause?: unknown} = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : {cause: options.cause},
    );
    this.name = 'BenchmarkModelError';
    this.code = code;
  }
}
