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
});

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
