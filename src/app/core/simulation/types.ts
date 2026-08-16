import type {
  ControlMode,
  ModelAssistedTargetConfiguration,
  PidControllerConfiguration,
  PidGains,
  PidTerms,
} from '../control';
import type { ThermalTwinProfile } from './physical-twin';

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

export interface TemperatureTargetPoint {
  readonly atSeconds: number;
  readonly targetC: number;
}

export interface SimulationScenario {
  readonly durationSeconds: number;
  readonly initialTemperatureC?: number;
  /** Piecewise-constant targets; the first point must start at zero. */
  readonly targets: readonly TemperatureTargetPoint[];
  readonly sampleEverySeconds: number;
}

export type SimulationTimewarp = 1 | 5 | 20 | 100 | 'maximum';

export interface SimulationRequest {
  readonly profile: OvenModelProfile;
  readonly controller: SimulationControllerConfiguration;
  readonly scenario: SimulationScenario;
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

export interface SimulationPidState {
  readonly gains: PidGains;
  readonly terms: PidTerms;
}

export interface SimulationSample {
  readonly timeSeconds: number;
  readonly requestedTargetC: number;
  readonly trajectoryTargetC: number;
  readonly firmwareTargetC: number;
  readonly targetLeadC: number;
  readonly temperatures: SimulationTemperatures;
  readonly actuator: SimulationActuatorState;
  readonly pid: SimulationPidState;
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
