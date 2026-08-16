import type {
  ControlMode,
  ModelAssistedTargetConfiguration,
  PidControllerConfiguration,
  PidGains,
  PidTerms,
} from '../control';

export interface HeaterSourceConfiguration {
  readonly watts: number;
  readonly efficiency: number;
  /** First-order element-to-zone heat-release lag. */
  readonly responseTimeSeconds: number;
}

export interface DualZoneThermalConfiguration {
  readonly topZoneThermalMassJPerC: number;
  readonly bottomZoneThermalMassJPerC: number;
  readonly enclosureThermalMassJPerC: number;
  readonly topZoneHeatLossWPerC: number;
  readonly bottomZoneHeatLossWPerC: number;
  readonly enclosureHeatLossWPerC: number;
  readonly zoneCouplingWPerC: number;
  readonly topToEnclosureCouplingWPerC: number;
  readonly bottomToEnclosureCouplingWPerC: number;
}

export interface SensorConfiguration {
  readonly t1LagSeconds: number;
  readonly t2LagSeconds: number;
  readonly t3LagSeconds: number;
  readonly noiseStandardDeviationC: number;
}

export interface OvenModelProfile {
  readonly version: 1;
  readonly kind: 'dual-zone-shared-actuator';
  readonly name: string;
  readonly ambientTemperatureC: number;
  readonly topHeater: HeaterSourceConfiguration;
  readonly bottomHeater: HeaterSourceConfiguration;
  readonly thermal: DualZoneThermalConfiguration;
  readonly actuationDeadTimeSeconds: number;
  readonly sensors: SensorConfiguration;
  readonly solverStepSeconds: number;
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
  readonly seed?: number;
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
  /** Shared normalized duty after transport dead time. */
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
  readonly seed: number;
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
  readonly seed?: number;
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

export interface OvenTelemetryPoint {
  readonly timeSeconds: number;
  /** Shared actuator duty normalized to 0..1. */
  readonly actuator: number;
  readonly t1C: number;
  readonly t2C: number;
  readonly t3C: number;
}

export interface ModelFitRequest {
  readonly trace: readonly OvenTelemetryPoint[];
  readonly baseProfile?: OvenModelProfile;
  readonly ambientTemperatureC?: number;
  readonly maximumDeadTimeSeconds?: number;
}

export type ModelFitConfidence = 'low' | 'medium' | 'high';

export interface ModelFitQuality {
  readonly derivativeRmseCPerSecond: number;
  readonly rSquared: number;
  readonly samplesUsed: number;
  readonly estimatedDeadTimeSeconds: number;
  readonly confidence: ModelFitConfidence;
}

export interface ModelFitResult {
  readonly profile: OvenModelProfile;
  readonly quality: ModelFitQuality;
  readonly warnings: readonly string[];
}
