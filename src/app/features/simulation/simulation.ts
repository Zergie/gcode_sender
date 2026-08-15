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
  readonly visibleTrend = computed<readonly TrendPoint[]>(() => {
    const samples = this.activeEntry()?.result.samples.slice(0, this.cursor()) ?? [];
    const origin = Date.now() - (samples.at(-1)?.timeSeconds ?? 0) * 1000;
    return samples.map((sample) => ({
      time: origin + sample.timeSeconds * 1000,
      average: sample.temperatures.t0C,
      t1: sample.temperatures.t1C,
      t2: sample.temperatures.t2C,
      t3: sample.temperatures.t3C,
      target: sample.requestedTargetC,
      modelTarget: sample.firmwareTargetC,
      power: sample.actuator.pidOutput,
    }));
  });
  readonly currentSample = computed(
    () => this.activeEntry()?.result.samples[Math.max(0, this.cursor() - 1)] ?? null,
  );
  readonly preferredVariantId = computed(() => {
    const entries = this.comparison()?.entries ?? [];
    return entries.reduce<string | null>((bestId, entry) => {
      if (bestId === null) return entry.id;
      const best = entries.find((candidate) => candidate.id === bestId);
      return best === undefined ||
        entry.result.metrics.rootMeanSquareErrorC < best.result.metrics.rootMeanSquareErrorC
        ? entry.id
        : bestId;
    }, null);
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
}
