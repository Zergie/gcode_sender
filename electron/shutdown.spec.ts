import { describe, expect, it } from 'vitest';

import { shutdownInOrder } from './shutdown';

describe('ordered main-process shutdown', () => {
  it('awaits job and tuning cleanup before disconnecting', async () => {
    const calls: string[] = [];
    let releaseJob!: () => void;
    const jobFinished = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    const shutdown = shutdownInOrder(
      {
        stopJob: async () => {
          calls.push('job:start');
          await jobFinished;
          calls.push('job:end');
        },
        cancelTuning: async () => {
          calls.push('tuning');
        },
        disconnectSerial: async () => {
          calls.push('serial');
        },
      },
      1_000,
    );

    await Promise.resolve();
    expect(calls).toEqual(['job:start']);
    releaseJob();

    await expect(shutdown).resolves.toEqual({ status: 'completed', errors: [] });
    expect(calls).toEqual(['job:start', 'job:end', 'tuning', 'serial']);
  });

  it('continues later cleanup stages after an earlier failure', async () => {
    const calls: string[] = [];
    const result = await shutdownInOrder({
      stopJob: () => {
        calls.push('job');
        throw new Error('job failed');
      },
      cancelTuning: () => calls.push('tuning'),
      disconnectSerial: () => calls.push('serial'),
    });

    expect(calls).toEqual(['job', 'tuning', 'serial']);
    expect(result.status).toBe('completed');
    expect(result.errors.map(({ message }) => message)).toEqual(['job failed']);
  });

  it('returns after the configured deadline', async () => {
    const result = await shutdownInOrder(
      {
        stopJob: () => new Promise(() => undefined),
        cancelTuning: () => undefined,
        disconnectSerial: () => undefined,
      },
      5,
    );
    expect(result.status).toBe('timed-out');
  });
});
