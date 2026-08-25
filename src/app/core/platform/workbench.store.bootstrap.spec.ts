// @vitest-environment jsdom

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSettings,
  CommandCatalogSnapshot,
  ExclusiveActivityState,
  FirmwareErrorEvent,
  FirmwareInfo,
  GcodeApi,
  JobState,
  SerialConnectionState,
  SerialLineEvent,
  SystemInfo,
  TemperatureTelemetry,
} from '../../../../shared/contracts';
import { success } from '../../../../shared/errors';
import type { LiveTuningState } from '../../../../shared/tuning-contracts';
import { WorkbenchStore } from './workbench.store';

const settings: AppSettings = {
  version: 2,
  theme: 'dark',
  lastSerialPort: null,
  startupMacro: '',
  commandTimeoutMs: 8_000,
  physicalLineLimitBytes: 64 * 1024,
  artifactLimitBytes: 4 * 1024 * 1024,
  artifactLimitRecords: 10_000,
  approvedCatalogHosts: [],
  firmwareInoPath: null,
};

const connection: SerialConnectionState = {
  status: 'disconnected',
  portPath: null,
  baudRate: 115200,
  firmware: null,
  connectedAt: null,
  error: null,
};

const job: JobState = {
  id: null,
  status: 'idle',
  file: null,
  startedAt: null,
  endedAt: null,
  progress: null,
  lastCompletedSourceLine: null,
  pauseRequested: false,
  error: null,
};

const tuning: LiveTuningState = {
  id: null,
  status: 'idle',
  startedAt: null,
  endedAt: null,
  currentTarget: null,
  currentBreakpointIndex: 0,
  peaksCollected: 0,
  peakGoal: 12,
  rollbackGains: null,
  results: [],
  error: null,
};

const catalog: CommandCatalogSnapshot = {
  entries: [],
  source: 'bundled',
  url: null,
  firmwareId: null,
  fetchedAt: null,
  stale: false,
};

const systemInfo: SystemInfo = { platform: 'win32', arch: 'x64', versions: {} };

function createDesktopApi() {
  let serialStateListener: ((state: SerialConnectionState) => void) | undefined;
  let serialLineListener: ((event: SerialLineEvent) => void) | undefined;
  let telemetryListener: ((event: TemperatureTelemetry) => void) | undefined;
  let firmwareListener: ((event: FirmwareInfo) => void) | undefined;
  let firmwareErrorListener: ((event: FirmwareErrorEvent) => void) | undefined;
  let jobStateListener: ((state: JobState) => void) | undefined;
  let tuningStateListener: ((state: LiveTuningState) => void) | undefined;
  let activityListener: ((state: ExclusiveActivityState) => void) | undefined;
  let catalogListener: ((snapshot: CommandCatalogSnapshot) => void) | undefined;
  const unsubscriptions = Array<ReturnType<typeof vi.fn>>();
  const register = <T>(assign: (listener: T) => void) => {
    return vi.fn((listener: T) => {
      assign(listener);
      const unsubscribe = vi.fn();
      unsubscriptions.push(unsubscribe);
      return unsubscribe;
    });
  };
  let releaseSettings: (() => void) | undefined;
  const settingsReady = new Promise<void>((resolve) => (releaseSettings = resolve));

  const api = {
    system: {
      getInfo: vi.fn(async () => success(systemInfo)),
      openExternal: vi.fn(async () => success(undefined)),
    },
    firmware: {
      getToolchainStatus: vi.fn(async () => success({ available: false })),
      pickAndBuild: vi.fn(async () => success(null)),
    },
    serial: {
      listPorts: vi.fn(async () => success([{ path: 'COM4' }])),
      getState: vi.fn(async () => success(connection)),
      connect: vi.fn(async () => success(connection)),
      disconnect: vi.fn(async () => success(connection)),
      reconnect: vi.fn(async () => success(connection)),
      send: vi.fn(async () => success(undefined)),
      heaterOff: vi.fn(async () => success(undefined)),
    },
    jobs: {
      pickFile: vi.fn(async () => success(null)),
      resolveDroppedFile: vi.fn(),
      inspectFile: vi.fn(),
      saveHeatingProfile: vi.fn(),
      getState: vi.fn(async () => success(job)),
      getLog: vi.fn(),
      start: vi.fn(),
      pauseAfterCurrent: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      resolveTimeout: vi.fn(),
    },
    tuning: {
      getState: vi.fn(async () => success(tuning)),
      start: vi.fn(),
      cancel: vi.fn(),
    },
    catalog: {
      get: vi.fn(async () => success(catalog)),
      refresh: vi.fn(),
      approvedHosts: vi.fn(),
      revokeHost: vi.fn(),
    },
    settings: {
      get: vi.fn(async () => {
        await settingsReady;
        return success(settings);
      }),
      update: vi.fn(),
    },
    profiles: {
      list: vi.fn(async () => success([])),
      save: vi.fn(),
      remove: vi.fn(),
      importFile: vi.fn(),
      exportFile: vi.fn(),
    },
    sessions: {
      list: vi.fn(async () => success([])),
      save: vi.fn(),
      pin: vi.fn(),
      remove: vi.fn(),
      exportFile: vi.fn(),
    },
    activity: {
      get: vi.fn(async () => success({ active: null })),
      begin: vi.fn(async () => success({ active: 'tuning' })),
      end: vi.fn(async () => success({ active: null })),
    },
    events: {
      onSerialState: register((listener: (state: SerialConnectionState) => void) => {
        serialStateListener = listener;
      }),
      onSerialLine: register((listener: (event: SerialLineEvent) => void) => {
        serialLineListener = listener;
      }),
      onTelemetry: register((listener: (event: TemperatureTelemetry) => void) => {
        telemetryListener = listener;
      }),
      onFirmware: register((listener: (event: FirmwareInfo) => void) => {
        firmwareListener = listener;
      }),
      onFirmwareError: register((listener: (event: FirmwareErrorEvent) => void) => {
        firmwareErrorListener = listener;
      }),
      onJobState: register((listener: (state: JobState) => void) => {
        jobStateListener = listener;
      }),
      onJobTimeout: register(() => undefined),
      onTuningState: register((listener: (state: LiveTuningState) => void) => {
        tuningStateListener = listener;
      }),
      onCatalogSnapshot: register((listener: (snapshot: CommandCatalogSnapshot) => void) => {
        catalogListener = listener;
      }),
      onActivity: register((listener: (state: ExclusiveActivityState) => void) => {
        activityListener = listener;
      }),
    },
  } as unknown as GcodeApi;

  return {
    api,
    events: {
      get serialState() {
        return serialStateListener;
      },
      get serialLine() {
        return serialLineListener;
      },
      get telemetry() {
        return telemetryListener;
      },
      get firmware() {
        return firmwareListener;
      },
      get firmwareError() {
        return firmwareErrorListener;
      },
      get jobState() {
        return jobStateListener;
      },
      get tuningState() {
        return tuningStateListener;
      },
      get activity() {
        return activityListener;
      },
      get catalog() {
        return catalogListener;
      },
    },
    releaseSettings: () => releaseSettings?.(),
    unsubscriptions,
  };
}

describe('WorkbenchStore desktop lifecycle characterization', () => {
  let harness: ReturnType<typeof createDesktopApi>;
  let store: WorkbenchStore;

  beforeEach(() => {
    harness = createDesktopApi();
    Object.defineProperty(window, 'gcode', { configurable: true, value: harness.api });
    TestBed.configureTestingModule({ providers: [WorkbenchStore] });
    store = TestBed.inject(WorkbenchStore);
  });

  afterEach(() => {
    store?.ngOnDestroy();
    const testWindow = window as unknown as { gcode?: GcodeApi };
    delete testWindow.gcode;
  });

  it('shares overlapping initialization and registers each desktop event exactly once', async () => {
    const first = store.initialize();
    const second = store.initialize();

    expect(second).toBe(first);
    expect(store.initialized()).toBe(true);
    expect(harness.api.events.onSerialState).toHaveBeenCalledTimes(1);
    expect(harness.api.events.onSerialLine).toHaveBeenCalledTimes(1);
    expect(harness.api.events.onTelemetry).toHaveBeenCalledTimes(1);
    expect(harness.api.events.onFirmware).toHaveBeenCalledTimes(1);
    expect(harness.api.events.onFirmwareError).toHaveBeenCalledTimes(1);
    expect(harness.api.events.onJobState).toHaveBeenCalledTimes(1);
    expect(harness.api.events.onJobTimeout).toHaveBeenCalledTimes(1);
    expect(harness.api.events.onTuningState).toHaveBeenCalledTimes(1);
    expect(harness.api.events.onCatalogSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.api.events.onActivity).toHaveBeenCalledTimes(1);

    harness.releaseSettings();
    await first;
    expect(store.ports().map((port) => port.path)).toEqual(['COM4']);
  });

  it('disposes every subscription exactly once and keeps teardown idempotent', async () => {
    const initialization = store.initialize();
    harness.releaseSettings();
    await initialization;

    store.ngOnDestroy();
    store.ngOnDestroy();

    expect(harness.unsubscriptions).toHaveLength(10);
    harness.unsubscriptions.forEach((unsubscribe) => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });

  it('resets telemetry and disarms control on serial failure or disconnect', async () => {
    const initialization = store.initialize();
    harness.releaseSettings();
    await initialization;
    const connected: SerialConnectionState = {
      ...connection,
      status: 'connected',
      portPath: 'COM4',
    };
    harness.events.serialState?.(connected);
    harness.events.telemetry?.({
      timestamp: '2026-08-25T00:00:00.000Z',
      average: 180,
      target: 180,
      power: 100,
      thermistors: [180, 180, 180],
      raw: 'T0:180',
    });
    store.controlArmed.set(true);
    expect(store.hasTelemetry()).toBe(true);

    harness.events.serialState?.({ ...connected, status: 'error' });

    expect(store.hasTelemetry()).toBe(false);
    expect(store.controlArmed()).toBe(false);
    expect(store.connection().status).toBe('error');
  });

  it('preserves event-driven state updates and routes heater-off through the system command', async () => {
    const initialization = store.initialize();
    harness.releaseSettings();
    await initialization;
    const connected: SerialConnectionState = {
      ...connection,
      status: 'connected',
      portPath: 'COM4',
    };
    harness.events.serialState?.(connected);
    const firmware: FirmwareInfo = { raw: 'FW', firmwareName: 'Firmware' };
    harness.events.firmware?.(firmware);
    harness.events.activity?.({ active: 'tuning' });
    await store.stopHeating();

    expect(store.connection().firmware).toEqual(firmware);
    expect(harness.api.serial.heaterOff).toHaveBeenCalledTimes(1);
    expect(harness.api.serial.send).not.toHaveBeenCalled();
  });
});
