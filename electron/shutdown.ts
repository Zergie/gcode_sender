export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

export interface ShutdownServices {
  readonly stopJob: () => Promise<unknown> | unknown;
  readonly cancelTuning: () => Promise<unknown> | unknown;
  readonly disconnectSerial: () => Promise<unknown> | unknown;
}

export interface ShutdownResult {
  readonly status: 'completed' | 'timed-out';
  readonly errors: readonly Error[];
}

/**
 * Completes mutually exclusive command owners before closing their transport.
 * Each stage is attempted even if an earlier stage reports an error.
 */
export async function shutdownInOrder(
  services: ShutdownServices,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): Promise<ShutdownResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Shutdown timeout must be positive');
  }

  const cleanup = runCleanup(services);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ShutdownResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timed-out', errors: [] }), timeoutMs);
  });

  const result = await Promise.race([cleanup, timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return result;
}

async function runCleanup(services: ShutdownServices): Promise<ShutdownResult> {
  const errors: Error[] = [];
  await attempt(services.stopJob, errors);
  await attempt(services.cancelTuning, errors);
  await attempt(services.disconnectSerial, errors);
  return { status: 'completed', errors };
}

async function attempt(action: () => Promise<unknown> | unknown, errors: Error[]): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
}
