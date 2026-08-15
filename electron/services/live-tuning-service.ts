/*
 * Relay procedure and final PID calculation are derived from Klipper's
 * pid_calibrate.py, Copyright (C) 2016-2018 Kevin O'Connor, GPLv3.
 * Source: https://github.com/Klipper3d/klipper/blob/master/klippy/extras/pid_calibrate.py
 *
 * The relay itself is adapted for this fixed firmware: a high proportional gain
 * plus target changes emulate max/off output because raw PWM is not exposed.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { JsonValue, SessionMetadata, TemperatureTelemetry } from '../../shared/contracts';
import { AppError, asAppError } from '../../shared/errors';
import type {
  LiveTuningRequest,
  LiveTuningState,
  PidGains,
  TuningBreakpointResult,
  TuningCandidate,
  TuningPeak,
} from '../../shared/tuning-contracts';
import type { ParsedFirmwareLine } from '../../shared/protocol';
import type { Logger } from '../logger';
import type { ActivityService } from './activity-service';
import type { PersistenceStore } from './persistence-store';
import type { SerialService } from './serial-service';

interface ValidatedRequest {
  readonly targets: readonly number[];
  readonly hysteresis: number;
  readonly peakCount: number;
  readonly sampleIntervalMs: number;
  readonly stageTimeoutMs: number;
  readonly relayKp: number;
  readonly maximumTarget: number;
  readonly maximumSensorDifference: number;
}

interface TuningSample {
  readonly timestamp: string;
  readonly elapsedSeconds: number;
  readonly target: number;
  readonly phase: 'heating' | 'cooling';
  readonly telemetry: TemperatureTelemetry;
}

const PWM_MAX = 255;
const PWM_ON_THRESHOLD = 245;
const PWM_OFF_THRESHOLD = 10;

export class LiveTuningService {
  private state: LiveTuningState = idleState();
  private readonly listeners = new Set<(state: LiveTuningState) => void>();
  private abortController: AbortController | null = null;
  private activeRun: Promise<void> | null = null;
  private tracePath: string | null = null;
  private traceQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionsDirectory: string,
    private readonly serial: SerialService,
    private readonly activity: ActivityService,
    private readonly store: PersistenceStore,
    private readonly logger: Logger,
  ) {}

  getState(): LiveTuningState {
    return structuredClone(this.state);
  }

  start(candidate: LiveTuningRequest): LiveTuningState {
    if (this.activeRun !== null || isActive(this.state.status)) {
      throw new AppError({
        code: 'BUSY',
        message: 'Live tuning is already running',
        recoverable: true,
      });
    }
    if (this.serial.getState().status !== 'connected') {
      throw new AppError({
        code: 'NOT_CONNECTED',
        message: 'Connect before starting live tuning',
        recoverable: true,
      });
    }
    const request = validateRequest(candidate);
    this.activity.acquire('tuning');
    const id = randomUUID();
    this.abortController = new AbortController();
    this.tracePath = path.join(this.sessionsDirectory, `${id}.tuning.jsonl`);
    this.traceQueue = Promise.resolve();
    this.state = {
      id,
      status: 'snapshotting',
      startedAt: new Date().toISOString(),
      endedAt: null,
      currentTarget: null,
      currentBreakpointIndex: 0,
      peaksCollected: 0,
      peakGoal: request.peakCount,
      rollbackGains: null,
      results: [],
      error: null,
    };
    this.notify();
    const activeRun = this.run(request, this.abortController.signal);
    this.activeRun = activeRun;
    const clearActiveRun = (): void => {
      if (this.activeRun === activeRun) {
        this.activeRun = null;
      }
    };
    void activeRun.then(clearActiveRun, clearActiveRun);
    return this.getState();
  }

  async cancel(): Promise<LiveTuningState> {
    const activeRun = this.activeRun;
    if (activeRun === null) {
      return this.getState();
    }
    this.abortController?.abort();
    await activeRun;
    return this.getState();
  }

  subscribe(listener: (state: LiveTuningState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async run(request: ValidatedRequest, signal: AbortSignal): Promise<void> {
    let finalStatus: LiveTuningState['status'] = 'completed';
    let finalError: ReturnType<AppError['toInfo']> | null = null;
    try {
      await mkdir(this.sessionsDirectory, { recursive: true });
      const rollbackGains = await this.snapshotGains(signal);
      this.state = { ...this.state, rollbackGains };
      this.notify();
      await this.command(`M301 P${formatNumber(request.relayKp)} I0 D0`, signal);

      for (let index = 0; index < request.targets.length; index += 1) {
        assertNotAborted(signal);
        const target = request.targets[index]!;
        this.state = {
          ...this.state,
          status: 'heating',
          currentTarget: target,
          currentBreakpointIndex: index,
          peaksCollected: 0,
        };
        this.notify();
        const result = await this.tuneBreakpoint(target, request, signal);
        this.state = { ...this.state, results: [...this.state.results, result] };
        this.notify();
      }
    } catch (error) {
      const appError = asAppError(error);
      if (signal.aborted) {
        finalStatus = 'cancelled';
      } else {
        finalStatus = 'failed';
        finalError = appError.toInfo();
        this.logger.error('Live heater tuning failed', { error: appError.message });
      }
    } finally {
      this.state = { ...this.state, status: 'rolling-back' };
      this.notify();
      let heaterOffAcknowledged = false;
      if (this.serial.getState().status === 'connected') {
        try {
          await this.serial.sendAndWait('M104 S0', 8_000, undefined, 'system');
          heaterOffAcknowledged = true;
        } catch (error) {
          const heaterOffError = asAppError(error);
          finalStatus = 'failed';
          finalError = new AppError({
            code: 'SERIAL_WRITE_FAILED',
            message: `Tuning ended, but heater-off could not be confirmed: ${heaterOffError.message}`,
            recoverable: true,
          }).toInfo();
        }
      } else {
        await this.serial.bestEffortHeaterOff();
      }
      const rollback = this.state.rollbackGains;
      if (
        rollback !== null &&
        this.serial.getState().status === 'connected' &&
        heaterOffAcknowledged
      ) {
        try {
          await this.serial.sendAndWait(
            `M301 P${formatNumber(rollback.kp)} I${formatNumber(rollback.ki)} D${formatNumber(rollback.kd)}`,
            8_000,
            undefined,
            'system',
          );
        } catch (error) {
          const rollbackError = asAppError(error);
          finalStatus = 'failed';
          finalError = new AppError({
            code: 'SERIAL_WRITE_FAILED',
            message: `Tuning ended, but previous PID gains could not be restored: ${rollbackError.message}`,
            recoverable: true,
          }).toInfo();
        }
      }
      this.state = {
        ...this.state,
        status: finalStatus,
        endedAt: new Date().toISOString(),
        currentTarget: null,
        error: finalError,
      };
      this.abortController = null;
      this.activity.release('tuning');
      this.notify();
      await this.traceQueue.catch(() => undefined);
      await this.persistSession().catch((error: unknown) => {
        this.logger.warn('Unable to retain tuning session', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async snapshotGains(signal: AbortSignal): Promise<PidGains> {
    const values = new Map<string, number>();
    const unsubscribe = this.serial.subscribe('parsed', ({ parsed }) => {
      if (parsed.kind !== 'setting') {
        return;
      }
      const key = parsed.name.trim().toLowerCase();
      if (key === 'kp' || key === 'ki' || key === 'kd') {
        const value = Number(parsed.value);
        if (Number.isFinite(value)) {
          values.set(key, value);
        }
      }
    });
    try {
      await this.serial.sendAndWait('M503', 8_000, signal, 'tuning');
    } finally {
      unsubscribe();
    }
    const kp = values.get('kp');
    const ki = values.get('ki');
    const kd = values.get('kd');
    if (kp === undefined || ki === undefined || kd === undefined) {
      throw new AppError({
        code: 'INVALID_STATE',
        message: 'Live PID gains could not be read through M503; tuning was not started',
        recoverable: true,
      });
    }
    return { kp, ki, kd };
  }

  private async tuneBreakpoint(
    target: number,
    request: ValidatedRequest,
    signal: AbortSignal,
  ): Promise<TuningBreakpointResult> {
    const stageStarted = performance.now();
    const peaks: TuningPeak[] = [];
    let phase: 'heating' | 'cooling' = 'heating';
    let phaseExtreme = -Infinity;
    let phaseSamples = 0;
    let relayStateObserved = false;

    await this.command(`M104 S${formatNumber(target)}`, signal);
    while (peaks.length < request.peakCount) {
      assertNotAborted(signal);
      if (performance.now() - stageStarted > request.stageTimeoutMs) {
        throw new AppError({
          code: 'TIMEOUT',
          message: `Tuning at ${target}°C exceeded its time limit`,
          recoverable: true,
        });
      }
      await delay(request.sampleIntervalMs, signal);
      const telemetry = await this.sample(signal);
      validateTelemetry(telemetry, target, request);
      phaseSamples += 1;
      relayStateObserved ||=
        phase === 'heating'
          ? telemetry.power >= PWM_ON_THRESHOLD
          : telemetry.power <= PWM_OFF_THRESHOLD;
      phaseExtreme =
        phase === 'heating'
          ? Math.max(phaseExtreme, telemetry.average)
          : Math.min(phaseExtreme, telemetry.average);
      await this.appendTrace({
        timestamp: new Date().toISOString(),
        elapsedSeconds: (performance.now() - stageStarted) / 1_000,
        target,
        phase,
        telemetry,
      });

      if (!relayStateObserved && phaseSamples >= 3) {
        throw new AppError({
          code: 'INVALID_STATE',
          message: `Firmware output did not reach ${phase === 'heating' ? 'maximum' : 'zero'} during relay tuning`,
          recoverable: true,
        });
      }
      const crossed =
        phase === 'heating'
          ? telemetry.average >= target
          : telemetry.average <= target - request.hysteresis;
      if (!crossed) {
        continue;
      }
      peaks.push({
        temperature: Number.isFinite(phaseExtreme) ? phaseExtreme : telemetry.average,
        elapsedSeconds: (performance.now() - stageStarted) / 1_000,
        phase,
      });
      this.state = { ...this.state, peaksCollected: peaks.length };
      this.notify();
      if (peaks.length >= request.peakCount) {
        break;
      }

      phase = phase === 'heating' ? 'cooling' : 'heating';
      phaseExtreme = phase === 'heating' ? Infinity : -Infinity;
      // Correct extrema initialization for the new direction.
      phaseExtreme = telemetry.average;
      phaseSamples = 0;
      relayStateObserved = false;
      this.state = { ...this.state, status: phase };
      this.notify();
      await this.command(
        phase === 'heating'
          ? `M104 S${formatNumber(target)}`
          : `M104 S${formatNumber(target - request.hysteresis)}`,
        signal,
      );
    }
    await this.command('M104 S0', signal);
    return { target, peaks, candidates: calculateCandidates(peaks) };
  }

  private async sample(signal: AbortSignal): Promise<TemperatureTelemetry> {
    const response = await this.serial.sendAndWait('M105', 5_000, signal, 'tuning');
    if (response.parsed.kind !== 'telemetry') {
      throw new AppError({
        code: 'INVALID_STATE',
        message: 'M105 returned no temperature telemetry',
        recoverable: true,
      });
    }
    return response.parsed.value;
  }

  private async command(command: string, signal: AbortSignal): Promise<ParsedFirmwareLine> {
    const response = await this.serial.sendAndWait(command, 8_000, signal, 'tuning');
    if (response.parsed.kind === 'error') {
      throw new AppError({ code: 'INVALID_STATE', message: response.raw, recoverable: true });
    }
    return response.parsed;
  }

  private async appendTrace(sample: TuningSample): Promise<void> {
    const tracePath = this.tracePath;
    if (tracePath === null) {
      return;
    }
    this.traceQueue = this.traceQueue.then(() =>
      appendFile(tracePath, `${JSON.stringify(sample)}\n`, 'utf8'),
    );
    await this.traceQueue;
  }

  private async persistSession(): Promise<void> {
    if (this.state.id === null || this.state.startedAt === null || this.state.endedAt === null) {
      return;
    }
    const data: JsonValue = {
      condition: 'Standard load',
      status: this.state.status,
      tracePath: this.tracePath,
      rollbackGains: this.state.rollbackGains,
      results: this.state.results,
    } as unknown as JsonValue;
    const session: SessionMetadata = {
      id: this.state.id,
      version: 1,
      kind: 'tuning',
      title: `Live PID tuning ${this.state.startedAt}`,
      startedAt: this.state.startedAt,
      endedAt: this.state.endedAt,
      pinned: false,
      data,
    };
    await this.store.saveSession(session);
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export function calculateCandidates(peaks: readonly TuningPeak[]): readonly TuningCandidate[] {
  if (peaks.length < 5) {
    throw new AppError({
      code: 'INVALID_STATE',
      message: 'At least five relay peaks are required',
      recoverable: true,
    });
  }
  const cycleTimes: { readonly seconds: number; readonly position: number }[] = [];
  for (let position = 4; position < peaks.length; position += 1) {
    cycleTimes.push({
      seconds: peaks[position]!.elapsedSeconds - peaks[position - 2]!.elapsedSeconds,
      position,
    });
  }
  cycleTimes.sort((left, right) => left.seconds - right.seconds);
  const selected = cycleTimes[Math.floor(cycleTimes.length / 2)]!;
  const temperatureAmplitude =
    0.5 *
    Math.abs(peaks[selected.position]!.temperature - peaks[selected.position - 1]!.temperature);
  if (!(temperatureAmplitude > 0) || !(selected.seconds > 0)) {
    throw new AppError({
      code: 'INVALID_STATE',
      message: 'Relay peaks cannot produce stable PID values',
      recoverable: true,
    });
  }
  // QuickPID consumes actuator units directly (0..255). Klipper uses normalized
  // power and multiplies its reported gains by PID_PARAM_BASE (255); using 255 as
  // relay amplitude here is the equivalent scaling.
  const ku = (4 * PWM_MAX) / (Math.PI * temperatureAmplitude);
  const tuSeconds = selected.seconds;
  const klipperKp = 0.6 * ku;
  const klipper: TuningCandidate = {
    method: 'klipper-ziegler-nichols',
    ku,
    tuSeconds,
    gains: {
      kp: klipperKp,
      ki: klipperKp / (0.5 * tuSeconds),
      kd: klipperKp * (0.125 * tuSeconds),
    },
  };
  const conservativeKp = 0.33 * ku;
  const conservative: TuningCandidate = {
    method: 'conservative',
    ku,
    tuSeconds,
    gains: {
      kp: conservativeKp,
      ki: conservativeKp / tuSeconds,
      kd: conservativeKp * (0.125 * tuSeconds),
    },
  };
  return [klipper, conservative];
}

function validateRequest(value: LiveTuningRequest): ValidatedRequest {
  if (typeof value !== 'object' || value === null || !Array.isArray(value.targets)) {
    throw invalid('Tuning targets are required');
  }
  const maximumTarget = finiteInRange(value.maximumTarget ?? 250, 1, 250, 'maximum target');
  if (value.targets.length < 1 || value.targets.length > 5) {
    throw invalid('Select between one and five tuning targets');
  }
  const targets = value.targets.map((target) => finiteInRange(target, 1, maximumTarget, 'target'));
  if (targets.some((target, index) => index > 0 && target <= targets[index - 1]!)) {
    throw invalid('Tuning targets must be strictly ascending');
  }
  return {
    targets,
    hysteresis: finiteInRange(value.hysteresis ?? 5, 0.5, 25, 'hysteresis'),
    peakCount: integerInRange(value.peakCount ?? 12, 5, 30, 'peak count'),
    sampleIntervalMs: integerInRange(
      value.sampleIntervalMs ?? 1_000,
      250,
      10_000,
      'sample interval',
    ),
    stageTimeoutMs: integerInRange(
      value.stageTimeoutMs ?? 7_200_000,
      60_000,
      21_600_000,
      'stage timeout',
    ),
    relayKp: finiteInRange(value.relayKp ?? 1_000, 51, 100_000, 'relay proportional gain'),
    maximumTarget,
    maximumSensorDifference: finiteInRange(
      value.maximumSensorDifference ?? 25,
      1,
      100,
      'sensor difference',
    ),
  };
}

function validateTelemetry(
  telemetry: TemperatureTelemetry,
  target: number,
  request: ValidatedRequest,
): void {
  const [first, second] = telemetry.thermistors;
  if (Math.abs(first - second) > request.maximumSensorDifference) {
    throw new AppError({
      code: 'INVALID_STATE',
      message: 'Control thermistors disagree beyond the tuning limit',
      recoverable: true,
    });
  }
  if (telemetry.average > request.maximumTarget || telemetry.average > target + 25) {
    throw new AppError({
      code: 'INVALID_STATE',
      message: 'Tuning overshoot limit was exceeded',
      recoverable: true,
    });
  }
  if (telemetry.power < 0 || telemetry.power > PWM_MAX) {
    throw new AppError({
      code: 'INVALID_STATE',
      message: 'Firmware reported an invalid heater output',
      recoverable: true,
    });
  }
}

function finiteInRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalid(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function integerInRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw invalid(`${label} must be an integer`);
  }
  return finiteInRange(value, minimum, maximum, label);
}

function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new AppError({ code: 'INVALID_STATE', message: 'Tuning cancelled', recoverable: true }),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AppError({ code: 'INVALID_STATE', message: 'Tuning cancelled', recoverable: true });
  }
}

function invalid(message: string): AppError {
  return new AppError({ code: 'INVALID_ARGUMENT', message, recoverable: true });
}

function isActive(status: LiveTuningState['status']): boolean {
  return ['snapshotting', 'heating', 'cooling', 'rolling-back'].includes(status);
}

function idleState(): LiveTuningState {
  return {
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
}
