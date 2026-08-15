import { describe, expect, it, vi } from 'vitest';

import type { ParsedFirmwareLine } from '../../shared/protocol';
import type { TuningPeak } from '../../shared/tuning-contracts';
import type { Logger } from '../logger';
import { ActivityService } from './activity-service';
import { calculateCandidates, LiveTuningService } from './live-tuning-service';
import type { PersistenceStore } from './persistence-store';
import type { SerialService } from './serial-service';

type FirmwareResponse = { readonly parsed: ParsedFirmwareLine; readonly raw: string };

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
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
    const saveSession = vi.fn((session: unknown) => Promise.resolve(session));
    const service = new LiveTuningService(
      '.',
      serial,
      activity,
      { saveSession } as unknown as PersistenceStore,
      silentLogger(),
    );

    service.start({ targets: [100], sampleIntervalMs: 250, stageTimeoutMs: 60_000 });
    await vi.waitFor(() => expect(commands).toContain('M104 S100'));

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
      { sendAndWait } as unknown as SerialService,
      new ActivityService(),
      {} as PersistenceStore,
      silentLogger(),
    );

    await expect(service.cancel()).resolves.toMatchObject({ status: 'idle' });
    expect(sendAndWait).not.toHaveBeenCalled();
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
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
