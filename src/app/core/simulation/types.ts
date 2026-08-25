import type {
  ControlMode,
  ModelAssistedTargetConfiguration,
  PidControllerConfiguration,
} from '../control';
import type { ThermalTwinProfile } from './physical-twin';
import type {
  FirmwareWasmArtifact,
  VirtualHardwareConfiguration,
} from '../../../../shared/firmware-contracts';

/**
 * Versioned application profile around the physical thermal-twin definition.
 * The nested profile contains only heat capacities, power sources and physical
 * heat-transfer paths. In particular, there are no waveform, lag, dead-time or
 * oscillation controls.
 */
export interface OvenModelProfile extends ThermalTwinProfile {
  readonly kind: 'physical-thermal-rc';
  readonly minimumTemperatureC: number;
  readonly maximumTemperatureC: number;
}

export interface SimulationControllerConfiguration {
  readonly mode: ControlMode;
  readonly pid: PidControllerConfiguration;
  readonly modelAssistance: ModelAssistedTargetConfiguration;
}

export interface SimulationControllerRuntime {
  readonly kind: 'wasm-firmware';
  readonly artifact: FirmwareWasmArtifact;
  readonly hardware: VirtualHardwareConfiguration;
  readonly initialEeprom?: Uint8Array;
}

export interface TemperatureTargetPoint {
  readonly atSeconds: number;
  readonly targetC: number;
}

/** A line placed on the simulated controller's UART at a deterministic virtual time. */
export interface SimulationSerialCommand {
  readonly atSeconds: number;
  readonly command: string;
}

export interface SimulationScenario {
  readonly durationSeconds: number;
  readonly initialTemperatureC?: number;
  /** Piecewise-constant targets; the first point must start at zero. */
  readonly targets: readonly TemperatureTargetPoint[];
  /** Optional operator input for the simulated controller UART. */
  readonly serialCommands?: readonly SimulationSerialCommand[];
  readonly sampleEverySeconds: number;
}

export type SimulationTimewarp = 1 | 5 | 20 | 100 | 'maximum';

export interface SimulationRequest {
  readonly profile: OvenModelProfile;
  readonly controller: SimulationControllerConfiguration;
  readonly scenario: SimulationScenario;
  /** The selected firmware program that owns the simulated actuator loop. */
  readonly controllerRuntime: SimulationControllerRuntime;
  /** Execution pacing only. It never changes solverStepSeconds. */
  readonly timewarp?: SimulationTimewarp;
}

export interface SimulationTemperatures {
  /** Aggregate control temperature: exactly the average of T1 and T2. */
  readonly t0C: number;
  readonly t1C: number;
  readonly t2C: number;
  readonly t3C: number;
  readonly topZoneC: number;
  readonly bottomZoneC: number;
  readonly enclosureC: number;
}

export interface SimulationActuatorState {
  /** Shared normalized duty requested by the controller. */
  readonly commanded: number;
  /** Shared duty after the firmware's 8-bit PWM quantization. */
  readonly applied: number;
  /** Firmware-compatible PID scale before normalization (normally 0..255). */
  readonly pidOutput: number;
}

export interface SimulationSample {
  readonly timeSeconds: number;
  readonly requestedTargetC: number;
  readonly trajectoryTargetC: number;
  readonly firmwareTargetC: number;
  readonly targetLeadC: number;
  readonly temperatures: SimulationTemperatures;
  readonly actuator: SimulationActuatorState;
}

export interface SimulationMetrics {
  readonly integralAbsoluteErrorCSeconds: number;
  readonly rootMeanSquareErrorC: number;
  readonly maximumOvershootC: number;
  readonly peakTemperatureC: number;
  readonly finalErrorC: number;
  readonly riseTimeSeconds: number | null;
  readonly settlingTimeSeconds: number | null;
  readonly energyWh: number;
  readonly actuatorSaturationPercent: number;
  readonly maximumControlSensorSpreadC: number;
}

export interface SimulationExecutionMetadata {
  readonly fixedStepSeconds: number;
  readonly totalSteps: number;
  readonly timewarp: SimulationTimewarp;
  readonly stepsPerBatch: number;
  readonly simulatedSecondsPerBatch: number;
}

export interface SimulationResult {
  readonly samples: readonly SimulationSample[];
  readonly metrics: SimulationMetrics;
  readonly execution: SimulationExecutionMetadata;
  readonly firmware?: SimulationFirmwareExecution;
}

export interface SimulationFirmwareSerialEvent {
  readonly timeSeconds: number;
  readonly direction: 'rx' | 'tx';
  readonly text: string;
}

export interface SimulationFirmwareIndicatorSample {
  /** Start of the simulated interval summarized by this GPIO observation. */
  readonly intervalStartSeconds: number;
  /** End of the simulated interval summarized by this GPIO observation. */
  readonly timeSeconds: number;
  readonly indicators: Readonly<
    Record<
      string,
      {
        readonly pin: string;
        /** Physical GPIO level at the end of the interval. */
        readonly level: 'high' | 'low';
        /** Logical configured activity state at the end of the interval. */
        readonly active: boolean;
        /** Time-weighted active fraction across the complete summarized interval. */
        readonly activeFraction: number;
      }
    >
  >;
}

export interface SimulationFirmwareExecution {
  readonly buildId: string;
  readonly serialTranscript: readonly SimulationFirmwareSerialEvent[];
  readonly indicatorSamples: readonly SimulationFirmwareIndicatorSample[];
  readonly resetCount: number;
  readonly truncation?: {
    readonly droppedSerialEvents: number;
    readonly droppedSerialBytes: number;
    readonly droppedIndicatorSamples: number;
  };
}

export interface SimulationVariant {
  readonly id: string;
  readonly label: string;
  readonly controller: SimulationControllerConfiguration;
}

export interface SimulationComparisonRequest {
  readonly profile: OvenModelProfile;
  readonly scenario: SimulationScenario;
  readonly variants: readonly SimulationVariant[];
  readonly baselineId: string;
  /** One selected firmware program is instantiated independently for every variant. */
  readonly controllerRuntime: SimulationControllerRuntime;
  readonly timewarp?: SimulationTimewarp;
}

export interface SimulationMetricDelta {
  readonly integralAbsoluteErrorCSeconds: number;
  readonly rootMeanSquareErrorC: number;
  readonly maximumOvershootC: number;
  readonly finalErrorC: number;
  readonly energyWh: number;
  readonly actuatorSaturationPercent: number;
}

export interface SimulationComparisonEntry {
  readonly id: string;
  readonly label: string;
  readonly result: SimulationResult;
  readonly deltaFromBaseline: SimulationMetricDelta;
}

export interface SimulationComparisonResult {
  readonly baselineId: string;
  readonly entries: readonly SimulationComparisonEntry[];
}
