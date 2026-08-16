import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import {
  DEFAULT_SIMULATION_CONTROLLER,
  cloneOvenModelProfile,
  compareSimulations,
  validateOvenModelProfile,
  type OvenModelProfile,
  type SimulationComparisonResult,
  type SimulationSample,
  type SimulationTimewarp,
} from '../../core/simulation';
import {
  validateTargetShaperConfiguration,
  type ModelAssistedTargetConfiguration,
} from '../../core/control';
import type { TrendPoint } from '../../core/platform/workbench.store';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { PageHeaderComponent } from '../../shared/page-header';
import { TrendChartComponent } from '../../shared/trend-chart';

const SIMULATION_TREND_ORIGIN_MS = Date.UTC(2026, 7, 15, 12, 0, 0);
const DISPLAYED_METRIC_TOLERANCE_C = 0.005;

interface ControllerComparisonInsight {
  readonly kind: 'different' | 'equivalent';
  readonly title: string;
  readonly detail: string;
}

@Component({
  selector: 'app-simulation',
  imports: [DecimalPipe, FormsModule, PageHeaderComponent, TrendChartComponent],
  templateUrl: './simulation.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimulationComponent implements OnDestroy {
  readonly store = inject(WorkbenchStore);
  readonly profile = signal<OvenModelProfile>(cloneOvenModelProfile(this.store.ovenModelProfile()));
  readonly modelAssistance = signal<ModelAssistedTargetConfiguration>({
    ...this.store.modelAssistance(),
  });
  readonly target = signal(200);
  readonly durationMinutes = signal(35);
  readonly timewarp = signal<SimulationTimewarp>(20);
  readonly advanced = signal(false);
  readonly paused = signal(true);
  readonly cursor = signal(0);
  readonly comparison = signal<SimulationComparisonResult | null>(null);
  readonly selectedVariant = signal<'pid' | 'assisted'>('assisted');
  private playback: ReturnType<typeof setInterval> | undefined;

  readonly activeEntry = computed(() => {
    const comparison = this.comparison();
    return (
      comparison?.entries.find((entry) => entry.id === this.selectedVariant()) ??
      comparison?.entries[0] ??
      null
    );
  });
  readonly comparisonEntry = computed(() => {
    const activeId = this.activeEntry()?.id;
    return this.comparison()?.entries.find((entry) => entry.id !== activeId) ?? null;
  });
  readonly visibleTrend = computed<readonly TrendPoint[]>(() => {
    const samples = this.activeEntry()?.result.samples.slice(0, this.cursor()) ?? [];
    return this.toTrendPoints(samples);
  });
  readonly comparisonTrend = computed<readonly TrendPoint[]>(() =>
    this.toTrendPoints(this.comparisonEntry()?.result.samples.slice(0, this.cursor()) ?? []),
  );
  readonly currentSample = computed(
    () => this.activeEntry()?.result.samples[Math.max(0, this.cursor() - 1)] ?? null,
  );
  readonly preferredVariantId = computed(() => {
    const entries = [...(this.comparison()?.entries ?? [])].sort(
      (left, right) =>
        left.result.metrics.rootMeanSquareErrorC - right.result.metrics.rootMeanSquareErrorC,
    );
    if (entries.length === 0) return null;
    if (
      entries.length > 1 &&
      Math.abs(
        entries[1]!.result.metrics.rootMeanSquareErrorC -
          entries[0]!.result.metrics.rootMeanSquareErrorC,
      ) < DISPLAYED_METRIC_TOLERANCE_C
    ) {
      return null;
    }
    return entries[0]!.id;
  });
  readonly comparisonInsight = computed<ControllerComparisonInsight | null>(() => {
    const comparison = this.comparison();
    const baseline = comparison?.entries.find((entry) => entry.id === comparison.baselineId);
    const candidate = comparison?.entries.find((entry) => entry.id !== comparison.baselineId);
    if (baseline === undefined || candidate === undefined) return null;

    const pairedSamples = Math.min(baseline.result.samples.length, candidate.result.samples.length);
    let maximumResponseDifferenceC = 0;
    let maximumTargetDifferenceC = 0;
    for (let index = 0; index < pairedSamples; index += 1) {
      const baselineSample = baseline.result.samples[index]!;
      const candidateSample = candidate.result.samples[index]!;
      maximumResponseDifferenceC = Math.max(
        maximumResponseDifferenceC,
        Math.abs(baselineSample.temperatures.t0C - candidateSample.temperatures.t0C),
      );
      maximumTargetDifferenceC = Math.max(
        maximumTargetDifferenceC,
        Math.abs(baselineSample.firmwareTargetC - candidateSample.firmwareTargetC),
      );
    }

    const rmseDifferenceC =
      candidate.result.metrics.rootMeanSquareErrorC - baseline.result.metrics.rootMeanSquareErrorC;
    if (
      Math.abs(rmseDifferenceC) < DISPLAYED_METRIC_TOLERANCE_C &&
      maximumResponseDifferenceC < DISPLAYED_METRIC_TOLERANCE_C
    ) {
      const targetDetail =
        maximumTargetDifferenceC >= DISPLAYED_METRIC_TOLERANCE_C
          ? `Firmware targets differ by up to ${maximumTargetDifferenceC.toFixed(1)} °C, but T0 does not separate at displayed precision.`
          : 'Both controllers produce the same targets and T0 response at displayed precision.';
      return {
        kind: 'equivalent',
        title: 'No measurable response difference in this scenario',
        detail: targetDetail,
      };
    }

    if (Math.abs(rmseDifferenceC) < DISPLAYED_METRIC_TOLERANCE_C) {
      return {
        kind: 'different',
        title: 'Controllers predict different responses',
        detail: `Their headline RMSE is equal at displayed precision. Maximum T0 separation is ${maximumResponseDifferenceC.toFixed(2)} °C.`,
      };
    }

    const preferred = rmseDifferenceC < 0 ? candidate : baseline;
    return {
      kind: 'different',
      title: `${preferred.label} predicts the better tracking response`,
      detail: `${preferred.label} lowers RMSE by ${Math.abs(rmseDifferenceC).toFixed(2)} °C. Maximum T0 separation is ${maximumResponseDifferenceC.toFixed(2)} °C.`,
    };
  });
  readonly configurationError = computed(() => {
    try {
      validateOvenModelProfile(this.profile());
      validateTargetShaperConfiguration(this.modelAssistance());
      if (!Number.isFinite(this.target()) || this.target() < 0 || this.target() > 250) {
        return 'Target must be between 0 and 250 °C.';
      }
      if (
        !Number.isFinite(this.durationMinutes()) ||
        this.durationMinutes() < 1 ||
        this.durationMinutes() > 180
      ) {
        return 'Duration must be between 1 and 180 minutes.';
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'The simulation configuration is invalid.';
    }
  });

  readonly warps: readonly SimulationTimewarp[] = [1, 5, 20, 100, 'maximum'];

  constructor() {
    this.run(false, false);
  }

  ngOnDestroy(): void {
    this.stopPlayback();
  }

  run(animate = true, persist = true): void {
    this.stopPlayback();
    const error = this.configurationError();
    if (error !== null) {
      this.store.notify(error);
      return;
    }
    const profile = this.profile();
    const durationSeconds = Math.max(60, Math.round(this.durationMinutes() * 60));
    const result = compareSimulations({
      profile,
      scenario: {
        durationSeconds,
        initialTemperatureC: profile.ambientTemperatureC,
        targets: [{ atSeconds: 0, targetC: Math.max(0, Math.min(250, this.target())) }],
        sampleEverySeconds: 5,
      },
      variants: [
        {
          id: 'pid',
          label: 'PID',
          controller: {
            ...DEFAULT_SIMULATION_CONTROLLER,
            mode: 'pid',
            pid: { ...DEFAULT_SIMULATION_CONTROLLER.pid, schedule: this.store.pidSchedule() },
            modelAssistance: this.modelAssistance(),
          },
        },
        {
          id: 'assisted',
          label: 'Model-assisted PID',
          controller: {
            ...DEFAULT_SIMULATION_CONTROLLER,
            mode: 'model-assisted-pid',
            pid: { ...DEFAULT_SIMULATION_CONTROLLER.pid, schedule: this.store.pidSchedule() },
            modelAssistance: this.modelAssistance(),
          },
        },
      ],
      baselineId: 'pid',
      seed: 20260815,
      timewarp: this.timewarp(),
    });
    this.comparison.set(result);
    const total = this.activeEntry()?.result.samples.length ?? 0;
    this.cursor.set(animate ? 1 : total);
    this.paused.set(!animate);
    if (animate) this.startPlayback();
    if (persist) {
      void this.store.saveSimulationSession({
        profile,
        scenario: { targetC: this.target(), durationSeconds },
        timewarp: this.timewarp(),
        variants: result.entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          metrics: entry.result.metrics,
          execution: entry.result.execution,
        })),
      });
    }
  }

  togglePlayback(): void {
    this.paused.update((value) => !value);
    if (this.paused()) this.stopPlayback();
    else this.startPlayback();
  }

  reset(): void {
    this.stopPlayback();
    this.cursor.set(1);
    this.paused.set(true);
  }

  step(): void {
    this.paused.set(true);
    this.stopPlayback();
    const total = this.activeEntry()?.result.samples.length ?? 0;
    this.cursor.update((value) => Math.min(total, value + 1));
  }

  selectWarp(value: SimulationTimewarp): void {
    this.timewarp.set(value);
    this.run(!this.paused(), false);
  }

  updateTarget(value: number): void {
    this.target.set(Number(value));
  }

  updateDuration(value: number): void {
    this.durationMinutes.set(Number(value));
  }

  updateProfile<K extends keyof OvenModelProfile>(key: K, value: OvenModelProfile[K]): void {
    this.profile.update((profile) => ({
      ...profile,
      [key]: typeof value === 'number' ? Number(value) : value,
    }));
  }

  updateAssistance<K extends keyof ModelAssistedTargetConfiguration>(
    key: K,
    value: ModelAssistedTargetConfiguration[K],
  ): void {
    this.modelAssistance.update((configuration) => ({ ...configuration, [key]: Number(value) }));
  }

  useForControl(): void {
    const error = this.configurationError();
    if (error !== null) {
      this.store.notify(error);
      return;
    }
    this.store.useModelAssistedControl(this.profile(), this.modelAssistance());
  }

  saveModelDraft(): void {
    const error = this.configurationError();
    if (error !== null) {
      this.store.notify(error);
      return;
    }
    void this.store.saveProfile(this.profile().name, 'simulation', 'draft', {
      profile: this.profile(),
      modelAssistance: this.modelAssistance(),
    });
  }

  updateHeater(which: 'topHeater' | 'bottomHeater', watts: number): void {
    this.profile.update((profile) => ({
      ...profile,
      [which]: { ...profile[which], watts: Number(watts) },
    }));
  }

  updateHeaterEfficiency(which: 'topHeater' | 'bottomHeater', efficiency: number): void {
    this.profile.update((profile) => ({
      ...profile,
      [which]: { ...profile[which], efficiency: Number(efficiency) },
    }));
  }

  updateHeaterResponseTime(which: 'topHeater' | 'bottomHeater', responseTimeSeconds: number): void {
    this.profile.update((profile) => ({
      ...profile,
      [which]: { ...profile[which], responseTimeSeconds: Number(responseTimeSeconds) },
    }));
  }

  updateThermal(key: keyof OvenModelProfile['thermal'], value: number): void {
    this.profile.update((profile) => ({
      ...profile,
      thermal: { ...profile.thermal, [key]: Number(value) },
    }));
  }

  updateSensor(key: keyof OvenModelProfile['sensors'], value: number): void {
    this.profile.update((profile) => ({
      ...profile,
      sensors: { ...profile.sensors, [key]: Number(value) },
    }));
  }

  private startPlayback(): void {
    this.stopPlayback();
    this.playback = setInterval(() => {
      const total = this.activeEntry()?.result.samples.length ?? 0;
      const warp = this.timewarp();
      const increment =
        warp === 'maximum' ? total : warp === 100 ? 18 : warp === 20 ? 5 : warp === 5 ? 2 : 1;
      this.cursor.update((value) => Math.min(total, value + increment));
      if (this.cursor() >= total) {
        this.paused.set(true);
        this.stopPlayback();
      }
    }, 90);
  }

  private stopPlayback(): void {
    if (this.playback !== undefined) {
      clearInterval(this.playback);
      this.playback = undefined;
    }
  }

  private toTrendPoints(samples: readonly SimulationSample[]): readonly TrendPoint[] {
    return samples.map((sample) => ({
      time: SIMULATION_TREND_ORIGIN_MS + sample.timeSeconds * 1000,
      average: sample.temperatures.t0C,
      t1: sample.temperatures.t1C,
      t2: sample.temperatures.t2C,
      t3: sample.temperatures.t3C,
      target: sample.requestedTargetC,
      modelTarget: sample.firmwareTargetC,
      power: sample.actuator.pidOutput,
    }));
  }
}
