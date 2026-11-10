/** Stable package-root surface for the portable Forge engine and contracts. */

export * from './contracts/index.ts';
export { createAttemptDiagnosticsStore } from './diagnostics/localStore.ts';
export {
  type AttemptCompletionSummary,
  type AttemptDiagnosticsIdentity,
  AttemptDiagnosticsIdentityError,
  type AttemptDiagnosticsRecord,
  type AttemptDiagnosticsSnapshot,
  MAX_ATTEMPT_COMPLETION_SUMMARIES,
  MAX_ATTEMPT_DIAGNOSTICS_BYTES,
  parseAttemptDiagnostics,
  serializeAttemptDiagnostics,
} from './diagnostics/model.ts';
export type { AttemptDiagnosticsRecorder } from './diagnostics/recorder.ts';
export type { AttemptTiming } from './diagnostics/timing.ts';
export {
  createForgeEngine,
  defaultForgeEngine,
  type ForgeEngine,
  type ForgeEngineOptions,
} from './engine.ts';
export * from './evaluation/index.ts';
export * from './execution/index.ts';
export * from './model/index.ts';
export * from './planning/index.ts';
export * from './results/index.ts';
export * from './setup/index.ts';
