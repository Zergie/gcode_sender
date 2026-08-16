import {
  ChangeDetectionStrategy,
  Component,
  NgZone,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import {
  DEFAULT_SIMULATION_CONTROLLER,
  cloneOvenModelProfile,
  compareSimulations,
  validateOvenModelProfile,
  type AmbientBoundaryConfiguration,
  type LinearHeatTransferMechanism,
  type OvenModelProfile,
  type RadiationHeatLink,
  type SimulationComparisonRequest,
  type SimulationComparisonResult,
  type SimulationSample,
  type SimulationTimewarp,
  type ThermalBodyId,
  type ThermalTwinGeometry,
} from '../../core/simulation';
import {
  validateTargetShaperConfiguration,
  type ModelAssistedTargetConfiguration,
} from '../../core/control';
import type { TrendPoint } from '../../core/platform/workbench.store';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { PageHeaderComponent } from '../../shared/page-header';
import { TrendChartComponent } from '../../shared/trend-chart';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from './simulation-worker.protocol';

const SIMULATION_TREND_ORIGIN_MS = Date.UTC(2026, 7, 15, 12, 0, 0);
const DISPLAYED_METRIC_TOLERANCE_C = 0.005;

type HeaterPosition = keyof OvenModelProfile['heaters'];
type RadiationParameter = keyof Pick<RadiationHeatLink, 'areaM2' | 'emissivity' | 'viewFactor'>;

const BODY_LABELS: Readonly<Record<ThermalBodyId, string>> = {
  topHeater: 'Top heater body',
  bottomHeater: 'Bottom heater body',
  topAir: 'Top chamber air',
  bottomAir: 'Bottom chamber air',
  standardLoad: 'Standard load',
  enclosure: 'Enclosure',
  t1: 'T1 thermistor',
  t2: 'T2 thermistor',
  t3: 'T3 thermistor',
};

const MECHANISM_LABELS: Readonly<Record<LinearHeatTransferMechanism, string>> = {
  conduction: 'Conduction',
  convection: 'Convection',
  'sensor-contact': 'Sensor contact',
};

interface ControllerComparisonInsight {
  readonly kind: 'different' | 'equivalent';
  readonly title: string;
  readonly detail: string;
}

interface SimulationRunContext {
  readonly token: number;
  readonly animate: boolean;
  readonly persist: boolean;
  readonly profile: OvenModelProfile;
  readonly targetC: number;
  readonly durationSeconds: number;
  readonly timewarp: SimulationTimewarp;
}

@Component({
  selector: 'app-simulation',
  imports: [DecimalPipe, FormsModule, PageHeaderComponent, TrendChartComponent],
  templateUrl: './simulation.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimulationComponent implements OnDestroy {
  readonly store = inject(WorkbenchStore);
  private readonly zone = inject(NgZone);
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
  readonly simulationBusy = signal(false);
  readonly simulationError = signal<string | null>(null);
  readonly selectedVariant = signal<'pid' | 'assisted'>('assisted');
  private playback: ReturnType<typeof setInterval> | undefined;
  private playbackWallStartMs = 0;
  private playbackSimulationStartSeconds = 0;
  private simulationWorker: Worker | undefined;
  private simulationRunSequence = 0;
  private activeSimulationRunToken = 0;
  private destroyed = false;

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
  readonly modelSummary = computed(() => {
    const profile = this.profile();
    const geometry = profile.geometry;
    const dimensions = [geometry.widthM, geometry.depthM, geometry.heightM]
      .map((value) => Math.round(value * 1_000))
      .join(' × ');
    return `${dimensions} mm chamber · ${profile.heaters.top.ratedPowerW.toFixed(0)} W top + ${profile.heaters.bottom.ratedPowerW.toFixed(0)} W bottom · one shared GPIO · three physical thermistor bodies.`;
  });
  readonly heatTransferLinks = computed(() =>
    this.profile()
      .linearLinks.map((link, index) => ({ index, link }))
      .filter(({ link }) => link.mechanism !== 'sensor-contact'),
  );
  readonly sensorContactLinks = computed(() =>
    this.profile()
      .linearLinks.map((link, index) => ({ index, link }))
      .filter(({ link }) => link.mechanism === 'sensor-contact'),
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
    // Production renderers calculate the initial comparison off-thread. Non-Worker environments
    // keep the explicit run() fallback without blocking application startup.
    if (typeof Worker !== 'undefined') this.run(false, false);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.invalidateSimulationRun();
    this.stopPlayback();
  }

  run(animate = true, persist = true): void {
    this.stopPlayback();
    this.invalidateSimulationRun();
    this.simulationError.set(null);
    const error = this.configurationError();
    if (error !== null) {
      this.store.notify(error);
      return;
    }
    const profile = this.profile();
    const durationSeconds = Math.max(60, Math.round(this.durationMinutes() * 60));
    const targetC = Math.max(0, Math.min(250, this.target()));
    const timewarp = this.timewarp();
    const request: SimulationComparisonRequest = {
      profile,
      scenario: {
        durationSeconds,
        initialTemperatureC: profile.ambientTemperatureC,
        targets: [{ atSeconds: 0, targetC }],
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
          label: 'Physical feed-forward + PID',
          controller: {
            ...DEFAULT_SIMULATION_CONTROLLER,
            mode: 'model-assisted-pid',
            pid: { ...DEFAULT_SIMULATION_CONTROLLER.pid, schedule: this.store.pidSchedule() },
            modelAssistance: this.modelAssistance(),
          },
        },
      ],
      baselineId: 'pid',
      timewarp,
    };
    const context: SimulationRunContext = {
      token: ++this.simulationRunSequence,
      animate,
      persist,
      profile,
      targetC,
      durationSeconds,
      timewarp,
    };
    this.activeSimulationRunToken = context.token;
    this.simulationBusy.set(true);

    const worker = this.createSimulationWorker();
    if (worker === null) {
      this.runSynchronously(request, context);
      return;
    }

    this.simulationWorker = worker;
    worker.onmessage = ({ data }: MessageEvent<SimulationWorkerResponse>) => {
      this.zone.run(() => this.handleWorkerResponse(worker, context, data));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.zone.run(() =>
        this.failSimulationRun(worker, context, event.message || 'The simulation worker failed.'),
      );
    };
    worker.onmessageerror = () => {
      this.zone.run(() =>
        this.failSimulationRun(worker, context, 'The simulation worker returned invalid data.'),
      );
    };
    const message: SimulationWorkerRequest = { token: context.token, request };
    try {
      worker.postMessage(message);
    } catch (error) {
      this.failSimulationRun(
        worker,
        context,
        error instanceof Error ? error.message : 'The simulation worker could not start.',
      );
    }
  }

  cancelRun(): void {
    this.invalidateSimulationRun();
    this.simulationBusy.set(false);
    this.simulationError.set(null);
    this.paused.set(true);
    this.stopPlayback();
  }

  private runSynchronously(
    request: SimulationComparisonRequest,
    context: SimulationRunContext,
  ): void {
    try {
      this.completeSimulationRun(context, compareSimulations(request));
    } catch (error) {
      this.failSimulationRun(
        undefined,
        context,
        error instanceof Error ? error.message : 'The simulation failed.',
      );
    }
  }

  private handleWorkerResponse(
    worker: Worker,
    context: SimulationRunContext,
    response: SimulationWorkerResponse,
  ): void {
    if (!this.isCurrentSimulationRun(worker, context, response.token)) return;
    if (response.kind === 'failure') {
      this.failSimulationRun(worker, context, response.error);
      return;
    }
    this.releaseSimulationWorker(worker);
    this.completeSimulationRun(context, response.result);
  }

  private completeSimulationRun(
    context: SimulationRunContext,
    result: SimulationComparisonResult,
  ): void {
    if (this.destroyed || context.token !== this.activeSimulationRunToken) return;
    this.simulationBusy.set(false);
    this.simulationError.set(null);
    this.comparison.set(result);
    const total = this.activeEntry()?.result.samples.length ?? 0;
    this.cursor.set(context.animate ? 1 : total);
    this.paused.set(!context.animate);
    if (context.animate) this.startPlayback();
    if (context.persist) {
      void this.store.saveSimulationSession({
        profile: context.profile,
        scenario: { targetC: context.targetC, durationSeconds: context.durationSeconds },
        timewarp: context.timewarp,
        variants: result.entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          metrics: entry.result.metrics,
          execution: entry.result.execution,
        })),
      });
    }
  }

  private failSimulationRun(
    worker: Worker | undefined,
    context: SimulationRunContext,
    message: string,
  ): void {
    if (worker !== undefined && !this.isCurrentSimulationRun(worker, context, context.token))
      return;
    if (worker !== undefined) this.releaseSimulationWorker(worker);
    if (this.destroyed || context.token !== this.activeSimulationRunToken) return;
    this.simulationBusy.set(false);
    this.simulationError.set(message);
    this.paused.set(true);
  }

  private createSimulationWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    try {
      return new Worker(new URL('./simulation.worker', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
  }

  private isCurrentSimulationRun(
    worker: Worker,
    context: SimulationRunContext,
    responseToken: number,
  ): boolean {
    return (
      !this.destroyed &&
      this.simulationWorker === worker &&
      context.token === this.activeSimulationRunToken &&
      responseToken === context.token
    );
  }

  private releaseSimulationWorker(worker: Worker): void {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    if (this.simulationWorker === worker) this.simulationWorker = undefined;
  }

  private invalidateSimulationRun(): void {
    this.activeSimulationRunToken = ++this.simulationRunSequence;
    if (this.simulationWorker !== undefined) {
      this.releaseSimulationWorker(this.simulationWorker);
    }
    this.simulationBusy.set(false);
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
    if (!this.paused()) this.startPlayback();
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

  updateGeometryMm(key: keyof ThermalTwinGeometry, millimeters: number): void {
    this.profile.update((profile) => {
      const geometry = { ...profile.geometry, [key]: Number(millimeters) / 1_000 };
      const enclosureRadiatingAreaM2 =
        2 *
        (geometry.widthM * geometry.depthM +
          geometry.widthM * geometry.heightM +
          geometry.depthM * geometry.heightM);
      const standardLoadRadiatingAreaM2 = 2 * geometry.widthM * geometry.depthM;
      const halfAirCapacityJPerK =
        (geometry.widthM *
          geometry.depthM *
          geometry.heightM *
          profile.ambient.airDensityKgPerM3 *
          profile.ambient.airSpecificHeatJPerKgK) /
        2;
      return {
        ...profile,
        geometry,
        ambient: {
          ...profile.ambient,
          enclosureRadiatingAreaM2,
        },
        bodies: {
          ...profile.bodies,
          topAir: { heatCapacityJPerK: halfAirCapacityJPerK },
          bottomAir: { heatCapacityJPerK: halfAirCapacityJPerK },
        },
        radiationLinks: profile.radiationLinks.map((link) =>
          (link.a === 'standardLoad' && link.b === 'enclosure') ||
          (link.a === 'enclosure' && link.b === 'standardLoad')
            ? { ...link, areaM2: standardLoadRadiatingAreaM2 }
            : link,
        ),
      };
    });
  }

  updateHeaterRatedPower(which: HeaterPosition, watts: number): void {
    this.profile.update((profile) => ({
      ...profile,
      heaters: {
        ...profile.heaters,
        [which]: { ...profile.heaters[which], ratedPowerW: Number(watts) },
      },
    }));
  }

  updateBodyHeatCapacity(body: ThermalBodyId, heatCapacityJPerK: number): void {
    this.profile.update((profile) => ({
      ...profile,
      bodies: {
        ...profile.bodies,
        [body]: { ...profile.bodies[body], heatCapacityJPerK: Number(heatCapacityJPerK) },
      },
    }));
  }

  updateLinearConductance(index: number, conductanceWPerK: number): void {
    this.profile.update((profile) => ({
      ...profile,
      linearLinks: profile.linearLinks.map((link, linkIndex) =>
        linkIndex === index ? { ...link, conductanceWPerK: Number(conductanceWPerK) } : link,
      ),
    }));
  }

  updateRadiation(index: number, key: RadiationParameter, value: number): void {
    this.profile.update((profile) => ({
      ...profile,
      radiationLinks: profile.radiationLinks.map((link, linkIndex) =>
        linkIndex === index ? { ...link, [key]: Number(value) } : link,
      ),
    }));
  }

  updateRadiationAreaCm2(index: number, areaCm2: number): void {
    this.updateRadiation(index, 'areaM2', Number(areaCm2) / 10_000);
  }

  updateAmbient<K extends keyof AmbientBoundaryConfiguration>(
    key: K,
    value: AmbientBoundaryConfiguration[K],
  ): void {
    this.profile.update((profile) => {
      const ambient = { ...profile.ambient, [key]: Number(value) };
      if (key !== 'airDensityKgPerM3' && key !== 'airSpecificHeatJPerKgK') {
        return { ...profile, ambient };
      }
      const halfAirCapacityJPerK =
        (profile.geometry.widthM *
          profile.geometry.depthM *
          profile.geometry.heightM *
          ambient.airDensityKgPerM3 *
          ambient.airSpecificHeatJPerKgK) /
        2;
      return {
        ...profile,
        ambient,
        bodies: {
          ...profile.bodies,
          topAir: { heatCapacityJPerK: halfAirCapacityJPerK },
          bottomAir: { heatCapacityJPerK: halfAirCapacityJPerK },
        },
      };
    });
  }

  bodyLabel(body: ThermalBodyId): string {
    return BODY_LABELS[body];
  }

  mechanismLabel(mechanism: LinearHeatTransferMechanism): string {
    return MECHANISM_LABELS[mechanism];
  }

  private startPlayback(): void {
    this.stopPlayback();
    const samples = this.activeEntry()?.result.samples ?? [];
    if (samples.length === 0) {
      this.paused.set(true);
      return;
    }
    if (this.cursor() >= samples.length) this.cursor.set(1);

    const warp = this.timewarp();
    if (warp === 'maximum') {
      this.cursor.set(samples.length);
      this.paused.set(true);
      return;
    }

    const anchorIndex = Math.max(0, Math.min(samples.length - 1, this.cursor() - 1));
    this.playbackWallStartMs = Date.now();
    this.playbackSimulationStartSeconds = samples[anchorIndex]?.timeSeconds ?? 0;
    this.playback = setInterval(() => {
      const activeSamples = this.activeEntry()?.result.samples ?? [];
      const targetSimulationSeconds =
        this.playbackSimulationStartSeconds +
        ((Date.now() - this.playbackWallStartMs) / 1_000) * warp;
      let nextCursor = this.cursor();
      while (
        nextCursor < activeSamples.length &&
        activeSamples[nextCursor]!.timeSeconds <= targetSimulationSeconds
      ) {
        nextCursor += 1;
      }
      this.cursor.set(nextCursor);
      if (nextCursor >= activeSamples.length) {
        this.paused.set(true);
        this.stopPlayback();
      }
    }, 50);
  }

  private stopPlayback(): void {
    if (this.playback !== undefined) {
      clearInterval(this.playback);
      this.playback = undefined;
    }
    this.playbackWallStartMs = 0;
    this.playbackSimulationStartSeconds = 0;
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
