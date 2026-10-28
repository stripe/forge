/** Controller policy for optional experiment observations, outside plan semantics. */
export const EXPERIMENT_OBSERVATION_LIMITS = Object.freeze({
  eventBytes: 64 * 1024,
  pendingBytes: 1024 * 1024,
  appendMs: 250,
  drainMs: 500,
  readMs: 250,
  recentEventBytes: 8 * 1024 * 1024,
  tokenRateWindowMs: 60_000,
});

export async function observeWithin<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<{ state: 'available'; value: T } | { state: 'unavailable' }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal).then((value) => ({
        state: 'available' as const,
        value,
      })),
      new Promise<{ state: 'unavailable' }>((resolve) => {
        timer = setTimeout(() => {
          resolve({ state: 'unavailable' });
          controller.abort();
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
