import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionMetadata } from '../../shared/contracts';
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
