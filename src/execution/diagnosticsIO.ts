import { performance } from 'node:perf_hooks';
import type { AttemptDiagnosticsStore } from '../contracts/attemptDiagnostics.ts';

import type { AttemptDiagnosticsWriter } from '../diagnostics/recorder.ts';

export const ATTEMPT_DIAGNOSTIC_IO_BUDGET_MS = 2000;

/** Engine-owned write allowance, shared from reservation through terminal publication. */
export function createAttemptDiagnosticsWriter(
  store?: AttemptDiagnosticsStore,
): AttemptDiagnosticsWriter | undefined {
  if (!store) return undefined;
  const remaining = {
    progress: ATTEMPT_DIAGNOSTIC_IO_BUDGET_MS / 2,
    failure: ATTEMPT_DIAGNOSTIC_IO_BUDGET_MS / 4,
    terminal: ATTEMPT_DIAGNOSTIC_IO_BUDGET_MS / 4,
  };
  const write: AttemptDiagnosticsWriter = async (snapshot, excerpts) => {
    const budget =
      snapshot.timing.finished_at !== undefined
        ? 'terminal'
        : snapshot.primary_failure
          ? 'failure'
          : 'progress';
    if (remaining[budget] <= 0) return false;
    const before = performance.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        store.write(snapshot, controller.signal, excerpts),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            remaining[budget] = 0;
            controller.abort();
            reject(new Error('Diagnostic I/O budget exhausted.'));
          }, remaining[budget]);
        }),
      ]);
      return true;
    } catch {
      remaining[budget] = 0;
      return false;
    } finally {
      clearTimeout(timer);
      remaining[budget] = Math.max(
        0,
        remaining[budget] - (performance.now() - before),
      );
    }
  };
  return Object.assign(write, {
    supportsRestrictedExcerpts: store.supportsRestrictedExcerpts === true,
  });
}
