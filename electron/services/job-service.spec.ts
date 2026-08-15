import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobExecutionLogEntry } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import type { Logger } from '../logger';
import { ActivityService } from './activity-service';
import { JobService, readJobLogPage } from './job-service';
import type { PersistenceStore } from './persistence-store';
import type { SerialService } from './serial-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('job log pagination', () => {
  it('uses one look-ahead row to expose a next offset only when another page exists', async () => {
    const logPath = await logFile(threeEntries());

    const first = await readJobLogPage(logPath, 0, 2);
    const second = await readJobLogPage(logPath, first.nextOffset!, 2);

    expect(first.entries.map(({ sourceLine }) => sourceLine)).toEqual([1, 2]);
    expect(first.nextOffset).toBe(2);
    expect(second.entries.map(({ sourceLine }) => sourceLine)).toEqual([3]);
    expect(second.nextOffset).toBeNull();
  });

  it('does not advertise an empty page when the file contains exactly the limit', async () => {
    const logPath = await logFile(threeEntries().slice(0, 2));

    const page = await readJobLogPage(logPath, 0, 2);

    expect(page.entries).toHaveLength(2);
    expect(page.nextOffset).toBeNull();
  });
});

describe('job stop completion', () => {
  it('waits for the stream finalizer and retained session before resolving stop', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-stop-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'job.gcode');
    await writeFile(filePath, 'M105\n', 'utf8');
    const persisted = deferred<void>();
    const saveSession = vi.fn(() => persisted.promise);
    const bestEffortHeaterOff = vi.fn(async () => undefined);
    const sendAndWait = vi.fn(
      (_command: string, _timeout: number, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                new AppError({
                  code: 'INVALID_STATE',
                  message: 'aborted',
                  recoverable: true,
                }),
              ),
            { once: true },
          );
        }),
    );
    const serial = {
      getState: () => ({ status: 'connected' }),
      subscribe: () => () => undefined,
      sendAndWait,
      bestEffortHeaterOff,
    } as unknown as SerialService;
    const store = {
      getSettings: () => ({ commandTimeoutMs: 8_000 }),
      saveSession,
    } as unknown as PersistenceStore;
    const service = new JobService(
      path.join(directory, 'sessions'),
      serial,
      new ActivityService(),
      store,
      silentLogger(),
    );
    await service.start({ path: filePath });
    await vi.waitFor(() => expect(sendAndWait).toHaveBeenCalledOnce());

    let settled = false;
    const stopping = service.stop().finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledOnce());
    const repeatedStop = service.stop();
    expect(settled).toBe(false);
    persisted.resolve();

    await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
    await expect(repeatedStop).resolves.toMatchObject({ status: 'stopped' });
    expect(bestEffortHeaterOff).toHaveBeenCalledOnce();
  });

  it('does not write heater-off when an idle job is stopped', async () => {
    const bestEffortHeaterOff = vi.fn(async () => undefined);
    const service = new JobService(
      'unused',
      {
        subscribe: () => () => undefined,
        bestEffortHeaterOff,
      } as unknown as SerialService,
      new ActivityService(),
      {} as PersistenceStore,
      silentLogger(),
    );

    await expect(service.stop()).resolves.toMatchObject({ status: 'idle' });
    expect(bestEffortHeaterOff).not.toHaveBeenCalled();
  });
});

async function logFile(entries: readonly JobExecutionLogEntry[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-job-log-'));
  temporaryDirectories.push(directory);
  const logPath = path.join(directory, 'job.jsonl');
  await writeFile(logPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  return logPath;
}

function threeEntries(): readonly JobExecutionLogEntry[] {
  return [1, 2, 3].map((sourceLine) => ({
    timestamp: '2026-08-15T12:00:00.000Z',
    sourceLine,
    command: `M105 ; ${sourceLine}`,
    outcome: 'completed' as const,
  }));
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function silentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
