import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings, CommandCatalogSnapshot, FirmwareInfo } from '../../shared/contracts';
import type { Logger } from '../logger';
import { CatalogService } from './catalog-service';
import type { PersistenceStore } from './persistence-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('command catalog snapshot events', () => {
  it('emits automatic, remote, cache, and failed-refresh fallback snapshots', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-catalog-'));
    temporaryDirectories.push(directory);
    const firmware: FirmwareInfo = {
      raw: 'firmware',
      firmwareName: 'PID TEMP',
      uuid: 'oven-1',
      gcodeCatalogUrl: 'https://catalog.example.test/gcode.json',
    };
    const store = catalogStore(['catalog.example.test']);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify([{ code: 'M105', description: 'Read temperatures' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );

    const automaticEvents: CommandCatalogSnapshot[] = [];
    const automatic = new CatalogService(directory, store, silentLogger());
    automatic.subscribeSnapshot((snapshot) => automaticEvents.push(snapshot));
    await automatic.setFirmware(firmware);
    await vi.waitFor(() =>
      expect(automaticEvents.some(({ source }) => source === 'remote')).toBe(true),
    );
    expect(automaticEvents[0]).toMatchObject({
      source: 'bundled',
      firmwareId: 'oven-1',
      stale: true,
    });
    expect(automaticEvents.at(-1)).toMatchObject({
      source: 'remote',
      firmwareId: 'oven-1',
      stale: false,
    });

    const cacheEvents: CommandCatalogSnapshot[] = [];
    const cached = new CatalogService(directory, store, silentLogger());
    cached.subscribeSnapshot((snapshot) => cacheEvents.push(snapshot));
    await cached.setFirmware(firmware);
    expect(cacheEvents).toHaveLength(1);
    expect(cacheEvents[0]).toMatchObject({ source: 'cache', stale: false });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    await expect(cached.refresh()).resolves.toMatchObject({ source: 'cache', stale: true });
    expect(cacheEvents.at(-1)).toMatchObject({ source: 'cache', stale: true });
  });

  it('emits the bundled snapshot when firmware has no catalog URL', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-catalog-'));
    temporaryDirectories.push(directory);
    const events: CommandCatalogSnapshot[] = [];
    const service = new CatalogService(directory, catalogStore([]), silentLogger());
    service.subscribeSnapshot((snapshot) => events.push(snapshot));

    await service.setFirmware({ raw: 'firmware', firmwareName: 'PID TEMP' });
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));
    expect(events.every(({ source }) => source === 'bundled')).toBe(true);
    expect(events.at(-1)).toMatchObject({ firmwareId: 'PID TEMP', stale: true });
  });

  it('does not fetch an unapproved catalog and keeps the bundled fallback active', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-catalog-'));
    temporaryDirectories.push(directory);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const service = new CatalogService(directory, catalogStore([]), silentLogger());
    await service.setFirmware({
      raw: 'firmware',
      firmwareName: 'PID TEMP',
      gcodeCatalogUrl: 'https://unapproved.example.test/gcode.json',
    });

    await vi.waitFor(() => expect(service.get().source).toBe('bundled'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('waits for trusted approval before fetching and remembers an approved host', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-catalog-'));
    temporaryDirectories.push(directory);
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ code: 'M105', description: 'Read temperatures' }]), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const store = catalogStore([]);
    let decide: ((approved: boolean) => void) | undefined;
    const prompt = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    const service = new CatalogService(directory, store, silentLogger(), prompt);

    const refresh = service.setFirmware(firmwareWithCatalog());
    await vi.waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'catalog.example.test',
          url: 'https://catalog.example.test/gcode.json',
        }),
      ),
    );
    expect(fetch).not.toHaveBeenCalled();

    decide?.(true);
    await refresh;
    expect(store.approveCatalogHost).toHaveBeenCalledWith('catalog.example.test');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(service.get()).toMatchObject({ source: 'remote', stale: false });
  });

  it.each([false, false])(
    'keeps the fallback and does not persist or fetch when trusted approval is rejected or dismissed',
    async (approved) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-catalog-'));
      temporaryDirectories.push(directory);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const store = catalogStore([]);
      const service = new CatalogService(
        directory,
        store,
        silentLogger(),
        vi.fn(async () => approved),
      );

      await service.setFirmware(firmwareWithCatalog());
      expect(service.get()).toMatchObject({ source: 'bundled', stale: true });
      expect(store.approveCatalogHost).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('does not prompt again for a host already approved by the trusted path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-catalog-'));
    temporaryDirectories.push(directory);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify([{ code: 'M105', description: 'Read temperatures' }]), {
            status: 200,
          }),
        ),
      ),
    );
    const prompt = vi.fn(async () => true);
    const service = new CatalogService(
      directory,
      catalogStore(['catalog.example.test']),
      silentLogger(),
      prompt,
    );

    await service.setFirmware(firmwareWithCatalog());
    await vi.waitFor(() => expect(service.get().source).toBe('remote'));
    expect(prompt).not.toHaveBeenCalled();
  });
});

function firmwareWithCatalog(): FirmwareInfo {
  return {
    raw: 'firmware',
    firmwareName: 'PID TEMP',
    uuid: 'oven-1',
    gcodeCatalogUrl: 'https://catalog.example.test/gcode.json',
  };
}

function catalogStore(approvedCatalogHosts: readonly string[]): PersistenceStore {
  const settings: AppSettings = {
    version: 2,
    theme: 'system',
    lastSerialPort: null,
    startupMacro: '',
    commandTimeoutMs: 8_000,
    approvedCatalogHosts,
  };
  return {
    getSettings: () => settings,
    updateSettings: vi.fn(() => Promise.resolve(settings)),
    approveCatalogHost: vi.fn(() => Promise.resolve(settings)),
  } as unknown as PersistenceStore;
}

function silentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
