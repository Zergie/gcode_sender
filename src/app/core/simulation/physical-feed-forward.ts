import {
  FIRMWARE_QUICK_PID_SAMPLE_SECONDS,
  stepFirmwareQuickPid,
  truncateFirmwareM104Setpoint,
  validateTargetShaperConfiguration,
  type ControlMode,
  type FirmwareQuickPidState,
  type ModelAssistedTargetConfiguration,
  type PidGains,
  type TargetShaperState,
  type TargetShaperStepResult,
} from '../control';
import {
  createThermalTwin,
  type ThermalObserverCorrection,
  type ThermalSensorObservation,
  type ThermalTwin,
  type ThermalTwinInitialConditions,
  type ThermalTwinProfile,
  type ThermalTwinSnapshot,
} from './physical-twin';
import type { OvenModelProfile } from './types';

/** Shared desktop/offline cadence for recomputing a model-assisted M104 forecast. */
export const PHYSICAL_FORECAST_REPLAN_SECONDS = 5;

export interface ThermalForecastSource {
  readonly profile: ThermalTwinProfile;
  snapshot(): ThermalTwinSnapshot;
  /** Returns an independent cursor without changing the observed plant. */
  fork(): ThermalTwin;
}

export interface PhysicalTwinTelemetryObservation extends ThermalSensorObservation {
  readonly elapsedSeconds: number;
  /** Firmware-reported 8-bit compare value actually applied to the shared heater GPIO. */
  readonly appliedPwm8: number;
}

export interface PhysicalTwinObserver extends ThermalForecastSource {
  readonly profile: ThermalTwinProfile;
  /**
   * Advances persistent hidden thermal states with reported PWM, then corrects only T1/T2/T3.
   * Each sensor correction starts a new physical energy-ledger epoch; the returned correction
   * reports the energy imposed by the estimator operation.
   */
  observe(observation: PhysicalTwinTelemetryObservation): ThermalObserverCorrection;
}

export interface PhysicalTwinObserverInitialization extends ThermalTwinInitialConditions {
  readonly initialSensorsC?: ThermalSensorObservation;
}

export interface PhysicalForecastPlannerState {
  readonly planCount: number;
  readonly lastRequestedTargetC: number;
  readonly lastFirmwareTargetC: number;
}

export interface PhysicalForecastCandidate {
  readonly firmwareTargetC: number;
  readonly trackingCostC2Seconds: number;
  readonly finalT1C: number;
  readonly finalT2C: number;
  readonly finalT3C: number;
  readonly maximumSensorSpreadC: number;
}

export interface PhysicalForecastDiagnostics {
  readonly horizonSeconds: number;
  readonly candidatesEvaluated: number;
  readonly selected: PhysicalForecastCandidate;
}

export interface PhysicalForecastPlan extends TargetShaperStepResult {
  /** Null in transparent PID mode or when no forecast source is available. */
  readonly forecast: PhysicalForecastDiagnostics | null;
}

export interface PhysicalForecastPlannerInput {
  readonly mode: ControlMode;
  readonly source: ThermalForecastSource;
  readonly firmwarePidState: FirmwareQuickPidState;
  readonly requestedTargetC: number;
  /** Exact future scenario/profile target at an offset from the current planning instant. */
  readonly targetAtOffsetSeconds?: (offsetSeconds: number) => number;
  /** Host planning interval, used only to report the unmodified trajectory's actual rate. */
  readonly stepSeconds: number;
}

export interface PhysicalForecastPlanner {
  snapshot(): PhysicalForecastPlannerState;
  plan(input: PhysicalForecastPlannerInput): PhysicalForecastPlan;
}

export interface PhysicalForecastPlannerInitialization {
  readonly configuration: ModelAssistedTargetConfiguration;
  readonly initialTargetC: number;
}

/**
 * Compatibility input used by live control until its telemetry observer is wired in. Supplying
 * forecastSource and firmwarePidState enables the same twin-derived planner used offline. Without
 * both, model assistance is deliberately transparent instead of falling back to a scalar model.
 */
export interface PhysicalFeedForwardInput {
  readonly mode: ControlMode;
  readonly profile: OvenModelProfile;
  readonly configuration: ModelAssistedTargetConfiguration;
  readonly state: TargetShaperState;
  readonly requestedTargetC: number;
  readonly measuredTemperatureC: number;
  readonly measuredPidOutput: number;
  readonly activeGains: PidGains;
  readonly stepSeconds: number;
  readonly forecastSource?: ThermalForecastSource;
  readonly firmwarePidState?: FirmwareQuickPidState;
  readonly targetAtOffsetSeconds?: (offsetSeconds: number) => number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
}

function controlTemperature(snapshot: ThermalTwinSnapshot): number {
  return (snapshot.temperaturesC.t1 + snapshot.temperaturesC.t2) / 2;
}

function wholeDegreeCommandBounds(configuration: ModelAssistedTargetConfiguration): {
  minimum: number;
  maximum: number;
} {
  return {
    minimum: Math.ceil(configuration.minimumCommandC),
    maximum: Math.floor(configuration.maximumCommandC),
  };
}

function boundedWholeDegreeCommand(
  requestedTargetC: number,
  configuration: ModelAssistedTargetConfiguration,
): number {
  const bounds = wholeDegreeCommandBounds(configuration);
  return clamp(truncateFirmwareM104Setpoint(requestedTargetC), bounds.minimum, bounds.maximum);
}

function directPlan(
  mode: ControlMode,
  configuration: ModelAssistedTargetConfiguration,
  previousTargetC: number,
  requestedTargetC: number,
  stepSeconds: number,
): PhysicalForecastPlan {
  requireFinite(requestedTargetC, 'requestedTargetC');
  requireFinite(previousTargetC, 'previousTargetC');
  requireFinite(stepSeconds, 'stepSeconds');
  if (stepSeconds <= 0) throw new RangeError('stepSeconds must be greater than zero.');
  const firmwareTargetC =
    mode === 'pid'
      ? truncateFirmwareM104Setpoint(requestedTargetC)
      : boundedWholeDegreeCommand(requestedTargetC, configuration);
  const state = { trajectoryTargetC: requestedTargetC, firmwareTargetC };
  return Object.freeze({
    requestedTargetC,
    trajectoryTargetC: requestedTargetC,
    firmwareTargetC,
    trajectoryRateCPerSecond: (requestedTargetC - previousTargetC) / stepSeconds,
    targetLeadC: firmwareTargetC - requestedTargetC,
    state: Object.freeze(state),
    forecast: null,
  });
}

class PersistentPhysicalTwinObserver implements PhysicalTwinObserver {
  readonly profile: ThermalTwinProfile;
  private readonly pendingDutySegments: Array<{ seconds: number; duty: number }> = [];
  private pendingSeconds = 0;

  constructor(private readonly twin: ThermalTwin) {
    this.profile = twin.profile;
  }

  snapshot(): ThermalTwinSnapshot {
    return this.twin.snapshot();
  }

  fork(): ThermalTwin {
    return this.twin.fork();
  }

  observe(observation: PhysicalTwinTelemetryObservation): ThermalObserverCorrection {
    requireFinite(observation.elapsedSeconds, 'observation.elapsedSeconds');
    requireFinite(observation.appliedPwm8, 'observation.appliedPwm8');
    if (observation.elapsedSeconds < 0) {
      throw new RangeError('observation.elapsedSeconds must be non-negative.');
    }
    if (
      !Number.isInteger(observation.appliedPwm8) ||
      observation.appliedPwm8 < 0 ||
      observation.appliedPwm8 > 255
    ) {
      throw new RangeError('observation.appliedPwm8 must be an integer in 0..255.');
    }
    this.enqueueReportedDuty(observation.elapsedSeconds, observation.appliedPwm8 / 255);
    this.advanceCompleteFixedSteps();
    return this.twin.assimilateSensorObservation(observation);
  }

  private enqueueReportedDuty(seconds: number, duty: number): void {
    if (seconds === 0) return;
    this.pendingDutySegments.push({ seconds, duty });
    this.pendingSeconds += seconds;
  }

  private advanceCompleteFixedSteps(): void {
    const fixedStepSeconds = this.profile.solverStepSeconds;
    const tolerance = fixedStepSeconds * 1e-9;
    while (this.pendingSeconds + tolerance >= fixedStepSeconds) {
      let secondsNeeded = fixedStepSeconds;
      let dutySeconds = 0;
      while (secondsNeeded > tolerance) {
        const segment = this.pendingDutySegments[0];
        if (segment === undefined) {
          throw new Error('Physical observer duty accumulator lost a reported interval.');
        }
        const consumedSeconds = Math.min(secondsNeeded, segment.seconds);
        dutySeconds += consumedSeconds * segment.duty;
        secondsNeeded -= consumedSeconds;
        const remainingSegmentSeconds = segment.seconds - consumedSeconds;
        if (remainingSegmentSeconds <= tolerance) {
          this.pendingDutySegments.shift();
        } else {
          this.pendingDutySegments[0] = {
            seconds: remainingSegmentSeconds,
            duty: segment.duty,
          };
        }
      }
      this.twin.advance({
        durationSeconds: fixedStepSeconds,
        duty: clamp(dutySeconds / fixedStepSeconds, 0, 1),
      });
      this.pendingSeconds = Math.max(0, this.pendingSeconds - fixedStepSeconds);
    }
  }
}

class TwinDerivedPhysicalForecastPlanner implements PhysicalForecastPlanner {
  private state: PhysicalForecastPlannerState;
  private readonly configuration: ModelAssistedTargetConfiguration;

  constructor(initialization: PhysicalForecastPlannerInitialization) {
    validateTargetShaperConfiguration(initialization.configuration);
    requireFinite(initialization.initialTargetC, 'initialTargetC');
    this.configuration = Object.freeze({ ...initialization.configuration });
    this.state = Object.freeze({
      planCount: 0,
      lastRequestedTargetC: initialization.initialTargetC,
      lastFirmwareTargetC: truncateFirmwareM104Setpoint(initialization.initialTargetC),
    });
  }

  snapshot(): PhysicalForecastPlannerState {
    return this.state;
  }

  plan(input: PhysicalForecastPlannerInput): PhysicalForecastPlan {
    requireFinite(input.requestedTargetC, 'requestedTargetC');
    requireFinite(input.stepSeconds, 'stepSeconds');
    if (input.stepSeconds <= 0) throw new RangeError('stepSeconds must be greater than zero.');

    if (input.mode === 'pid') {
      const plan = directPlan(
        input.mode,
        this.configuration,
        this.state.lastRequestedTargetC,
        input.requestedTargetC,
        input.stepSeconds,
      );
      this.updateState(input.requestedTargetC, plan.firmwareTargetC);
      return plan;
    }

    const solverStepSeconds = input.source.profile.solverStepSeconds;
    const forecastStepSeconds = FIRMWARE_QUICK_PID_SAMPLE_SECONDS;
    const forecastStepsPerPidSample = forecastStepSeconds / solverStepSeconds;
    if (Math.abs(forecastStepsPerPidSample - Math.round(forecastStepsPerPidSample)) > 1e-9) {
      throw new RangeError(
        'source.profile.solverStepSeconds must divide the firmware QuickPID sample interval.',
      );
    }
    const candidatesC = candidateCommands(input.requestedTargetC, this.configuration);
    const forecastStepCount = Math.max(
      1,
      Math.round(this.configuration.predictionHorizonSeconds / forecastStepSeconds),
    );
    const horizonSeconds = forecastStepCount * forecastStepSeconds;
    const referencesC = Array.from({ length: forecastStepCount }, (_, index) => {
      const offsetSeconds = (index + 1) * forecastStepSeconds;
      const targetC = input.targetAtOffsetSeconds?.(offsetSeconds) ?? input.requestedTargetC;
      requireFinite(targetC, `targetAtOffsetSeconds(${offsetSeconds})`);
      return targetC;
    });
    const evaluated = new Map<number, PhysicalForecastCandidate>();
    let selected: PhysicalForecastCandidate | undefined;
    const evaluate = (candidateC: number): void => {
      if (evaluated.has(candidateC)) return;
      const candidate = forecastCandidate(
        input.source,
        input.firmwarePidState,
        candidateC,
        solverStepSeconds,
        forecastStepSeconds,
        referencesC,
      );
      evaluated.set(candidateC, candidate);
      if (
        selected === undefined ||
        candidateIsBetter(candidate, selected, input.requestedTargetC)
      ) {
        selected = candidate;
      }
    };

    evaluate(candidatesC[0]!);
    evaluate(candidatesC.at(-1)!);
    evaluate(
      candidatesC.reduce((nearest, candidate) =>
        Math.abs(candidate - input.requestedTargetC) < Math.abs(nearest - input.requestedTargetC)
          ? candidate
          : nearest,
      ),
    );

    const stride = Math.max(1, Math.ceil((candidatesC.length - 1) / 4));
    if (stride === 1) {
      candidatesC.forEach(evaluate);
    } else {
      for (let index = 0; index < candidatesC.length; index += stride) {
        evaluate(candidatesC[index]!);
      }
      // The candidate objective is locally smooth because the shared actuator and thermal
      // network are continuous; quantized QuickPID creates plateaus, not synthetic dynamics.
      // Refine around the best coarse command at successively smaller whole-degree offsets.
      for (let offset = Math.floor(stride / 2); offset >= 1; offset = Math.floor(offset / 2)) {
        const centerC = selected?.firmwareTargetC;
        if (centerC === undefined) break;
        const lowerC = centerC - offset;
        const upperC = centerC + offset;
        if (lowerC >= candidatesC[0]!) evaluate(lowerC);
        if (upperC <= candidatesC.at(-1)!) evaluate(upperC);
      }
    }
    if (selected === undefined) {
      throw new Error('Physical forecast planner produced no whole-degree candidate.');
    }

    const state = Object.freeze({
      trajectoryTargetC: input.requestedTargetC,
      firmwareTargetC: selected.firmwareTargetC,
    });
    const plan: PhysicalForecastPlan = Object.freeze({
      requestedTargetC: input.requestedTargetC,
      trajectoryTargetC: input.requestedTargetC,
      firmwareTargetC: selected.firmwareTargetC,
      trajectoryRateCPerSecond:
        (input.requestedTargetC - this.state.lastRequestedTargetC) / input.stepSeconds,
      targetLeadC: selected.firmwareTargetC - input.requestedTargetC,
      state,
      forecast: Object.freeze({
        horizonSeconds,
        candidatesEvaluated: evaluated.size,
        selected,
      }),
    });
    this.updateState(input.requestedTargetC, selected.firmwareTargetC);
    return plan;
  }

  private updateState(requestedTargetC: number, firmwareTargetC: number): void {
    this.state = Object.freeze({
      planCount: this.state.planCount + 1,
      lastRequestedTargetC: requestedTargetC,
      lastFirmwareTargetC: firmwareTargetC,
    });
  }
}

function candidateCommands(
  requestedTargetC: number,
  configuration: ModelAssistedTargetConfiguration,
): readonly number[] {
  const commandBounds = wholeDegreeCommandBounds(configuration);
  const leadMinimum = Math.ceil(requestedTargetC - configuration.maximumTargetLeadC);
  const leadMaximum = Math.floor(requestedTargetC + configuration.maximumTargetLeadC);
  const minimum = Math.max(commandBounds.minimum, leadMinimum);
  const maximum = Math.min(commandBounds.maximum, leadMaximum);
  if (minimum > maximum) {
    return [boundedWholeDegreeCommand(requestedTargetC, configuration)];
  }
  return Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
}

function forecastCandidate(
  source: ThermalForecastSource,
  initialPidState: FirmwareQuickPidState,
  firmwareTargetC: number,
  solverStepSeconds: number,
  forecastStepSeconds: number,
  referencesC: readonly number[],
): PhysicalForecastCandidate {
  const twin = source.fork();
  let pidState = initialPidState;
  let snapshot = twin.snapshot();
  let trackingCostC2Seconds = 0;
  let maximumSensorSpreadC = Math.abs(snapshot.temperaturesC.t1 - snapshot.temperaturesC.t2);

  const firstPidStep = stepFirmwareQuickPid(pidState, {
    setpointC: firmwareTargetC,
    measurementC: controlTemperature(snapshot),
    elapsedSeconds: solverStepSeconds,
  });
  const fastFirmwareCadence = firstPidStep.computed;
  const solverStepsPerForecastStep = Math.round(forecastStepSeconds / solverStepSeconds);

  for (let index = 0; index < referencesC.length; index += 1) {
    const referenceC = referencesC[index]!;
    if (fastFirmwareCadence) {
      const pidStep =
        index === 0
          ? firstPidStep
          : stepFirmwareQuickPid(pidState, {
              setpointC: firmwareTargetC,
              measurementC: controlTemperature(snapshot),
              elapsedSeconds: forecastStepSeconds,
            });
      pidState = pidStep.state;
      snapshot = twin.advance({
        durationSeconds: forecastStepSeconds,
        duty: pidStep.pwm8 / 255,
      });
    } else {
      // A live observer may be between firmware sample boundaries. Preserve that phase exactly
      // at fixed solver cadence rather than assuming an immediate controller computation.
      for (let substep = 0; substep < solverStepsPerForecastStep; substep += 1) {
        const pidStep = stepFirmwareQuickPid(pidState, {
          setpointC: firmwareTargetC,
          measurementC: controlTemperature(snapshot),
          elapsedSeconds: solverStepSeconds,
        });
        pidState = pidStep.state;
        snapshot = twin.advance({
          durationSeconds: solverStepSeconds,
          duty: pidStep.pwm8 / 255,
        });
      }
    }
    const t1ErrorC = snapshot.temperaturesC.t1 - referenceC;
    const t2ErrorC = snapshot.temperaturesC.t2 - referenceC;
    // Tracking both physical control beads independently makes imbalance part of the objective.
    trackingCostC2Seconds += (t1ErrorC * t1ErrorC + t2ErrorC * t2ErrorC) * forecastStepSeconds;
    maximumSensorSpreadC = Math.max(
      maximumSensorSpreadC,
      Math.abs(snapshot.temperaturesC.t1 - snapshot.temperaturesC.t2),
    );
  }

  return Object.freeze({
    firmwareTargetC,
    trackingCostC2Seconds,
    finalT1C: snapshot.temperaturesC.t1,
    finalT2C: snapshot.temperaturesC.t2,
    finalT3C: snapshot.temperaturesC.t3,
    maximumSensorSpreadC,
  });
}

function candidateIsBetter(
  candidate: PhysicalForecastCandidate,
  incumbent: PhysicalForecastCandidate,
  requestedTargetC: number,
): boolean {
  const costTolerance =
    1e-12 * Math.max(1, candidate.trackingCostC2Seconds, incumbent.trackingCostC2Seconds);
  if (candidate.trackingCostC2Seconds < incumbent.trackingCostC2Seconds - costTolerance) {
    return true;
  }
  if (
    Math.abs(candidate.trackingCostC2Seconds - incumbent.trackingCostC2Seconds) <= costTolerance
  ) {
    const candidateDistance = Math.abs(candidate.firmwareTargetC - requestedTargetC);
    const incumbentDistance = Math.abs(incumbent.firmwareTargetC - requestedTargetC);
    return (
      candidateDistance < incumbentDistance ||
      (candidateDistance === incumbentDistance &&
        candidate.firmwareTargetC < incumbent.firmwareTargetC)
    );
  }
  return false;
}

export function createPhysicalTwinObserver(
  initialization: PhysicalTwinObserverInitialization = {},
): PhysicalTwinObserver {
  const twin = createThermalTwin(initialization);
  if (initialization.initialSensorsC !== undefined) {
    twin.assimilateSensorObservation(initialization.initialSensorsC);
  }
  return new PersistentPhysicalTwinObserver(twin);
}

export function createPhysicalForecastPlanner(
  initialization: PhysicalForecastPlannerInitialization,
): PhysicalForecastPlanner {
  return new TwinDerivedPhysicalForecastPlanner(initialization);
}

/** Compatibility wrapper; offline simulation uses a persistent planner directly. */
export function stepPhysicalFeedForward(input: PhysicalFeedForwardInput): PhysicalForecastPlan {
  if (input.forecastSource !== undefined && input.firmwarePidState !== undefined) {
    return createPhysicalForecastPlanner({
      configuration: input.configuration,
      initialTargetC: input.state.trajectoryTargetC,
    }).plan({
      mode: input.mode,
      source: input.forecastSource,
      firmwarePidState: input.firmwarePidState,
      requestedTargetC: input.requestedTargetC,
      targetAtOffsetSeconds: input.targetAtOffsetSeconds,
      stepSeconds: input.stepSeconds,
    });
  }
  validateTargetShaperConfiguration(input.configuration);
  return directPlan(
    input.mode,
    input.configuration,
    input.state.trajectoryTargetC,
    input.requestedTargetC,
    input.stepSeconds,
  );
}
