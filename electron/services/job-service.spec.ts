import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HeatingProfile, JobExecutionLogEntry } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import {
  HEATING_PROFILE_MARKER,
  serializeHeatingProfileDocument,
} from '../../shared/heating-profile-document';
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

describe('G-code program inspection', () => {
  it('classifies ordinary G-code without loading profile metadata', async () => {
    const { directory, service } = await inspectionService();
    const filePath = path.join(directory, 'ordinary.gcode');
    await writeFile(filePath, 'M104 S180\nG4 P1000\n', 'utf8');

    await expect(service.inspectFile(filePath)).resolves.toMatchObject({
      kind: 'gcode',
      profile: null,
      metadataWarning: null,
      file: { path: filePath, name: 'ordinary.gcode' },
    });
  });

  it('returns a profile only when metadata and normalized executable body agree', async () => {
    const { directory, service } = await inspectionService();
    const filePath = path.join(directory, 'profile.gcode');
    await writeFile(filePath, serializeHeatingProfileDocument(TEST_PROFILE), 'utf8');

    await expect(service.inspectFile(filePath)).resolves.toMatchObject({
      kind: 'heating-profile',
      profile: TEST_PROFILE,
      metadataWarning: null,
    });
  });

  it('keeps malformed marked files runnable as generic G-code with a warning', async () => {
    const directory = await temporaryDirectory('gcode-sender-inspect-');
    const filePath = path.join(directory, 'malformed.gcode');
    await writeFile(
      filePath,
      `${HEATING_PROFILE_MARKER}\n; GCODE_SENDER_HEATING_PROFILE_HEADER nope\nM105\n`,
      'utf8',
    );
    const sendAndWait = vi.fn(async () => ({ raw: 'ok', parsed: { kind: 'ok' } }));
    const service = createJobService(directory, sendAndWait);

    await expect(service.inspectFile(filePath)).resolves.toMatchObject({
      kind: 'gcode',
      profile: null,
      metadataWarning: expect.any(String),
    });
    await service.start({ path: filePath });
    await vi.waitFor(() => expect(service.getState().status).toBe('completed'));
    expect(sendAndWait).toHaveBeenCalledWith('M105', 8_000, expect.any(AbortSignal), 'job');
  });

  it('starts through stat-only inspection without invoking metadata classification', async () => {
    const directory = await temporaryDirectory('gcode-sender-start-');
    const filePath = path.join(directory, 'marked.gcode');
    await writeFile(filePath, `${HEATING_PROFILE_MARKER}\nM105\n`, 'utf8');
    const sendAndWait = vi.fn(async () => ({ raw: 'ok', parsed: { kind: 'ok' } }));
    const service = createJobService(directory, sendAndWait);
    const inspect = vi.spyOn(service, 'inspectFile').mockRejectedValue(new Error('must not run'));

    await service.start({ path: filePath });
    await vi.waitFor(() => expect(service.getState().status).toBe('completed'));

    expect(inspect).not.toHaveBeenCalled();
    expect(sendAndWait).toHaveBeenCalledWith('M105', 8_000, expect.any(AbortSignal), 'job');
  });

  it('downgrades a modified generated body to generic G-code', async () => {
    const { directory, service } = await inspectionService();
    const filePath = path.join(directory, 'modified.gcode');
    await writeFile(
      filePath,
      serializeHeatingProfileDocument(TEST_PROFILE).replace('M104 S21', 'M104 S99'),
      'utf8',
    );

    await expect(service.inspectFile(filePath)).resolves.toMatchObject({
      kind: 'gcode',
      profile: null,
      metadataWarning: expect.stringMatching(/does not match/),
    });
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

describe('exclusive job preparation', () => {
  it('allows only one overlapping start to acquire the job lane', async () => {
    const directory = await temporaryDirectory('gcode-sender-overlap-');
    const filePath = path.join(directory, 'job.gcode');
    await writeFile(filePath, 'M105\n', 'utf8');
    const firstInspection = deferred<{
      path: string;
      name: string;
      sizeBytes: number;
      modifiedAt: string;
      extension: '.gcode';
    }>();
    const secondInspection =
      deferred<typeof firstInspection extends Deferred<infer T> ? T : never>();
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
    const service = createJobService(directory, sendAndWait);
    let inspectionCount = 0;
    replaceJobInspection(service, () => {
      inspectionCount += 1;
      return inspectionCount === 1 ? firstInspection.promise : secondInspection.promise;
    });

    const first = service.start({ path: filePath });
    const second = service.start({ path: filePath });

    firstInspection.resolve({
      path: filePath,
      name: 'job.gcode',
      sizeBytes: 5,
      modifiedAt: '2026-08-25T00:00:00.000Z',
      extension: '.gcode',
    });

    await expect(first).resolves.toMatchObject({ status: 'preparing' });
    secondInspection.resolve({
      path: filePath,
      name: 'job.gcode',
      sizeBytes: 5,
      modifiedAt: '2026-08-25T00:00:00.000Z',
      extension: '.gcode',
    });
    await expect(second).rejects.toMatchObject({ code: 'BUSY', recoverable: true });
    await vi.waitFor(() => {
      expect(service.getState().status).toBe('streaming');
      expect(sendAndWait).toHaveBeenCalledTimes(1);
    });
    await service.stop();
  });

  it('releases ownership when preparation rejects', async () => {
    const directory = await temporaryDirectory('gcode-sender-preparation-error-');
    const filePath = path.join(directory, 'job.gcode');
    await writeFile(filePath, 'M105\n', 'utf8');
    const service = createJobService(directory, vi.fn());
    replaceJobInspection(service, () => {
      throw new AppError({
        code: 'FILE_NOT_FOUND',
        message: 'inspection failed',
        recoverable: true,
      });
    });

    await expect(service.start({ path: filePath })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
    expect(service.getState()).toMatchObject({ status: 'idle' });
  });

  it('rejects repeated activity acquisition across job, tuning, and validation', () => {
    const activity = new ActivityService();
    const states: string[] = [];
    activity.subscribe(({ active }) => states.push(active ?? 'idle'));

    expect(activity.acquire('job')).toEqual({ active: 'job' });
    for (const requested of ['job', 'tuning', 'validation'] as const) {
      expect(() => activity.acquire(requested)).toThrowError(
        expect.objectContaining({ code: 'BUSY', recoverable: true }),
      );
    }
    expect(activity.release('job')).toEqual({ active: null });
    expect(states).toEqual(['job', 'idle']);
  });

  it('keeps job ownership until retained-session persistence completes', async () => {
    const directory = await temporaryDirectory('gcode-sender-retention-');
    const filePath = path.join(directory, 'job.gcode');
    await writeFile(filePath, 'M105\n', 'utf8');
    const persisted = deferred<void>();
    const activity = new ActivityService();
    const service = new JobService(
      path.join(directory, 'sessions'),
      {
        getState: () => ({ status: 'connected' }),
        subscribe: () => () => undefined,
        sendAndWait: vi.fn(async () => ({ raw: 'ok', parsed: { kind: 'ok' } })),
        bestEffortHeaterOff: vi.fn(async () => undefined),
      } as unknown as SerialService,
      activity,
      {
        getSettings: () => ({ commandTimeoutMs: 8_000 }),
        saveSession: () => persisted.promise,
      } as unknown as PersistenceStore,
      silentLogger(),
    );

    await service.start({ path: filePath });
    await vi.waitFor(() => expect(service.getState().status).toBe('completed'));
    expect(activity.getState()).toEqual({ active: 'job' });
    persisted.resolve();
    await vi.waitFor(() => expect(activity.getState()).toEqual({ active: null }));
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

const TEST_PROFILE: HeatingProfile = {
  version: 1,
  name: 'Inspection profile',
  interpolation: 'linear',
  points: [
    { timeMs: 0, targetC: 20 },
    { timeMs: 1_000, targetC: 21 },
  ],
};

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function inspectionService(): Promise<{ directory: string; service: JobService }> {
  const directory = await temporaryDirectory('gcode-sender-inspect-');
  return { directory, service: createJobService(directory, vi.fn()) };
}

function createJobService(directory: string, sendAndWait: ReturnType<typeof vi.fn>): JobService {
  return new JobService(
    path.join(directory, 'sessions'),
    {
      getState: () => ({ status: 'connected' }),
      subscribe: () => () => undefined,
      sendAndWait,
      bestEffortHeaterOff: vi.fn(async () => undefined),
    } as unknown as SerialService,
    new ActivityService(),
    {
      getSettings: () => ({ commandTimeoutMs: 8_000 }),
      saveSession: vi.fn(async () => undefined),
    } as unknown as PersistenceStore,
    silentLogger(),
  );
}

function replaceJobInspection(
  service: JobService,
  inspect: () => Promise<{
    path: string;
    name: string;
    sizeBytes: number;
    modifiedAt: string;
    extension: '.gcode';
  }>,
): void {
  (service as unknown as { inspectJobFile: typeof inspect }).inspectJobFile = inspect;
}
