import { Injectable, inject, signal } from '@angular/core';
import type { OnDestroy, Signal } from '@angular/core';
import type { GcodeApi, TemperatureTelemetry } from '../../../../shared/contracts';
import type { LiveTuningRequest, LiveTuningState } from '../../../../shared/tuning-contracts';
import { calculateValidationMetrics, type M105Telemetry, type ValidationMetrics } from '../tuning';
import type { PidSchedule } from '../control';
import { NotificationStore } from './notification.store';

export interface ValidationRunState {
  readonly status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
  readonly targetC: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly sampleCount: number;
  readonly maximumDurationMs: number;
  readonly metrics: ValidationMetrics | null;
  readonly error: string | null;
}

const DEFAULT_TUNING: LiveTuningState = {
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

const DEFAULT_VALIDATION: ValidationRunState = {
  status: 'idle',
  targetC: null,
  startedAt: null,
  endedAt: null,
  sampleCount: 0,
  maximumDurationMs: 20 * 60_000,
  metrics: null,
  error: null,
};

/** Owns live tuning and bounded validation state and their experiment lifecycles. */
@Injectable({ providedIn: 'root' })
export class TuningValidationStore implements OnDestroy {
  private readonly notifications = inject(NotificationStore);
  private readonly api: GcodeApi | undefined =
    typeof window === 'undefined' ? undefined : window.gcode;
  private validationTimer: ReturnType<typeof setTimeout> | undefined;
  private validationFinalizing = false;
  private validationSamples: M105Telemetry[] = [];
  private validationSchedule: PidSchedule | null = null;
  private destroyed = false;
  private configured = false;
  private readonly unsubscribe: Array<() => void> = [];
  private refreshSessions: () => Promise<void> = async () => undefined;
  private connected: () => boolean = () => false;
  private beginExclusive: (activity: 'tuning' | 'validation') => Promise<boolean> = async () =>
    false;
  private endExclusive: (activity: 'tuning' | 'validation') => Promise<void> = async () =>
    undefined;
  private disarm: () => void = () => undefined;
  private prepareValidation: (targetC: number, schedule: PidSchedule) => Promise<boolean> =
    async () => false;
  private requestHeaterOff: () => Promise<string | null> = async () => null;
  private saveSession: (title: string, data: unknown, startedAt: string) => Promise<unknown> =
    async () => undefined;
  private completeDemoValidationCallback: (targetC: number) => Promise<void> = async () =>
    undefined;

  private readonly liveTuningState = signal<LiveTuningState>(DEFAULT_TUNING);
  private readonly validationState = signal<ValidationRunState>(DEFAULT_VALIDATION);
  readonly liveTuning: Signal<LiveTuningState> = this.liveTuningState.asReadonly();
  readonly validation: Signal<ValidationRunState> = this.validationState.asReadonly();
  readonly liveTuningForCompatibility = this.liveTuningState;

  configure(options: {
    connected: () => boolean;
    beginExclusive: (activity: 'tuning' | 'validation') => Promise<boolean>;
    endExclusive: (activity: 'tuning' | 'validation') => Promise<void>;
    disarm: () => void;
    prepareValidation: (targetC: number, schedule: PidSchedule) => Promise<boolean>;
    requestHeaterOff: () => Promise<string | null>;
    saveSession: (title: string, data: unknown, startedAt: string) => Promise<unknown>;
    refreshSessions: () => Promise<void>;
    completeDemoValidation: (targetC: number) => Promise<void>;
  }): void {
    this.connected = options.connected;
    this.beginExclusive = options.beginExclusive;
    this.endExclusive = options.endExclusive;
    this.disarm = options.disarm;
    this.prepareValidation = options.prepareValidation;
    this.requestHeaterOff = options.requestHeaterOff;
    this.saveSession = options.saveSession;
    this.refreshSessions = options.refreshSessions;
    this.completeDemoValidationCallback = options.completeDemoValidation;
  }

  initialize(): void {
    if (this.configured || this.api === undefined || this.destroyed) return;
    this.configured = true;
    this.unsubscribe.push(
      this.api.events.onTuningState((state) => {
        this.liveTuningState.set(state);
        if (
          state.status === 'completed' ||
          state.status === 'cancelled' ||
          state.status === 'failed'
        ) {
          window.setTimeout(() => void this.refreshSessions(), 750);
        }
      }),
    );
  }

  replaceTuning(state: LiveTuningState): void {
    this.liveTuningState.set(state);
  }

  async startLiveTuning(targets: readonly number[]): Promise<boolean> {
    this.disarm();
    if (this.api === undefined) {
      if (!(await this.beginExclusive('tuning'))) return false;
      const startedAt = new Date().toISOString();
      this.liveTuningState.set({
        ...DEFAULT_TUNING,
        id: `demo-tune-${Date.now()}`,
        status: 'snapshotting',
        startedAt,
        currentTarget: targets[0] ?? null,
      });
      return true;
    }
    const result = await this.api.tuning.start({
      targets,
      hysteresis: 5,
      peakCount: 12,
      maximumTarget: 250,
    } satisfies LiveTuningRequest);
    if (result.ok) {
      this.liveTuningState.set(result.value);
      return true;
    }
    this.notifications.show(result.error.message);
    return false;
  }

  async cancelLiveTuning(): Promise<void> {
    if (this.api === undefined) {
      await this.endExclusive('tuning');
      this.liveTuningState.update((state) => ({
        ...state,
        status: 'cancelled',
        endedAt: new Date().toISOString(),
      }));
      return;
    }
    const result = await this.api.tuning.cancel();
    if (result.ok) this.liveTuningState.set(result.value);
    else this.notifications.show(result.error.message);
  }

  async startBoundedValidation(targetC: number, schedule: PidSchedule): Promise<boolean> {
    if (!Number.isFinite(targetC) || targetC < 1 || targetC > 250) {
      this.notifications.show('Validation target must be between 1 and 250 °C.');
      return false;
    }
    if (!this.connected()) {
      this.notifications.show('Connect the controller before starting validation.');
      return false;
    }
    if (!(await this.beginExclusive('validation'))) return false;
    this.disarm();
    this.validationSchedule = schedule;
    this.validationSamples = [];
    this.validationFinalizing = false;
    const startedAt = new Date().toISOString();
    this.validationState.set({
      ...DEFAULT_VALIDATION,
      status: 'running',
      targetC,
      startedAt,
    });
    if (!(await this.prepareValidation(targetC, schedule))) {
      await this.finishValidation('failed', 'The validation commands were not accepted.');
      return false;
    }
    if (this.api === undefined) {
      window.setTimeout(() => void this.completeDemoValidationCallback(targetC), 350);
      return true;
    }
    this.validationTimer = setTimeout(
      () => void this.finishValidation('completed'),
      DEFAULT_VALIDATION.maximumDurationMs,
    );
    return true;
  }

  async cancelValidation(): Promise<void> {
    if (this.validation().status === 'running') await this.finishValidation('cancelled');
  }

  async failValidation(reason: string): Promise<void> {
    if (this.validation().status === 'running') await this.finishValidation('failed', reason);
  }

  consumeTelemetry(event: TemperatureTelemetry): void {
    if (this.validation().status !== 'running') return;
    const current = this.validation();
    const startedAt = Date.parse(current.startedAt ?? event.timestamp);
    const receivedAt = Date.parse(event.timestamp);
    const previousAt = this.validationSamples.at(-1)?.atMs ?? -1;
    const relativeAt = Number.isFinite(receivedAt - startedAt) ? receivedAt - startedAt : 0;
    this.validationSamples.push({
      atMs: Math.max(previousAt + 1, relativeAt),
      t0C: event.average,
      t1C: event.thermistors[0],
      t2C: event.thermistors[1],
      t3C: event.thermistors[2],
      reportedTargetC: event.target,
      output: event.power,
      raw: event.raw,
    });
    this.validationState.update((state) => ({
      ...state,
      sampleCount: this.validationSamples.length,
    }));
    if (this.validationSamples.at(-1)!.atMs >= 120_000 && this.validationSamples.length >= 2) {
      try {
        if (
          calculateValidationMetrics(this.validationSamples, current.targetC ?? 0)
            .settlingTimeMs !== undefined
        )
          void this.finishValidation('completed');
      } catch (error) {
        void this.finishValidation(
          'failed',
          error instanceof Error ? error.message : 'Validation telemetry was invalid.',
        );
      }
    }
  }

  async completeDemoValidation(events: readonly TemperatureTelemetry[]): Promise<void> {
    if (this.validation().status !== 'running') return;
    events.forEach((event) => this.consumeTelemetry(event));
    await this.finishValidation('completed');
  }

  replaceValidation(state: ValidationRunState): void {
    this.validationState.set(state);
  }

  private async finishValidation(
    requestedStatus: 'completed' | 'cancelled' | 'failed',
    requestedError: string | null = null,
  ): Promise<void> {
    const current = this.validation();
    if (current.status !== 'running' || this.validationFinalizing) return;
    this.validationFinalizing = true;
    if (this.validationTimer !== undefined) clearTimeout(this.validationTimer);
    this.validationTimer = undefined;
    let metrics: ValidationMetrics | null = null;
    let status = requestedStatus;
    let error = requestedError;
    if (this.validationSamples.length >= 2 && current.targetC !== null) {
      try {
        metrics = calculateValidationMetrics(this.validationSamples, current.targetC);
      } catch (caught) {
        if (status === 'completed') status = 'failed';
        error =
          caught instanceof Error ? caught.message : 'Validation metrics could not be calculated.';
      }
    } else if (status === 'completed') {
      status = 'failed';
      error = 'Validation ended before enough telemetry was collected.';
    }
    if (this.connected()) {
      const heaterOffError = await this.requestHeaterOff();
      if (heaterOffError !== null) {
        status = 'failed';
        error = `Heater-off was not confirmed: ${heaterOffError}`;
        this.notifications.show(error);
      }
    }
    await this.endExclusive('validation');
    const endedAt = new Date().toISOString();
    this.validationState.set({
      ...current,
      status,
      endedAt,
      sampleCount: this.validationSamples.length,
      metrics,
      error,
    });
    await this.saveSession(
      `Validation · ${current.targetC?.toFixed(0) ?? '—'} °C · Standard load`,
      {
        type: 'bounded-validation',
        condition: 'Standard load',
        status,
        targetC: current.targetC,
        pidSchedule: this.validationSchedule,
        metrics,
        sampleCount: this.validationSamples.length,
        maximumDurationMs: current.maximumDurationMs,
        error,
      },
      current.startedAt ?? endedAt,
    );
    this.validationFinalizing = false;
  }

  ngOnDestroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.validationTimer !== undefined) clearTimeout(this.validationTimer);
    this.validationTimer = undefined;
    this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
  }
}
