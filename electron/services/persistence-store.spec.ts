import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionMetadata, StoredProfile } from '../../shared/contracts';
import type { Logger } from '../logger';
import { PersistenceStore, pruneSessions } from './persistence-store';

const temporaryDirectories: string[] = [];
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('session retention', () => {
  it('enforces unique profile names for saves and imports', async () => {
    const directory = await temporaryDirectory();
    const store = new PersistenceStore(directory, logger);
    await store.initialize();
    await store.saveProfile(profile('first', 'Standard PID'));

    await expect(store.saveProfile(profile('second', ' standard pid '))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(store.importProfiles([profile('third', 'STANDARD PID')])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(store.listProfiles()).toHaveLength(1);
  });

  it('rejects renderer-shaped settings patches that try to change approved catalog hosts', async () => {
    const directory = await temporaryDirectory();
    const store = new PersistenceStore(directory, logger);
    await store.initialize();

    await expect(
      store.updateSettings({
        approvedCatalogHosts: ['attacker.example.test'],
      } as never),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(store.getSettings().approvedCatalogHosts).toEqual([]);
  });

  it('removes one approved catalog host through the trusted operation', async () => {
    const directory = await temporaryDirectory();
    const store = new PersistenceStore(directory, logger);
    await store.initialize();
    await store.approveCatalogHost('keep.example.test');
    await store.approveCatalogHost('remove.example.test');

    await expect(store.revokeCatalogHost('remove.example.test')).resolves.toMatchObject({
      approvedCatalogHosts: ['keep.example.test'],
    });
    await expect(store.revokeCatalogHost('remove.example.test')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('adds bounded execution defaults to legacy settings and persists valid overrides', async () => {
    const directory = await temporaryDirectory();
    const store = new PersistenceStore(directory, logger);
    await writeFile(
      path.join(directory, 'state.v2.json'),
      JSON.stringify({
        version: 2,
        settings: {
          version: 2,
          theme: 'system',
          lastSerialPort: null,
          startupMacro: '',
          commandTimeoutMs: 8_000,
          approvedCatalogHosts: [],
        },
        profiles: [],
        sessions: [],
      }),
      'utf8',
    );
    await store.initialize();
    expect(store.getSettings()).toMatchObject({
      physicalLineLimitBytes: 65_536,
      artifactLimitBytes: 4_194_304,
      artifactLimitRecords: 10_000,
    });

    await store.updateSettings({
      physicalLineLimitBytes: 128_000,
      artifactLimitBytes: 8_000_000,
      artifactLimitRecords: 25_000,
    });
    const reloaded = new PersistenceStore(directory, logger);
    await reloaded.initialize();
    expect(reloaded.getSettings()).toMatchObject({
      physicalLineLimitBytes: 128_000,
      artifactLimitBytes: 8_000_000,
      artifactLimitRecords: 25_000,
    });
  });

  it.each([
    ['physicalLineLimitBytes', 0],
    ['artifactLimitBytes', -1],
    ['artifactLimitRecords', 1.5],
    ['physicalLineLimitBytes', 1_048_577],
    ['artifactLimitBytes', 67_108_865],
    ['artifactLimitRecords', 100_001],
  ])('rejects invalid %s without changing active settings', async (key, value) => {
    const directory = await temporaryDirectory();
    const store = new PersistenceStore(directory, logger);
    await store.initialize();
    const before = store.getSettings();
    await expect(store.updateSettings({ [key]: value } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      recoverable: true,
    });
    expect(store.getSettings()).toEqual(before);
  });

  it('keeps pinned sessions while applying both age and count limits to the rest', () => {
    const now = Date.parse('2026-08-15T12:00:00.000Z');
    const recent = Array.from({ length: 105 }, (_, index) =>
      session(`recent-${index}`, now - index * 1_000),
    );
    const old = session('old', now - 91 * 24 * 60 * 60 * 1_000);
    const pinnedOld = { ...session('pinned-old', now - 365 * 24 * 60 * 60 * 1_000), pinned: true };

    const retained = pruneSessions([...recent, old, pinnedOld], now);

    expect(retained).toHaveLength(101);
    expect(retained.some(({ id }) => id === 'pinned-old')).toBe(true);
    expect(retained.some(({ id }) => id === 'old')).toBe(false);
    expect(retained.some(({ id }) => id === 'recent-104')).toBe(false);
  });

  it('deletes a contained execution log when its session is removed', async () => {
    const directory = await temporaryDirectory();
    const store = new PersistenceStore(directory, logger);
    await store.initialize();
    const endedAt = Date.now();
    const job = { ...session('job-1', endedAt), kind: 'job' as const };
    const artifact = path.join(directory, 'sessions', 'job-1.job.jsonl');
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, '{}\n', 'utf8');
    await store.saveSession(job);

    await store.removeSession(job.id);

    await expect(access(artifact)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes an expired tuning trace while pruning persisted state', async () => {
    const directory = await temporaryDirectory();
    const old = {
      ...session('tune-old', Date.now() - 91 * 24 * 60 * 60 * 1_000),
      kind: 'tuning' as const,
    };
    await writeFile(
      path.join(directory, 'state.v2.json'),
      JSON.stringify({
        version: 2,
        settings: {
          version: 2,
          theme: 'system',
          lastSerialPort: null,
          startupMacro: '',
          commandTimeoutMs: 8_000,
          approvedCatalogHosts: [],
        },
        profiles: [],
        sessions: [old],
      }),
      'utf8',
    );
    const artifact = path.join(directory, 'sessions', 'tune-old.tuning.jsonl');
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, '{}\n', 'utf8');

    const store = new PersistenceStore(directory, logger);
    await store.initialize();

    expect(store.listSessions()).toEqual([]);
    await expect(access(artifact)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('continues writing after an earlier queued persistence failure', async () => {
    const directory = await temporaryDirectory();
    const store = new PersistenceStore(directory, logger);
    await store.initialize();
    const statePath = path.join(directory, 'state.v2.json');
    await rm(statePath);
    await mkdir(statePath);

    await expect(store.updateSettings({ theme: 'dark' })).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
    await rm(statePath, { recursive: true });
    await store.updateSettings({ theme: 'light' });

    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      settings: { theme: string };
    };
    expect(persisted.settings.theme).toBe('light');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-store-'));
  temporaryDirectories.push(directory);
  return directory;
}

function session(id: string, endedAt: number): SessionMetadata {
  return {
    id,
    version: 1,
    kind: 'simulation',
    title: id,
    startedAt: new Date(endedAt - 1_000).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    pinned: false,
    data: null,
  };
}

function profile(id: string, name: string): StoredProfile {
  const timestamp = '2026-08-26T00:00:00.000Z';
  return {
    id,
    version: 1,
    kind: 'pid-schedule',
    name,
    state: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
    data: [
      { temperatureC: 100, gains: { kp: 10, ki: 0.5, kd: 50 } },
      { temperatureC: 200, gains: { kp: 20, ki: 0.8, kd: 80 } },
    ],
  };
}
