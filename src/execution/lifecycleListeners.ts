import type {
  RunAfterTaskContext,
  RunLifecycleListener,
} from '../contracts/lifecycle.ts';

/** Starts listeners without waiting; async callbacks isolate synchronous throws too. */
export function notifyAfterTask(
  listeners: readonly RunLifecycleListener[],
  context: RunAfterTaskContext,
): void {
  void Promise.allSettled(
    listeners.map(async (listener) => listener.afterTask?.(context)),
  );
}
