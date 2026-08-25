// @vitest-environment jsdom

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GcodeApi,
  SerialConnectionState,
  SerialLineEvent,
  TemperatureTelemetry,
} from '../../../../shared/contracts';
import { success } from '../../../../shared/errors';
import { SerialTelemetryStore } from './serial-telemetry.store';

describe('SerialTelemetryStore', () => {
  let store: SerialTelemetryStore;
  let stateListener: ((state: SerialConnectionState) => void) | undefined;
  let lineListener: ((event: SerialLineEvent) => void) | undefined;
  let telemetryListener: ((event: TemperatureTelemetry) => void) | undefined;
  const connection: SerialConnectionState = {
    status: 'connected',
    portPath: 'COM4',
    baudRate: 115200,
    firmware: null,
    connectedAt: '2026-08-25T00:00:00.000Z',
    error: null,
  };

  beforeEach(() => {
    const register = <T>(assign: (listener: T) => void) =>
      vi.fn((listener: T) => {
        assign(listener);
        return vi.fn();
      });
    const api = {
      serial: {
        listPorts: vi.fn(async () => success([{ path: 'COM4' }])),
        getState: vi.fn(async () => success(connection)),
        connect: vi.fn(async () => success(connection)),
        disconnect: vi.fn(async () => success(connection)),
        send: vi.fn(async () => success(undefined)),
      },
      events: {
        onSerialState: register((listener: (state: SerialConnectionState) => void) => {
          stateListener = listener;
        }),
        onSerialLine: register((listener: (event: SerialLineEvent) => void) => {
          lineListener = listener;
        }),
        onTelemetry: register((listener: (event: TemperatureTelemetry) => void) => {
          telemetryListener = listener;
        }),
        onFirmware: register(() => undefined),
        onFirmwareError: register(() => undefined),
      },
    } as unknown as GcodeApi;
    Object.defineProperty(window, 'gcode', { configurable: true, value: api });
    TestBed.configureTestingModule({ providers: [SerialTelemetryStore] });
    store = TestBed.inject(SerialTelemetryStore);
  });

  afterEach(() => {
    store.ngOnDestroy();
    delete (window as unknown as { gcode?: GcodeApi }).gcode;
  });

  it('owns one event registration set and publishes serial-derived state', async () => {
    const states: SerialConnectionState[] = [];
    const telemetry: TemperatureTelemetry = {
      timestamp: '2026-08-25T00:00:01.000Z',
      average: 42,
      target: 100,
      power: 128,
      thermistors: [42, 41, 40],
      raw: 'T0:42',
    };

    store.initialize(
      (state) => states.push(state),
      () => undefined,
      () => undefined,
      () => undefined,
    );
    store.initialize(
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );
    stateListener?.(connection);
    lineListener?.({
      timestamp: '2026-08-25T00:00:01.000Z',
      direction: 'rx',
      line: 'ok',
      origin: 'terminal',
    });
    telemetryListener?.(telemetry);

    expect(states).toEqual([connection]);
    expect(store.connection()).toEqual(connection);
    expect(store.terminal()[0]?.line).toBe('ok');
    expect(store.telemetry()).toEqual(telemetry);
    expect(store.hasTelemetry()).toBe(true);
  });

  it('deduplicates ports and command history through intent commands', async () => {
    await store.refreshPorts();
    store.selectPort('COM4');
    store.recordCommand('M105');
    store.recordCommand('M115');
    store.recordCommand('M105');

    expect(store.ports()).toEqual([{ path: 'COM4' }]);
    expect(store.selectedPort()).toBe('COM4');
    expect(store.commandHistory()).toEqual(['M105', 'M115']);
  });
});
