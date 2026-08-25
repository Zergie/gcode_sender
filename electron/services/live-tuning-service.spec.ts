import { describe, expect, it, vi } from 'vitest';

import type { ParsedFirmwareLine } from '../../shared/protocol';
import type { TuningPeak } from '../../shared/tuning-contracts';
import type { Logger } from '../logger';
import { ActivityService } from './activity-service';
import { calculateCandidates, LiveTuningService, validateTelemetry } from './live-tuning-service';
import type { PersistenceStore } from './persistence-store';
import type { SerialService } from './serial-service';

type FirmwareResponse = { readonly parsed: ParsedFirmwareLine; readonly raw: string };

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

const OK_RESPONSE: FirmwareResponse = { parsed: { kind: 'ok' }, raw: 'ok' };

describe('Klipper-style PID candidate calculation', () => {
  it('uses the median cycle and QuickPID actuator scaling', () => {
    const peaks: TuningPeak[] = Array.from({ length: 12 }, (_, index) => ({
      temperature: index % 2 === 0 ? 195 : 205,
      elapsedSeconds: index * 10,
      phase: index % 2 === 0 ? 'cooling' : 'heating',
    }));
    const [klipper, conservative] = calculateCandidates(peaks);
    expect(klipper?.method).toBe('klipper-ziegler-nichols');
    expect(klipper?.tuSeconds).toBe(20);
    expect(klipper?.ku).toBeCloseTo((4 * 255) / (Math.PI * 5));
    expect(klipper?.gains.ki).toBeCloseTo(klipper!.gains.kp / 10);
    expect(conservative!.gains.kp).toBeLessThan(klipper!.gains.kp);
  });
});

describe('live tuning cancellation', () => {
  it('reports an informational canonical T3 experiment-integrity bound violation', () => {
    expect(() =>
      validateTelemetry(
        {
          timestamp: '2026-08-25T00:00:00.000Z',
          average: 95,
          target: 100,
          power: 255,
          thermistors: [95, 95, 101],
          raw: 'T0:95 /100 @:255 T1:95 T2:95 T3:101',
        },
        100,
        {
          maximumTarget: 250,
          maximumSensorDifference: 25,
        },
      ),
    ).toThrow(
      'T3 enclosure sensor left its host-side experiment-integrity bounds (-20 to 100 °C); this is not firmware safety enforcement',
    );
  });

  it('does not resolve until heater-off and PID rollback are acknowledged', async () => {
    const heaterOff = deferred<FirmwareResponse>();
    const rollback = deferred<FirmwareResponse>();
    const commands: string[] = [];
    let parsedListener:
      ((event: { readonly parsed: ParsedFirmwareLine; readonly raw: string }) => void) | null =
      null;

    const serial = {
      getState: () => ({ status: 'connected' }),
      subscribe: (
        event: string,
        listener: (event: { readonly parsed: ParsedFirmwareLine; readonly raw: string }) => void,
      ) => {
        if (event === 'parsed') {
          parsedListener = listener;
        }
        return () => {
          parsedListener = null;
        };
      },
      sendAndWait: vi.fn((command: string): Promise<FirmwareResponse> => {
        commands.push(command);
        if (command === 'M503') {
          emitSetting(parsedListener, 'Kp', '3.5');
          emitSetting(parsedListener, 'Ki', '0.4');
          emitSetting(parsedListener, 'Kd', '2');
          return Promise.resolve({
            parsed: { kind: 'setting', name: 'Heater Temperatur Range 2', value: '0 - 80' },
            raw: 'Heater Temperatur Range 2: 0 - 80',
          });
        }
        if (command === 'M104 S0') {
          return heaterOff.promise;
        }
        if (command === 'M301 P3.5 I0.4 D2') {
          return rollback.promise;
        }
        return Promise.resolve(OK_RESPONSE);
      }),
      bestEffortHeaterOff: vi.fn(() => Promise.resolve()),
    } as unknown as SerialService;
    const activity = new ActivityService();
    let savedSession: unknown;
    const saveSession = vi.fn((session: unknown) => Promise.resolve(session));
    saveSession.mockImplementation(async (session: unknown) => {
      savedSession = session;
      return session;
    });
    const service = new LiveTuningService(
      '.',
      serial,
      activity,
      {
        getSettings: () => ({ artifactLimitBytes: 1_000, artifactLimitRecords: 2 }),
        saveSession,
      } as unknown as PersistenceStore,
      silentLogger(),
    );

    service.start({ targets: [100], sampleIntervalMs: 250, stageTimeoutMs: 60_000 });
    await vi.waitFor(() => expect(commands).toContain('M104 S100'));
    const appendTrace = (
      service as unknown as { appendTrace(sample: unknown): Promise<void> }
    ).appendTrace.bind(service);
    const sample = {
      timestamp: '2026-08-25T00:00:00.000Z',
      elapsedSeconds: 1,
      target: 100,
      phase: 'heating',
      telemetry: {
        timestamp: '2026-08-25T00:00:00.000Z',
        average: 95,
        target: 100,
        power: 255,
        thermistors: [95, 95, 95],
        raw: 'T:95.0 /100.0 P:255',
      },
    };
    await appendTrace(sample);
    await appendTrace({ ...sample, elapsedSeconds: 2 });
    await appendTrace({ ...sample, elapsedSeconds: 3 });

    let settled = false;
    const cancellation = service.cancel().then((state) => {
      settled = true;
      return state;
    });
    await vi.waitFor(() => expect(commands).toContain('M104 S0'));
    expect(settled).toBe(false);
    expect(commands).not.toContain('M301 P3.5 I0.4 D2');

    heaterOff.resolve(OK_RESPONSE);
    await vi.waitFor(() => expect(commands).toContain('M301 P3.5 I0.4 D2'));
    expect(settled).toBe(false);

    rollback.resolve(OK_RESPONSE);
    await expect(cancellation).resolves.toMatchObject({ status: 'cancelled', error: null });
    expect(activity.getState().active).toBeNull();
    expect(saveSession).toHaveBeenCalledOnce();
    expect((savedSession as { data: { artifact: unknown } }).data.artifact).toMatchObject({
      complete: false,
      limits: { maxBytes: 1_000, maxRecords: 2 },
      retainedRecords: 2,
      omittedRecords: 1,
    });
    expect(commands).toEqual([
      'M503',
      'M301 P1000 I0 D0',
      'M104 S100',
      'M104 S0',
      'M301 P3.5 I0.4 D2',
    ]);
  });

  it('is a no-op when no tuning run is active', async () => {
    const sendAndWait = vi.fn();
    const service = new LiveTuningService(
      '.',
      { sendAndWait, subscribe: () => () => undefined } as unknown as SerialService,
      new ActivityService(),
      {
        getSettings: () => ({ artifactLimitBytes: 120, artifactLimitRecords: 2 }),
      } as unknown as PersistenceStore,
      silentLogger(),
    );

    await expect(service.cancel()).resolves.toMatchObject({ status: 'idle' });
    expect(sendAndWait).not.toHaveBeenCalled();
  });

  it('fails and releases tuning ownership when the serial connection errors', async () => {
    const snapshot = deferred<FirmwareResponse>();
    let serialStatus = 'connected';
    let stateListener: ((state: { status: string; error?: unknown }) => void) | null = null;
    const serial = {
      getState: () => ({ status: serialStatus }),
      subscribe: (
        event: string,
        listener: (event: { status: string; error?: unknown }) => void,
      ) => {
        if (event === 'state') {
          stateListener = listener;
        }
        return () => undefined;
      },
      sendAndWait: vi.fn((command: string): Promise<FirmwareResponse> => {
        if (command === 'M503') {
          return snapshot.promise;
        }
        return Promise.resolve(OK_RESPONSE);
      }),
      bestEffortHeaterOff: vi.fn(() => Promise.resolve()),
    } as unknown as SerialService;
    const activity = new ActivityService();
    const saveSession = vi.fn((session: unknown) => Promise.resolve(session));
    const service = new LiveTuningService(
      '.',
      serial,
      activity,
      {
        getSettings: () => ({ artifactLimitBytes: 120, artifactLimitRecords: 2 }),
        saveSession,
      } as unknown as PersistenceStore,
      silentLogger(),
    );

    service.start({ targets: [100], sampleIntervalMs: 250, stageTimeoutMs: 60_000 });
    await vi.waitFor(() =>
      expect(serial.sendAndWait).toHaveBeenCalledWith(
        'M503',
        8_000,
        expect.any(AbortSignal),
        'tuning',
      ),
    );
    serialStatus = 'error';
    stateListener?.({
      status: 'error',
      error: { code: 'SERIAL_DISCONNECTED', message: 'USB link lost', recoverable: true },
    });
    snapshot.reject(new Error('command waiter released'));

    await vi.waitFor(() => expect(service.getState().status).toBe('failed'));
    expect(service.getState()).toMatchObject({
      status: 'failed',
      error: { code: 'SERIAL_DISCONNECTED', message: 'USB link lost' },
    });
    expect(activity.getState()).toEqual({ active: null });
    expect(saveSession).toHaveBeenCalledOnce();
    expect(serial.bestEffortHeaterOff).toHaveBeenCalledOnce();
  });
});

function emitSetting(
  listener: ((event: { readonly parsed: ParsedFirmwareLine; readonly raw: string }) => void) | null,
  name: string,
  value: string,
): void {
  listener?.({ parsed: { kind: 'setting', name, value }, raw: `${name}: ${value}` });
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function silentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
