import {
  ChangeDetectionStrategy,
  Component,
  NgZone,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import {
  DEFAULT_SIMULATION_CONTROLLER,
  FirmwareInLoopError,
  prepareFirmwarePins,
  validateOvenModelProfile,
  type AmbientBoundaryConfiguration,
  type LinearHeatTransferMechanism,
  type OvenModelProfile,
  type RadiationHeatLink,
  type SimulationComparisonRequest,
  type SimulationComparisonResult,
  type SimulationMetrics,
  type SimulationResult,
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
import { SessionCatalogStore } from '../../core/platform/session-catalog.store';
import { ConfigurationStore } from '../../core/configuration/configuration.store';
import { PageHeaderComponent } from '../../shared/page-header';
import { TrendChartComponent } from '../../shared/trend-chart';
import type { GcodeApi } from '../../../../shared/contracts';
import {
  FIRMWARE_ADC_BITS,
  FIRMWARE_ADC_MAX_VALUE,
  FIRMWARE_EEPROM_MAX_BYTES,
  FIRMWARE_EEPROM_MIN_BYTES,
  type FirmwareDiagnostic,
  type FirmwareToolchainStatus,
  type NtcBetaDivider,
  type PreparedFirmware,
  type VirtualHardwareConfiguration,
  type VirtualPinBinding,
} from '../../../../shared/firmware-contracts';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from './simulation-worker.protocol';

const SIMULATION_TREND_ORIGIN_MS = Date.UTC(2026, 7, 15, 12, 0, 0);
const DISPLAYED_METRIC_TOLERANCE_C = 0.005;
const MAX_FIRMWARE_OUTPUT_LINES = 300;
const SIMULATION_WORKER_DEADLINE_MS = 5 * 60 * 1_000;

type FirmwarePinRole =
  | 'heater-output'
  | 'thermistor-t1'
  | 'thermistor-t2'
  | 'thermistor-t3'
  | 'indicator-output'
  | 'uart-rx'
  | 'uart-tx'
  | 'digital-input'
  | 'analog-input'
  | 'ignored-output';

interface FirmwareOutputLine {
  readonly id: number;
  /** Null identifies an untimed end-of-run summary rather than a fabricated event time. */
  readonly timeSeconds: number | null;
  readonly direction: 'rx' | 'tx' | 'gpio' | 'system';
  readonly text: string;
}

const DEFAULT_NTC_TRANSFER: NtcBetaDivider = {
  kind: 'ntc-beta-divider',
  referenceResistanceOhm: 4_700,
  nominalResistanceOhm: 100_000,
  nominalTemperatureC: 25,
  betaK: 3_950,
  adcBits: FIRMWARE_ADC_BITS,
  topology: 'reference-to-vcc-thermistor-to-ground',
};

function defaultFirmwareHardware(): VirtualHardwareConfiguration {
  return {
    version: 1,
    boardProfileId: 'stm32duino-source-compat-v1',
    pins: [
      {
        kind: 'thermistor-input',
        pin: 'PA6',
        sensor: 't1',
        transfer: { ...DEFAULT_NTC_TRANSFER },
      },
      {
        kind: 'thermistor-input',
        pin: 'PA0',
        sensor: 't2',
        transfer: { ...DEFAULT_NTC_TRANSFER },
      },
      {
        kind: 'thermistor-input',
        pin: 'PA5',
        sensor: 't3',
        transfer: { ...DEFAULT_NTC_TRANSFER },
      },
      {
        kind: 'heater-output',
        pin: 'PB9',
        actuator: 'shared-heaters',
        activeLevel: 'high',
        sampling: 'edge-integrated',
      },
      {
        kind: 'indicator-output',
        pin: 'PC13',
        indicatorId: 'status-led',
        label: 'Status LED',
        activeLevel: 'low',
      },
      { kind: 'uart-rx', pin: 'PA10', uartId: 'console' },
      { kind: 'uart-tx', pin: 'PA9', uartId: 'console' },
    ],
    eeprom: { initialFill: 255, sizeBytes: 1_024 },
  };
}

function cloneFirmwareHardware(
  hardware: VirtualHardwareConfiguration,
): VirtualHardwareConfiguration {
  return {
    ...hardware,
    pins: hardware.pins.map((binding) =>
      binding.kind === 'thermistor-input'
        ? { ...binding, transfer: { ...binding.transfer } }
        : { ...binding },
    ),
    eeprom: { ...hardware.eeprom },
  };
}

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
  readonly resumeAtSeconds: number;
}

interface QueuedFirmwareTerminalCommand {
  readonly id: number;
  readonly atSeconds: number;
  readonly command: string;
}

@Component({
  selector: 'app-simulation',
  imports: [DecimalPipe, FormsModule, PageHeaderComponent, TrendChartComponent],
  templateUrl: './simulation.html',
  styleUrl: './simulation.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimulationComponent implements OnDestroy {
  readonly embedded = input(false);
  readonly firmwareAdcBits = FIRMWARE_ADC_BITS;
  readonly firmwareAdcMaximum = FIRMWARE_ADC_MAX_VALUE;
  readonly firmwareEepromMinimum = FIRMWARE_EEPROM_MIN_BYTES;
  readonly firmwareEepromMaximum = FIRMWARE_EEPROM_MAX_BYTES;
  readonly store = inject(WorkbenchStore);
  readonly sessionCatalog = inject(SessionCatalogStore);
  readonly configuration = inject(ConfigurationStore);
  private readonly zone = inject(NgZone);
  /** Shared with Settings so the twin always runs the configured physical model. */
  readonly profile = this.configuration.ovenModelProfile;
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
  readonly selectedVariant = signal('assisted');
  readonly firmwareBuildBusy = signal(false);
  readonly firmwareAdvanced = signal(false);
  readonly firmwareToolchain = signal<FirmwareToolchainStatus | null>(null);
  readonly preparedFirmware = signal<PreparedFirmware | null>(null);
  readonly firmwareDiagnostics = signal<readonly FirmwareDiagnostic[]>([]);
  private readonly firmwareEditError = signal<string | null>(null);
  readonly firmwareHardware = this.configuration.firmwareInLoopHardware;
  readonly firmwareOutput = signal<readonly FirmwareOutputLine[]>([]);
  readonly firmwareTerminalInput = signal('M105');
  readonly firmwareTerminalTimeSeconds = signal(0);
  readonly firmwareTerminalCommands = signal<readonly QueuedFirmwareTerminalCommand[]>([]);
  private observedPhysicalConfigurationRevision: number | undefined;
  private readonly physicalConfigurationEffect = effect(() => {
    const revision = this.configuration.physicalConfigurationRevision();
    if (this.observedPhysicalConfigurationRevision === undefined) {
      this.observedPhysicalConfigurationRevision = revision;
      return;
    }
    if (revision === this.observedPhysicalConfigurationRevision || this.destroyed) return;
    this.observedPhysicalConfigurationRevision = revision;
    this.invalidateSimulationResults();
  });

  setFirmwareHardware(hardware: VirtualHardwareConfiguration): void {
    this.showFirmwareHardwareEditResult(
      this.configuration.setVirtualHardwareConfiguration(hardware),
    );
  }

  updateFirmwareHardware(
    update: (hardware: VirtualHardwareConfiguration) => VirtualHardwareConfiguration,
  ): void {
    this.showFirmwareHardwareEditResult(
      this.configuration.setVirtualHardwareConfiguration(update(this.firmwareHardware())),
    );
  }
  private readonly firmwareApi: GcodeApi | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { readonly gcode?: GcodeApi }).gcode;
  private firmwareOutputSequence = 0;
  private playback: ReturnType<typeof setInterval> | undefined;
  private playbackWallStartMs = 0;
  private playbackSimulationStartSeconds = 0;
  private simulationWorker: Worker | undefined;
  private simulationWorkerDeadline: ReturnType<typeof setTimeout> | undefined;
  private simulationRunSequence = 0;
  private activeSimulationRunToken = 0;
  private destroyed = false;
  private readonly browserFixtureEffect = effect(() => {
    if (this.store.demoState() === 'simulation' && this.comparison() === null) {
      this.seedBrowserFixture();
    }
  });

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
  readonly firmwareNtc = computed<NtcBetaDivider>(() => {
    const firstThermistor = this.firmwareHardware().pins.find(
      (binding): binding is Extract<VirtualPinBinding, { readonly kind: 'thermistor-input' }> =>
        binding.kind === 'thermistor-input',
    );
    return firstThermistor?.transfer ?? DEFAULT_NTC_TRANSFER;
  });
  readonly firmwareConfigurationError = computed(() => {
    const editError = this.firmwareEditError();
    if (editError !== null) return editError;
    if (this.preparedFirmware() === null) return 'Choose and build an Arduino .ino sketch.';

    try {
      prepareFirmwarePins(this.firmwareHardware());
      return null;
    } catch (error) {
      if (error instanceof FirmwareInLoopError) return error.message;
      return error instanceof Error ? error.message : 'The virtual hardware mapping is invalid.';
    }
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
      if (this.store.demoState() === 'simulation') return null;
      const firmwareError = this.firmwareConfigurationError();
      if (firmwareError !== null) return firmwareError;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'The simulation configuration is invalid.';
    }
  });

  readonly warps: readonly SimulationTimewarp[] = [1, 5, 20, 100, 'maximum'];
  readonly firmwarePinRoles: ReadonlyArray<{
    readonly value: FirmwarePinRole;
    readonly label: string;
  }> = [
    { value: 'heater-output', label: 'Shared heater' },
    { value: 'thermistor-t1', label: 'Thermistor T1' },
    { value: 'thermistor-t2', label: 'Thermistor T2' },
    { value: 'thermistor-t3', label: 'Thermistor T3' },
    { value: 'indicator-output', label: 'LED / indicator' },
    { value: 'uart-rx', label: 'Serial RX' },
    { value: 'uart-tx', label: 'Serial TX' },
    { value: 'digital-input', label: 'Digital input' },
    { value: 'analog-input', label: 'Analog input' },
    { value: 'ignored-output', label: 'Ignored output' },
  ];

  constructor() {
    const firmware = this.store.firmwareInLoop();
    const hardware = this.store.firmwareInLoopHardware();
    if (firmware !== null) {
      this.preparedFirmware.set(firmware);
      this.firmwareToolchain.set(firmware.toolchain);
      this.firmwareDiagnostics.set(firmware.diagnostics);
      this.setFirmwareHardware(cloneFirmwareHardware(hardware));
    }
  }

  private seedBrowserFixture(): void {
    const samples = Array.from({ length: 49 }, (_, index): SimulationSample => {
      const timeSeconds = index * 5;
      const progress = 1 - Math.exp(-timeSeconds / 150);
      const assistedOffset = Math.min(2.4, timeSeconds / 100);
      const average = 25 + (200 - 25) * progress;
      const t1 = average + 0.6 * Math.sin(timeSeconds / 35);
      const t2 = average - 0.6 * Math.sin(timeSeconds / 35);
      return {
        timeSeconds,
        requestedTargetC: 200,
        trajectoryTargetC: 200,
        firmwareTargetC: 200 + assistedOffset,
        targetLeadC: assistedOffset,
        temperatures: {
          t0C: (t1 + t2) / 2,
          t1C: t1,
          t2C: t2,
          t3C: 25 + (average - 25) * 0.08,
          topZoneC: average + 1.2,
          bottomZoneC: average - 1.2,
          enclosureC: 25 + (average - 25) * 0.35,
        },
        actuator: {
          commanded: Math.max(0, 1 - progress * 0.85),
          applied: Math.max(0, 1 - progress * 0.85),
          pidOutput: Math.round(255 * Math.max(0, 1 - progress * 0.85)),
        },
      };
    });
    const metrics = (offset: number): SimulationMetrics => ({
      integralAbsoluteErrorCSeconds: 12_400 + offset,
      rootMeanSquareErrorC: 14.2 + offset / 10,
      maximumOvershootC: 0.8 + offset / 10,
      peakTemperatureC: 199.8 + offset,
      finalErrorC: 0.2 + offset / 10,
      riseTimeSeconds: 180,
      settlingTimeSeconds: 420,
      energyWh: 48 + offset,
      actuatorSaturationPercent: 4.5,
      maximumControlSensorSpreadC: 1.2,
    });
    const result = (label: string, offset: number): SimulationResult => ({
      samples:
        offset === 0
          ? samples
          : samples.map((sample) => ({
              ...sample,
              firmwareTargetC: sample.firmwareTargetC - offset,
            })),
      metrics: metrics(offset),
      execution: {
        fixedStepSeconds: 0.5,
        totalSteps: 2_400,
        timewarp: 20,
        stepsPerBatch: 100,
        simulatedSecondsPerBatch: 50,
      },
      firmware: {
        buildId: `browser-fixture-${label.toLowerCase().replaceAll(' ', '-')}`,
        serialTranscript: [],
        indicatorSamples: [],
        resetCount: 0,
      },
    });
    this.comparison.set({
      baselineId: 'pid',
      entries: [
        {
          id: 'pid',
          label: 'Firmware PID',
          result: result('Firmware PID', 0),
          deltaFromBaseline: {
            integralAbsoluteErrorCSeconds: 0,
            rootMeanSquareErrorC: 0,
            maximumOvershootC: 0,
            finalErrorC: 0,
            energyWh: 0,
            actuatorSaturationPercent: 0,
          },
        },
        {
          id: 'assisted',
          label: 'Firmware + physical feed-forward',
          result: result('Assisted', -1.1),
          deltaFromBaseline: {
            integralAbsoluteErrorCSeconds: -1_100,
            rootMeanSquareErrorC: -0.11,
            maximumOvershootC: -0.11,
            finalErrorC: -0.11,
            energyWh: -1.1,
            actuatorSaturationPercent: 0,
          },
        },
      ],
    });
    this.cursor.set(samples.length);
    this.paused.set(true);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.invalidateSimulationRun();
    this.stopPlayback();
  }

  run(animate = true, persist = true, resumeAtSeconds = 0): void {
    if (this.store.demoState() === 'simulation' && this.comparison() !== null) return;
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
    const preparedFirmware = this.preparedFirmware();
    if (preparedFirmware === null) {
      this.store.notify('Choose and build an Arduino .ino sketch before running the simulation.');
      return;
    }
    const request: SimulationComparisonRequest = {
      profile,
      scenario: {
        durationSeconds,
        initialTemperatureC: profile.ambientTemperatureC,
        targets: [{ atSeconds: 0, targetC }],
        serialCommands: this.firmwareTerminalCommands().map(({ atSeconds, command }) => ({
          atSeconds,
          command,
        })),
        sampleEverySeconds: 5,
      },
      variants: [
        {
          id: 'pid',
          label: 'Firmware PID',
          controller: {
            ...DEFAULT_SIMULATION_CONTROLLER,
            mode: 'pid',
            pid: { ...DEFAULT_SIMULATION_CONTROLLER.pid, schedule: this.store.pidSchedule() },
            modelAssistance: this.modelAssistance(),
          },
        },
        {
          id: 'assisted',
          label: 'Firmware + physical feed-forward',
          controller: {
            ...DEFAULT_SIMULATION_CONTROLLER,
            mode: 'model-assisted-pid',
            pid: { ...DEFAULT_SIMULATION_CONTROLLER.pid, schedule: this.store.pidSchedule() },
            modelAssistance: this.modelAssistance(),
          },
        },
      ],
      baselineId: 'pid',
      controllerRuntime: {
        kind: 'wasm-firmware' as const,
        artifact: preparedFirmware.artifact,
        hardware: cloneFirmwareHardware(this.firmwareHardware()),
      },
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
      resumeAtSeconds: Math.max(0, Math.min(durationSeconds, resumeAtSeconds)),
    };
    this.activeSimulationRunToken = context.token;
    this.simulationBusy.set(true);

    const worker = this.createSimulationWorker();
    if (worker === null) {
      this.failSimulationRun(
        undefined,
        context,
        'Firmware-in-the-loop requires an isolated simulation worker; the firmware was not executed.',
      );
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
    this.armSimulationWorkerDeadline(worker, context);
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
    const samples = this.activeEntry()?.result.samples ?? [];
    const total = samples.length;
    const resumeIndex = samples.findIndex(
      (sample) => sample.timeSeconds >= context.resumeAtSeconds,
    );
    this.cursor.set(
      context.animate ? Math.max(1, resumeIndex < 0 ? total : resumeIndex + 1) : total,
    );
    this.paused.set(!context.animate);
    if (context.animate) this.startPlayback();
    this.updateFirmwareOutputFromResult(result);
    if (context.persist) {
      void this.sessionCatalog.saveSession(
        'simulation',
        `Simulation · ${new Date().toLocaleString()}`,
        {
          profile: context.profile,
          scenario: { targetC: context.targetC, durationSeconds: context.durationSeconds },
          timewarp: context.timewarp,
          variants: result.entries.map((entry) => ({
            id: entry.id,
            label: entry.label,
            metrics: entry.result.metrics,
            execution: entry.result.execution,
          })),
        },
      );
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
    this.clearSimulationWorkerDeadline();
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
    this.clearSimulationWorkerDeadline();
    this.simulationBusy.set(false);
  }

  private armSimulationWorkerDeadline(worker: Worker, context: SimulationRunContext): void {
    this.clearSimulationWorkerDeadline();
    this.simulationWorkerDeadline = setTimeout(() => {
      this.zone.run(() =>
        this.failSimulationRun(
          worker,
          context,
          'The simulation exceeded its 5 minute wall-clock limit, so its isolated worker was terminated. Firmware may be blocked inside setup() or loop().',
        ),
      );
    }, SIMULATION_WORKER_DEADLINE_MS);
  }

  private clearSimulationWorkerDeadline(): void {
    if (this.simulationWorkerDeadline === undefined) return;
    clearTimeout(this.simulationWorkerDeadline);
    this.simulationWorkerDeadline = undefined;
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

  async refreshFirmwareToolchain(): Promise<void> {
    if (this.firmwareApi === undefined) {
      this.firmwareToolchain.set({
        available: false,
        selected: null,
        adapters: [
          {
            kind: 'local-em++',
            available: false,
            displayName: 'Local Emscripten',
            version: null,
            detail: 'Firmware compilation is available in the Electron desktop app.',
          },
          {
            kind: 'docker-emscripten',
            available: false,
            displayName: 'Docker Emscripten',
            version: null,
            detail: 'Firmware compilation is available in the Electron desktop app.',
          },
        ],
      });
      return;
    }

    try {
      const result = await this.firmwareApi.firmware.getToolchainStatus();
      if (result.ok) {
        this.firmwareToolchain.set(result.value);
        return;
      }
      this.firmwareToolchain.set(null);
      this.store.notify(result.error.message);
    } catch (error) {
      this.firmwareToolchain.set(null);
      this.store.notify(
        error instanceof Error ? error.message : 'The firmware toolchain check failed.',
      );
    }
  }

  async chooseFirmware(): Promise<void> {
    if (this.firmwareApi === undefined) {
      this.firmwareDiagnostics.set([
        {
          severity: 'error',
          phase: 'toolchain',
          code: 'TOOLCHAIN_UNAVAILABLE',
          message: 'Choose and compile Arduino sketches from the Electron desktop app.',
        },
      ]);
      return;
    }

    this.firmwareBuildBusy.set(true);
    this.firmwareDiagnostics.set([]);
    try {
      const result = await this.firmwareApi.firmware.pickAndBuild();
      if (!result.ok) {
        this.firmwareDiagnostics.set([
          {
            severity: 'error',
            phase: 'compile',
            code: 'COMPILE_FAILED',
            message: result.error.message,
          },
        ]);
        return;
      }
      if (result.value === null) return;
      if (result.value.status === 'failed') {
        this.firmwareToolchain.set(result.value.toolchain);
        this.firmwareDiagnostics.set(result.value.diagnostics);
        return;
      }

      this.invalidateSimulationResults();
      this.preparedFirmware.set(result.value.firmware);
      this.firmwareToolchain.set(result.value.firmware.toolchain);
      this.firmwareDiagnostics.set(result.value.firmware.diagnostics);
      this.setFirmwareHardware(cloneFirmwareHardware(result.value.firmware.suggestedHardware));
      this.appendFirmwareOutput({
        timeSeconds: 0,
        direction: 'system',
        text: `${result.value.firmware.source.displayName} is ready (${result.value.firmware.cacheHit ? 'cached build' : 'fresh build'}).`,
      });
    } catch (error) {
      this.firmwareDiagnostics.set([
        {
          severity: 'error',
          phase: 'compile',
          code: 'COMPILE_FAILED',
          message: error instanceof Error ? error.message : 'Firmware compilation failed.',
        },
      ]);
    } finally {
      this.firmwareBuildBusy.set(false);
    }
  }

  resetKnownFirmwareMapping(): void {
    const suggested = this.preparedFirmware()?.suggestedHardware;
    this.invalidateSimulationResults();
    this.showFirmwareHardwareEditResult(
      this.configuration.resetVirtualHardwareConfiguration(
        suggested === undefined ? defaultFirmwareHardware() : cloneFirmwareHardware(suggested),
      ),
    );
  }

  addGenericFirmwarePin(): void {
    const usedPins = new Set(this.firmwareHardware().pins.map((binding) => binding.pin));
    const suggestions = Array.from({ length: 3 }, (_unused, bank) =>
      Array.from(
        { length: 16 },
        (_innerUnused, pin) => `P${String.fromCharCode('A'.charCodeAt(0) + bank)}${pin}`,
      ),
    ).flat();
    const pin = suggestions.find((candidate) => !usedPins.has(candidate));
    if (pin === undefined) {
      this.store.notify('All supported PA, PB and PC virtual pin names are already mapped.');
      return;
    }
    this.invalidateSimulationResults();
    this.showFirmwareHardwareEditResult(
      this.configuration.addVirtualPin({ kind: 'digital-input', pin, level: false }),
    );
  }

  removeFirmwarePin(index: number): void {
    this.invalidateSimulationResults();
    this.showFirmwareHardwareEditResult(this.configuration.removeVirtualPin(index));
  }

  updateFirmwarePinName(index: number, pin: string): void {
    this.updateFirmwareBinding(index, (binding) => ({
      ...binding,
      pin: pin.trim().toUpperCase(),
    }));
  }

  firmwarePinRole(binding: VirtualPinBinding): FirmwarePinRole {
    if (binding.kind === 'thermistor-input') return `thermistor-${binding.sensor}`;
    return binding.kind;
  }

  updateFirmwarePinRole(index: number, role: FirmwarePinRole): void {
    const pin = this.firmwareHardware().pins[index]?.pin ?? '';
    const binding: VirtualPinBinding = (() => {
      switch (role) {
        case 'heater-output':
          return {
            kind: 'heater-output',
            pin,
            actuator: 'shared-heaters',
            activeLevel: 'high',
            sampling: 'edge-integrated',
          };
        case 'thermistor-t1':
        case 'thermistor-t2':
        case 'thermistor-t3':
          return {
            kind: 'thermistor-input',
            pin,
            sensor: role.slice(-2) as 't1' | 't2' | 't3',
            transfer: { ...this.firmwareNtc() },
          };
        case 'indicator-output':
          return {
            kind: 'indicator-output',
            pin,
            indicatorId: `indicator-${pin.toLowerCase() || index + 1}`,
            label: 'Indicator',
            activeLevel: 'high',
          };
        case 'uart-rx':
        case 'uart-tx':
          return { kind: role, pin, uartId: 'console' };
        case 'digital-input':
          return { kind: 'digital-input', pin, level: false };
        case 'analog-input':
          return { kind: 'analog-input', pin, rawValue: 0 };
        case 'ignored-output':
          return { kind: 'ignored-output', pin, reason: 'Not connected in the virtual oven' };
      }
    })();
    this.updateFirmwareBinding(index, () => binding);
  }

  firmwareBindingDetail(binding: VirtualPinBinding): string {
    switch (binding.kind) {
      case 'thermistor-input':
        return binding.sensor.toUpperCase();
      case 'heater-output':
        return 'Top + bottom heaters';
      case 'indicator-output':
        return binding.label;
      case 'uart-rx':
      case 'uart-tx':
        return binding.uartId;
      case 'digital-input':
        return binding.level ? 'Constant HIGH' : 'Constant LOW';
      case 'analog-input':
        return `ADC ${binding.rawValue}`;
      case 'ignored-output':
        return binding.reason;
    }
  }

  firmwareBindingPolarity(binding: VirtualPinBinding): 'high' | 'low' | null {
    if (binding.kind === 'heater-output' || binding.kind === 'indicator-output') {
      return binding.activeLevel;
    }
    if (binding.kind === 'digital-input') return binding.level ? 'high' : 'low';
    return null;
  }

  updateFirmwarePinPolarity(index: number, level: 'high' | 'low'): void {
    this.updateFirmwareBinding(index, (binding) => {
      if (binding.kind === 'heater-output' || binding.kind === 'indicator-output') {
        return { ...binding, activeLevel: level };
      }
      if (binding.kind === 'digital-input') return { ...binding, level: level === 'high' };
      return binding;
    });
  }

  updateFirmwareAnalogValue(index: number, rawValue: number): void {
    this.updateFirmwareBinding(index, (binding) =>
      binding.kind === 'analog-input' ? { ...binding, rawValue: Number(rawValue) } : binding,
    );
  }

  updateFirmwareNtc<K extends keyof Omit<NtcBetaDivider, 'kind' | 'topology' | 'adcBits'>>(
    key: K,
    value: NtcBetaDivider[K],
  ): void {
    const numericValue = Number(value) as NtcBetaDivider[K];
    this.invalidateSimulationResults();
    this.showFirmwareHardwareEditResult(
      this.configuration.updateVirtualThermistor(key, numericValue),
    );
  }

  updateFirmwareEepromSize(sizeBytes: number): void {
    this.invalidateSimulationResults();
    this.showFirmwareHardwareEditResult(this.configuration.updateVirtualEepromSize(sizeBytes));
  }

  updateFirmwareEepromFill(initialFill: 0 | 255): void {
    this.invalidateSimulationResults();
    this.showFirmwareHardwareEditResult(this.configuration.updateVirtualEepromFill(initialFill));
  }

  appendFirmwareOutput(line: Omit<FirmwareOutputLine, 'id'>): void {
    const next = { ...line, id: ++this.firmwareOutputSequence };
    this.firmwareOutput.update((lines) => [...lines, next].slice(-MAX_FIRMWARE_OUTPUT_LINES));
  }

  clearFirmwareOutput(): void {
    this.firmwareOutput.set([]);
  }

  queueFirmwareTerminalCommand(): void {
    if (this.simulationBusy() || this.firmwareBuildBusy()) return;
    const command = this.firmwareTerminalInput().trim();
    const atSeconds = Number(this.firmwareTerminalTimeSeconds());
    if (
      command.length === 0 ||
      command.includes(String.fromCharCode(0)) ||
      /[\r\n]/.test(command)
    ) {
      this.store.notify('Enter one non-empty terminal line without a line break.');
      return;
    }
    if (command.length > 4_096) {
      this.store.notify('A terminal line can contain at most 4096 characters.');
      return;
    }
    const durationSeconds = Math.max(60, Math.round(this.durationMinutes() * 60));
    if (!Number.isFinite(atSeconds) || atSeconds < 0 || atSeconds > durationSeconds) {
      this.store.notify(`Terminal time must be between 0 and ${durationSeconds} seconds.`);
      return;
    }
    this.invalidateSimulationResults();
    this.firmwareTerminalCommands.update((commands) =>
      [...commands, { id: ++this.firmwareOutputSequence, atSeconds, command }].sort(
        (left, right) => left.atSeconds - right.atSeconds || left.id - right.id,
      ),
    );
    this.firmwareTerminalInput.set('');
  }

  sendFirmwareTerminalCommand(): void {
    const wasStarted = this.comparison() !== null;
    const resumeAtSeconds = wasStarted ? (this.currentSample()?.timeSeconds ?? 0) : 0;
    const commandCount = this.firmwareTerminalCommands().length;
    this.firmwareTerminalTimeSeconds.set(resumeAtSeconds);
    this.queueFirmwareTerminalCommand();
    if (this.firmwareTerminalCommands().length === commandCount) return;
    if (!wasStarted) this.timewarp.set(1);
    this.run(true, true, resumeAtSeconds);
  }

  setFirmwareTerminalTimeFromCursor(): void {
    this.firmwareTerminalTimeSeconds.set(this.currentSample()?.timeSeconds ?? 0);
  }

  removeFirmwareTerminalCommand(id: number): void {
    this.invalidateSimulationResults();
    this.firmwareTerminalCommands.update((commands) =>
      commands.filter((command) => command.id !== id),
    );
  }

  clearFirmwareTerminalCommands(): void {
    if (this.firmwareTerminalCommands().length === 0) return;
    this.invalidateSimulationResults();
    this.firmwareTerminalCommands.set([]);
  }

  handleFirmwareTerminalKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    this.queueFirmwareTerminalCommand();
  }

  selectVariant(variantId: string): void {
    this.selectedVariant.set(variantId);
    this.cursor.set(this.activeEntry()?.result.samples.length ?? 0);
    if (this.comparison() !== null) this.updateFirmwareOutputFromResult(this.comparison()!);
  }

  diagnosticLocation(diagnostic: FirmwareDiagnostic): string | null {
    if (diagnostic.file === undefined) return diagnostic.pin ?? null;
    const line = diagnostic.line === undefined ? '' : `:${diagnostic.line}`;
    const column = diagnostic.column === undefined ? '' : `:${diagnostic.column}`;
    return `${diagnostic.file}${line}${column}`;
  }

  private updateFirmwareBinding(
    index: number,
    update: (binding: VirtualPinBinding) => VirtualPinBinding,
  ): void {
    this.invalidateSimulationResults();
    this.showFirmwareHardwareEditResult(this.configuration.updateVirtualPin(index, update));
  }

  private showFirmwareHardwareEditResult(result: {
    readonly ok: boolean;
    readonly errors?: readonly { readonly path: string; readonly message: string }[];
  }): void {
    if (!result.ok) {
      this.firmwareEditError.set(
        result.errors?.map((error) => `${error.path}: ${error.message}`).join('; ') ??
          'The virtual hardware mapping is invalid.',
      );
      this.store.notify(this.firmwareEditError()!);
      return;
    }
    this.firmwareEditError.set(null);
  }

  private invalidateSimulationResults(): void {
    this.invalidateSimulationRun();
    this.stopPlayback();
    this.paused.set(true);
    this.comparison.set(null);
    this.cursor.set(0);
    this.simulationError.set(null);
    this.firmwareOutput.set([]);
  }

  private updateFirmwareOutputFromResult(result: SimulationComparisonResult): void {
    const selectedEntry =
      result.entries.find((entry) => entry.id === this.selectedVariant()) ?? result.entries[0];
    const execution = selectedEntry?.result.firmware;
    if (execution === undefined) {
      this.firmwareOutput.set([]);
      return;
    }

    const lines: Array<Omit<FirmwareOutputLine, 'id'>> = execution.serialTranscript.map(
      (event) => ({
        timeSeconds: event.timeSeconds,
        direction: event.direction,
        text: event.text,
      }),
    );
    for (const sample of execution.indicatorSamples) {
      for (const [indicatorId, indicator] of Object.entries(sample.indicators)) {
        lines.push({
          timeSeconds: sample.timeSeconds,
          direction: 'gpio',
          text: `${indicatorId} (${indicator.pin}) ended ${indicator.active ? 'active' : 'inactive'} · ${indicator.level.toUpperCase()} · ${(indicator.activeFraction * 100).toFixed(1)}% active over ${(sample.timeSeconds - sample.intervalStartSeconds).toFixed(3)} s`,
        });
      }
    }
    if (execution.resetCount > 0) {
      lines.push({
        timeSeconds: null,
        direction: 'system',
        text: `${execution.resetCount} virtual MCU reset${execution.resetCount === 1 ? '' : 's'} observed.`,
      });
    }
    const truncation = execution.truncation;
    if (
      truncation !== undefined &&
      (truncation.droppedSerialEvents > 0 || truncation.droppedIndicatorSamples > 0)
    ) {
      lines.push({
        timeSeconds: null,
        direction: 'system',
        text: `Output capture limit reached: ${truncation.droppedSerialEvents} serial event${truncation.droppedSerialEvents === 1 ? '' : 's'} (${truncation.droppedSerialBytes} bytes) and ${truncation.droppedIndicatorSamples} GPIO interval summar${truncation.droppedIndicatorSamples === 1 ? 'y' : 'ies'} omitted. Firmware execution was not interrupted.`,
      });
    }
    lines.sort((left, right) => {
      if (left.timeSeconds === null) return right.timeSeconds === null ? 0 : 1;
      if (right.timeSeconds === null) return -1;
      return left.timeSeconds - right.timeSeconds;
    });
    this.firmwareOutput.set(
      lines.slice(-MAX_FIRMWARE_OUTPUT_LINES).map((line) => ({
        ...line,
        id: ++this.firmwareOutputSequence,
      })),
    );
  }

  updateTarget(value: number): void {
    this.mutateSimulationConfiguration(() => this.target.set(Number(value)));
  }

  updateDuration(value: number): void {
    this.mutateSimulationConfiguration(() => this.durationMinutes.set(Number(value)));
  }

  updateProfile<K extends keyof OvenModelProfile>(key: K, value: OvenModelProfile[K]): void {
    if (key === 'ambientTemperatureC') {
      this.applyPhysicalModelEdit(() =>
        this.configuration.updateAirProperty('ambientTemperatureC', Number(value)),
      );
    } else if (key === 'name') {
      this.applyPhysicalModelEdit(() => this.configuration.updatePhysicalModelName(String(value)));
    }
  }

  updateAssistance<K extends keyof ModelAssistedTargetConfiguration>(
    key: K,
    value: ModelAssistedTargetConfiguration[K],
  ): void {
    this.mutateSimulationConfiguration(() =>
      this.modelAssistance.update((configuration) => ({
        ...configuration,
        [key]: Number(value),
      })),
    );
  }

  useForControl(): void {
    try {
      validateOvenModelProfile(this.profile());
      validateTargetShaperConfiguration(this.modelAssistance());
    } catch (error) {
      this.store.notify(error instanceof Error ? error.message : 'The physical twin is invalid.');
      return;
    }
    if (!this.store.useModelAssistedControl(this.profile(), this.modelAssistance())) {
      this.store.notify(
        'Choose and compile the Arduino .ino file in Settings before using model-assisted control.',
      );
    }
  }

  saveModelDraft(): void {
    try {
      validateOvenModelProfile(this.profile());
      validateTargetShaperConfiguration(this.modelAssistance());
    } catch (error) {
      this.store.notify(error instanceof Error ? error.message : 'The physical twin is invalid.');
      return;
    }
    void this.store.saveProfile(this.profile().name, 'simulation', 'draft', {
      profile: this.profile(),
      modelAssistance: this.modelAssistance(),
    });
  }

  updateGeometryMm(key: keyof ThermalTwinGeometry, millimeters: number): void {
    this.applyPhysicalModelEdit(() => this.configuration.updateGeometry(key, millimeters));
  }

  updateHeaterRatedPower(which: HeaterPosition, watts: number): void {
    this.applyPhysicalModelEdit(() => this.configuration.updateHeaterPower(which, watts));
  }

  updateBodyHeatCapacity(body: ThermalBodyId, heatCapacityJPerK: number): void {
    if (body === 'topAir' || body === 'bottomAir') return;
    this.applyPhysicalModelEdit(() =>
      this.configuration.updateBodyHeatCapacity(body, heatCapacityJPerK),
    );
  }

  updateLinearConductance(index: number, conductanceWPerK: number): void {
    this.applyPhysicalModelEdit(() =>
      this.configuration.updateLinearConductance(index, conductanceWPerK),
    );
  }

  updateRadiation(index: number, key: RadiationParameter, value: number): void {
    if (key === 'areaM2') {
      this.applyPhysicalModelEdit(() => this.configuration.updateRadiationArea(index, value));
    } else if (key === 'emissivity') {
      this.applyPhysicalModelEdit(() => this.configuration.updateRadiationEmissivity(index, value));
    } else {
      this.applyPhysicalModelEdit(() => this.configuration.updateRadiationViewFactor(index, value));
    }
  }

  updateRadiationAreaCm2(index: number, areaCm2: number): void {
    this.updateRadiation(index, 'areaM2', Number(areaCm2) / 10_000);
  }

  updateAmbient<K extends keyof AmbientBoundaryConfiguration>(
    key: K,
    value: AmbientBoundaryConfiguration[K],
  ): void {
    if (key === 'enclosureRadiatingAreaM2') return;
    this.applyPhysicalModelEdit(() => this.configuration.updateAirProperty(key, Number(value)));
  }

  private applyPhysicalModelEdit(
    edit: () => {
      readonly ok: boolean;
      readonly errors?: readonly { readonly path: string; readonly message: string }[];
    },
  ): void {
    const result = edit();
    if (result.ok) {
      this.invalidateSimulationResults();
    } else {
      this.store.notify(
        result.errors?.map((error) => `${error.path}: ${error.message}`).join('; ') ??
          'The physical twin edit is invalid.',
      );
    }
  }

  private mutateSimulationConfiguration(mutation: () => void): void {
    this.invalidateSimulationResults();
    mutation();
  }

  isDerivedRadiationArea(link: RadiationHeatLink): boolean {
    return (
      (link.a === 'standardLoad' && link.b === 'enclosure') ||
      (link.a === 'enclosure' && link.b === 'standardLoad')
    );
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
