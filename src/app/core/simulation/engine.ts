import {
  ControlDomainError,
  advancePidGainTransition,
  createFirmwareQuickPidState,
  interpolatePidGains,
  setFirmwareQuickPidTunings,
  stepFirmwareQuickPid,
  truncateFirmwareM104Setpoint,
  validatePidControllerConfiguration,
  validateTargetShaperConfiguration,
  type FirmwareQuickPidState,
  type PidGains,
} from '../control';
import { cloneOvenModelProfile } from './default-profile';
import {
  FirmwareInLoopError,
  loadFirmwareInLoop,
  validateFirmwareInLoopLoad,
  type FirmwareAdvanceResult,
  type FirmwareInLoop,
} from './firmware-in-loop';
import { FirmwareSerialTextDecoder } from './firmware-in-loop/serial-text';
import {
  createPhysicalForecastPlanner,
  PHYSICAL_FORECAST_REPLAN_SECONDS,
  type PhysicalForecastPlanner,
} from './physical-feed-forward';
import {
  createThermalTwin,
  validateThermalTwinProfile,
  ThermalTwinValidationError,
  type ThermalTwinSnapshot,
} from './physical-twin';
import { SimulationDomainError } from './simulation-error';
import type {
  OvenModelProfile,
  SimulationControllerConfiguration,
  SimulationFirmwareIndicatorSample,
  SimulationFirmwareSerialEvent,
  SimulationMetrics,
  SimulationRequest,
  SimulationResult,
  SimulationSample,
  SimulationSerialCommand,
  SimulationTimewarp,
  TemperatureTargetPoint,
} from './types';

const MAXIMUM_SIMULATION_STEPS = 2_000_000;
const INTEGER_TOLERANCE = 1e-8;
const DESKTOP_CONTROL_INTERVAL_SECONDS = 1;
const FIRMWARE_CONTROL_INTERVAL_SECONDS = 0.1;
const MAXIMUM_FIRMWARE_TRANSCRIPT_EVENTS = 2_000;
const MAXIMUM_FIRMWARE_TRANSCRIPT_BYTES = 256 * 1024;
const MAXIMUM_FIRMWARE_INDICATOR_SAMPLES = 10_000;
const textEncoder = new TextEncoder();

interface WeightedEntry<T> {
  readonly value: T;
  readonly bytes: number;
}

/** A bounded latest-value buffer with amortized O(1) append/drop behavior. */
class BoundedLatestBuffer<T> {
  private entries: WeightedEntry<T>[] = [];
  private head = 0;
  private retainedBytes = 0;
  private droppedEntries = 0;
  private droppedBytes = 0;

  constructor(
    private readonly maximumEntries: number,
    private readonly maximumBytes = Number.POSITIVE_INFINITY,
  ) {}

  push(value: T, bytes = 0): void {
    this.entries.push({ value, bytes });
    this.retainedBytes += bytes;
    while (this.length > this.maximumEntries || this.retainedBytes > this.maximumBytes) {
      const dropped = this.entries[this.head];
      if (dropped === undefined) break;
      this.head += 1;
      this.retainedBytes -= dropped.bytes;
      this.droppedEntries += 1;
      this.droppedBytes += dropped.bytes;
    }
    // Dropped prefixes are released in batches, avoiding Array.shift()'s per-event copying.
    if (this.head >= 256 && this.head * 2 >= this.entries.length) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
  }

  get length(): number {
    return this.entries.length - this.head;
  }

  values(): T[] {
    return this.entries.slice(this.head).map(({ value }) => value);
  }

  truncation(): { readonly droppedEntries: number; readonly droppedBytes: number } {
    return { droppedEntries: this.droppedEntries, droppedBytes: this.droppedBytes };
  }
}

interface ModelTargetPlan {
  readonly trajectoryTargetC: number;
  readonly firmwareTargetC: number;
  readonly targetLeadC: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertFinite(
  value: number,
  path: string,
  code: 'INVALID_MODEL_PROFILE' | 'INVALID_SIMULATION_REQUEST',
): void {
  if (!Number.isFinite(value)) {
    throw new SimulationDomainError(code, `${path} must be finite.`, path);
  }
}

function assertPositive(
  value: number,
  path: string,
  code: 'INVALID_MODEL_PROFILE' | 'INVALID_SIMULATION_REQUEST',
): void {
  assertFinite(value, path, code);
  if (value <= 0) {
    throw new SimulationDomainError(code, `${path} must be greater than zero.`, path);
  }
}

export function validateOvenModelProfile(profile: OvenModelProfile): void {
  const normalized = cloneOvenModelProfile(profile);
  if (normalized.kind !== 'physical-thermal-rc') {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'Only the physical shared-actuator thermal RC twin is supported.',
      'profile.kind',
    );
  }
  try {
    validateThermalTwinProfile(normalized);
  } catch (error) {
    if (error instanceof ThermalTwinValidationError) {
      throw new SimulationDomainError(
        'INVALID_MODEL_PROFILE',
        error.message,
        `profile.${error.path}`,
      );
    }
    throw error;
  }
  assertFinite(
    normalized.minimumTemperatureC,
    'profile.minimumTemperatureC',
    'INVALID_MODEL_PROFILE',
  );
  assertFinite(
    normalized.maximumTemperatureC,
    'profile.maximumTemperatureC',
    'INVALID_MODEL_PROFILE',
  );
  if (normalized.minimumTemperatureC >= normalized.maximumTemperatureC) {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'minimumTemperatureC must be less than maximumTemperatureC.',
      'profile.minimumTemperatureC',
    );
  }
  if (
    normalized.ambientTemperatureC < normalized.minimumTemperatureC ||
    normalized.ambientTemperatureC > normalized.maximumTemperatureC
  ) {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'ambientTemperatureC must be within the model temperature limits.',
      'profile.ambientTemperatureC',
    );
  }
  if (!isIntegerRatio(FIRMWARE_CONTROL_INTERVAL_SECONDS, normalized.solverStepSeconds)) {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'solverStepSeconds must divide the firmware QuickPID 0.1 second sample interval exactly.',
      'profile.solverStepSeconds',
    );
  }
  if (!isIntegerRatio(DESKTOP_CONTROL_INTERVAL_SECONDS, normalized.solverStepSeconds)) {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'solverStepSeconds must divide the desktop one-second command interval exactly.',
      'profile.solverStepSeconds',
    );
  }
}

function isIntegerRatio(numerator: number, denominator: number): boolean {
  const ratio = numerator / denominator;
  return Math.abs(ratio - Math.round(ratio)) < INTEGER_TOLERANCE;
}

function validateTimewarp(timewarp: SimulationTimewarp): void {
  if (![1, 5, 20, 100, 'maximum'].includes(timewarp)) {
    throw new SimulationDomainError(
      'INVALID_SIMULATION_REQUEST',
      'timewarp must be 1, 5, 20, 100, or maximum.',
      'timewarp',
    );
  }
}

export function validateSimulationRequest(request: SimulationRequest): void {
  validateOvenModelProfile(request.profile);
  try {
    validatePidControllerConfiguration(request.controller.pid);
    validateTargetShaperConfiguration(request.controller.modelAssistance);
  } catch (error) {
    if (error instanceof ControlDomainError) {
      throw new SimulationDomainError(
        'INVALID_SIMULATION_REQUEST',
        error.message,
        error.path === undefined ? 'controller' : `controller.${error.path}`,
      );
    }
    throw error;
  }

  const { scenario } = request;
  assertPositive(
    scenario.durationSeconds,
    'scenario.durationSeconds',
    'INVALID_SIMULATION_REQUEST',
  );
  assertPositive(
    scenario.sampleEverySeconds,
    'scenario.sampleEverySeconds',
    'INVALID_SIMULATION_REQUEST',
  );
  if (!isIntegerRatio(scenario.durationSeconds, request.profile.solverStepSeconds)) {
    throw new SimulationDomainError(
      'INVALID_SIMULATION_REQUEST',
      'durationSeconds must be an integer multiple of solverStepSeconds.',
      'scenario.durationSeconds',
    );
  }
  if (!isIntegerRatio(scenario.sampleEverySeconds, request.profile.solverStepSeconds)) {
    throw new SimulationDomainError(
      'INVALID_SIMULATION_REQUEST',
      'sampleEverySeconds must be an integer multiple of solverStepSeconds.',
      'scenario.sampleEverySeconds',
    );
  }
  if (scenario.targets.length === 0 || scenario.targets[0]?.atSeconds !== 0) {
    throw new SimulationDomainError(
      'INVALID_SIMULATION_REQUEST',
      'The target program must contain a first point at zero seconds.',
      'scenario.targets',
    );
  }

  let previousTime = -1;
  scenario.targets.forEach((point, index) => {
    const path = `scenario.targets[${index}]`;
    assertFinite(point.atSeconds, `${path}.atSeconds`, 'INVALID_SIMULATION_REQUEST');
    assertFinite(point.targetC, `${path}.targetC`, 'INVALID_SIMULATION_REQUEST');
    if (point.atSeconds <= previousTime || point.atSeconds > scenario.durationSeconds) {
      throw new SimulationDomainError(
        'INVALID_SIMULATION_REQUEST',
        'Target times must be strictly increasing and within the simulation duration.',
        `${path}.atSeconds`,
      );
    }
    if (
      point.targetC < request.profile.minimumTemperatureC ||
      point.targetC > request.profile.maximumTemperatureC
    ) {
      throw new SimulationDomainError(
        'INVALID_SIMULATION_REQUEST',
        'Target temperature is outside the oven model limits.',
        `${path}.targetC`,
      );
    }
    previousTime = point.atSeconds;
  });

  let previousSerialTime = -1;
  (scenario.serialCommands ?? []).forEach((command, index) => {
    const path = `scenario.serialCommands[${index}]`;
    assertFinite(command.atSeconds, `${path}.atSeconds`, 'INVALID_SIMULATION_REQUEST');
    if (command.atSeconds < previousSerialTime || command.atSeconds > scenario.durationSeconds) {
      throw new SimulationDomainError(
        'INVALID_SIMULATION_REQUEST',
        'Terminal command times must be ordered and within the simulation duration.',
        `${path}.atSeconds`,
      );
    }
    const text = command.command.trim();
    if (
      text.length === 0 ||
      text.length > 4_096 ||
      command.command.includes(String.fromCharCode(0)) ||
      /[\r\n]/.test(command.command)
    ) {
      throw new SimulationDomainError(
        'INVALID_SIMULATION_REQUEST',
        'Each terminal command must be one non-empty line up to 4096 characters.',
        `${path}.command`,
      );
    }
    previousSerialTime = command.atSeconds;
  });

  const initialTemperature = scenario.initialTemperatureC ?? request.profile.ambientTemperatureC;
  assertFinite(initialTemperature, 'scenario.initialTemperatureC', 'INVALID_SIMULATION_REQUEST');
  if (
    initialTemperature < request.profile.minimumTemperatureC ||
    initialTemperature > request.profile.maximumTemperatureC
  ) {
    throw new SimulationDomainError(
      'INVALID_SIMULATION_REQUEST',
      'initialTemperatureC is outside the oven model limits.',
      'scenario.initialTemperatureC',
    );
  }

  const runtime = request.controllerRuntime;
  try {
    validateFirmwareInLoopLoad({
      artifact: runtime.artifact,
      hardware: runtime.hardware,
      initialSensorsC: {
        t1: initialTemperature,
        t2: initialTemperature,
        t3: initialTemperature,
      },
      initialEeprom: runtime.initialEeprom,
    });
  } catch (error) {
    if (error instanceof FirmwareInLoopError) {
      throw new SimulationDomainError(
        'INVALID_SIMULATION_REQUEST',
        error.message,
        error.path === undefined ? 'controllerRuntime' : `controllerRuntime.${error.path}`,
      );
    }
    throw error;
  }

  const steps = Math.round(scenario.durationSeconds / request.profile.solverStepSeconds);
  if (steps > MAXIMUM_SIMULATION_STEPS) {
    throw new SimulationDomainError(
      'SIMULATION_LIMIT_EXCEEDED',
      `The requested run has ${steps} steps; the limit is ${MAXIMUM_SIMULATION_STEPS}.`,
      'scenario.durationSeconds',
    );
  }
  validateTimewarp(request.timewarp ?? 1);
}

function targetAt(points: readonly TemperatureTargetPoint[], timeSeconds: number): number {
  let target = points[0]?.targetC;
  if (target === undefined) {
    throw new SimulationDomainError('INVALID_SIMULATION_REQUEST', 'The target program is empty.');
  }
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined || point.atSeconds > timeSeconds + INTEGER_TOLERANCE) break;
    target = point.targetC;
  }
  return target;
}

function serialCommandsAt(
  commands: readonly SimulationSerialCommand[],
  timeSeconds: number,
  nextIndex: number,
): { readonly commands: readonly string[]; readonly nextIndex: number } {
  const due: string[] = [];
  let index = nextIndex;
  while (index < commands.length) {
    const command = commands[index];
    if (command === undefined || command.atSeconds > timeSeconds + INTEGER_TOLERANCE) break;
    due.push(command.command.trim());
    index += 1;
  }
  return { commands: due, nextIndex: index };
}

function batchSize(timewarp: SimulationTimewarp, totalSteps: number): number {
  return timewarp === 'maximum' ? Math.max(1, Math.min(totalSteps, 10_000)) : timewarp;
}

function controlTemperature(snapshot: ThermalTwinSnapshot): number {
  return (snapshot.temperaturesC.t1 + snapshot.temperaturesC.t2) / 2;
}

function formatFirmwareNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}

function firmwarePidCommand(gains: PidGains): string {
  return `M301 P${formatFirmwareNumber(gains.kp)} I${formatFirmwareNumber(gains.ki)} D${formatFirmwareNumber(gains.kd)}`;
}

function encodeFirmwareCommands(commands: readonly string[]): Uint8Array {
  return textEncoder.encode(`${commands.join('\n')}\n`);
}

function sameGains(left: PidGains, right: PidGains): boolean {
  return left.kp === right.kp && left.ki === right.ki && left.kd === right.kd;
}

function createSample(
  timeSeconds: number,
  requestedTargetC: number,
  plan: ModelTargetPlan,
  snapshot: ThermalTwinSnapshot,
  commanded: number,
  applied: number,
  pidOutput: number,
): SimulationSample {
  const temperatures = snapshot.temperaturesC;
  return {
    timeSeconds,
    requestedTargetC,
    trajectoryTargetC: plan.trajectoryTargetC,
    firmwareTargetC: plan.firmwareTargetC,
    targetLeadC: plan.targetLeadC,
    temperatures: {
      t0C: (temperatures.t1 + temperatures.t2) / 2,
      t1C: temperatures.t1,
      t2C: temperatures.t2,
      t3C: temperatures.t3,
      topZoneC: temperatures.topAir,
      bottomZoneC: temperatures.bottomAir,
      enclosureC: temperatures.enclosure,
    },
    actuator: { commanded, applied, pidOutput },
  };
}

function planTarget(
  planner: PhysicalForecastPlanner,
  twin: ReturnType<typeof createThermalTwin>,
  pid: FirmwareQuickPidState,
  controller: SimulationControllerConfiguration,
  requestedTargetC: number,
): ModelTargetPlan {
  const derived = planner.plan({
    mode: controller.mode,
    source: twin,
    firmwarePidState: pid,
    requestedTargetC,
    stepSeconds: DESKTOP_CONTROL_INTERVAL_SECONDS,
  });
  const firmwareTargetC = truncateFirmwareM104Setpoint(derived.firmwareTargetC);
  return {
    trajectoryTargetC: derived.trajectoryTargetC,
    firmwareTargetC,
    targetLeadC: firmwareTargetC - derived.trajectoryTargetC,
  };
}

/**
 * Runs the physical oven twin and selected Wasm firmware on one deterministic clock.
 * Timewarp changes batching metadata only.
 */
export function simulate(request: SimulationRequest): SimulationResult {
  const normalizedRequest: SimulationRequest = {
    ...request,
    profile: cloneOvenModelProfile(request.profile),
  };
  validateSimulationRequest(normalizedRequest);

  const { profile, scenario, controller } = normalizedRequest;
  const dt = profile.solverStepSeconds;
  const totalSteps = Math.round(scenario.durationSeconds / dt);
  const sampleStepCount = Math.round(scenario.sampleEverySeconds / dt);
  const hostStepCount = Math.round(DESKTOP_CONTROL_INTERVAL_SECONDS / dt);
  const forecastStepCount = Math.round(PHYSICAL_FORECAST_REPLAN_SECONDS / dt);
  const timewarp = normalizedRequest.timewarp ?? 1;
  const stepsPerBatch = batchSize(timewarp, totalSteps);
  const initialTemperatureC = scenario.initialTemperatureC ?? profile.ambientTemperatureC;
  const twin = createThermalTwin({ profile, initialTemperatureC });
  let snapshot = twin.snapshot();
  const initialRequestedTarget = targetAt(scenario.targets, 0);
  let activeGains = interpolatePidGains(controller.pid.schedule, initialRequestedTarget);
  let pidState = createFirmwareQuickPidState({
    measurementC: controlTemperature(snapshot),
    tunings: activeGains,
  });
  const selectedRuntime = normalizedRequest.controllerRuntime;
  const firmwareStartupCommands = ['M502', firmwarePidCommand(activeGains)];
  const firmwareRuntime: FirmwareInLoop = loadFirmwareInLoop({
    artifact: selectedRuntime.artifact,
    hardware: selectedRuntime.hardware,
    initialSensorsC: {
      t1: snapshot.temperaturesC.t1,
      t2: snapshot.temperaturesC.t2,
      t3: snapshot.temperaturesC.t3,
    },
    startupSerial: encodeFirmwareCommands(firmwareStartupCommands),
    initialEeprom: selectedRuntime.initialEeprom,
  });
  const firmwareSerialTranscript = new BoundedLatestBuffer<SimulationFirmwareSerialEvent>(
    MAXIMUM_FIRMWARE_TRANSCRIPT_EVENTS,
    MAXIMUM_FIRMWARE_TRANSCRIPT_BYTES,
  );
  const firmwareIndicatorSamples = new BoundedLatestBuffer<SimulationFirmwareIndicatorSample>(
    MAXIMUM_FIRMWARE_INDICATOR_SAMPLES,
  );
  const firmwareTextDecoder = new FirmwareSerialTextDecoder();
  const recordFirmwareSerial = (event: SimulationFirmwareSerialEvent): void => {
    const byteLength = textEncoder.encode(event.text).byteLength;
    firmwareSerialTranscript.push(event, byteLength);
  };
  const recordFirmwareIndicators = (sample: SimulationFirmwareIndicatorSample): void => {
    firmwareIndicatorSamples.push(sample);
  };
  let firmwareIndicatorIntervalStartSeconds = 0;
  let firmwareIndicatorIntervalDurationSeconds = 0;
  const accumulatedFirmwareIndicators = new Map<
    string,
    FirmwareAdvanceResult['indicators'][string] & { activeSeconds: number }
  >();
  const accumulateFirmwareIndicators = (
    indicators: FirmwareAdvanceResult['indicators'],
    durationSeconds: number,
  ): void => {
    firmwareIndicatorIntervalDurationSeconds += durationSeconds;
    for (const [indicatorId, indicator] of Object.entries(indicators)) {
      const previous = accumulatedFirmwareIndicators.get(indicatorId);
      accumulatedFirmwareIndicators.set(indicatorId, {
        ...indicator,
        activeSeconds:
          (previous?.activeSeconds ?? 0) + clamp(indicator.activeFraction, 0, 1) * durationSeconds,
      });
    }
  };
  const flushFirmwareIndicators = (timeSeconds: number): void => {
    if (firmwareIndicatorIntervalDurationSeconds <= 0) return;
    if (accumulatedFirmwareIndicators.size > 0) {
      recordFirmwareIndicators({
        intervalStartSeconds: firmwareIndicatorIntervalStartSeconds,
        timeSeconds,
        indicators: Object.fromEntries(
          [...accumulatedFirmwareIndicators.entries()].map(
            ([indicatorId, { activeSeconds, ...indicator }]) => [
              indicatorId,
              {
                ...indicator,
                activeFraction: clamp(
                  activeSeconds / firmwareIndicatorIntervalDurationSeconds,
                  0,
                  1,
                ),
              },
            ],
          ),
        ),
      });
    }
    accumulatedFirmwareIndicators.clear();
    firmwareIndicatorIntervalStartSeconds = timeSeconds;
    firmwareIndicatorIntervalDurationSeconds = 0;
  };
  recordFirmwareSerial({
    timeSeconds: 0,
    direction: 'rx',
    text: `${firmwareStartupCommands.join('\n')}\n`,
  });
  let firmwareResetCount = 0;
  let lastFirmwareGains = activeGains;
  let lastFirmwareTargetC: number | null = null;
  try {
    const forecastPlanner = createPhysicalForecastPlanner({
      configuration: controller.modelAssistance,
      initialTargetC: initialTemperatureC,
    });
    let plan: ModelTargetPlan = {
      trajectoryTargetC: initialTemperatureC,
      firmwareTargetC: truncateFirmwareM104Setpoint(initialTemperatureC),
      targetLeadC: 0,
    };
    let lastCommandedActuator = 0;
    let lastAppliedActuator = 0;
    let lastPidOutput = 0;
    let nextTerminalCommandIndex = 0;
    const samples: SimulationSample[] = [];

    let integralAbsoluteError = 0;
    let squaredError = 0;
    let maximumOvershoot = 0;
    let peakTemperature = initialTemperatureC;
    let saturatedSteps = 0;
    let maximumSensorSpread = 0;

    const finalPoint = scenario.targets.at(-1);
    if (finalPoint === undefined) {
      throw new SimulationDomainError('INVALID_SIMULATION_REQUEST', 'The target program is empty.');
    }
    const finalTargetC = finalPoint.targetC;
    const previousFinalTarget =
      scenario.targets.length > 1
        ? (scenario.targets.at(-2)?.targetC ?? initialTemperatureC)
        : initialTemperatureC;
    const riseThreshold = previousFinalTarget + 0.9 * (finalTargetC - previousFinalTarget);
    let riseTimeSeconds: number | null = null;
    let lastOutsideSettlingBand: number | null = null;
    let finalPointInsideSettlingBand = false;
    const settlingToleranceC = Math.max(1, Math.abs(finalTargetC) * 0.02);

    for (let batchStart = 0; batchStart < totalSteps; batchStart += stepsPerBatch) {
      const batchEnd = Math.min(totalSteps, batchStart + stepsPerBatch);
      for (let step = batchStart; step < batchEnd; step += 1) {
        const timeSeconds = step * dt;
        const requestedTargetC = targetAt(scenario.targets, timeSeconds);
        const firmwareCommands: string[] = [];
        if (step % hostStepCount === 0) {
          const scheduledGains = interpolatePidGains(controller.pid.schedule, requestedTargetC);
          activeGains =
            step === 0
              ? scheduledGains
              : advancePidGainTransition(
                  activeGains,
                  scheduledGains,
                  DESKTOP_CONTROL_INTERVAL_SECONDS,
                  controller.pid.gainTransitionSeconds,
                );
          pidState = setFirmwareQuickPidTunings(pidState, activeGains);
          if (
            controller.mode === 'pid' ||
            step % forecastStepCount === 0 ||
            requestedTargetC !== plan.trajectoryTargetC
          ) {
            plan = planTarget(forecastPlanner, twin, pidState, controller, requestedTargetC);
          }
          if (!sameGains(activeGains, lastFirmwareGains)) {
            firmwareCommands.push(firmwarePidCommand(activeGains));
            lastFirmwareGains = activeGains;
          }
          if (lastFirmwareTargetC !== plan.firmwareTargetC) {
            firmwareCommands.push(`M104 S${formatFirmwareNumber(plan.firmwareTargetC)}`);
            lastFirmwareTargetC = plan.firmwareTargetC;
          }
        }

        const scheduled = serialCommandsAt(
          scenario.serialCommands ?? [],
          timeSeconds,
          nextTerminalCommandIndex,
        );
        nextTerminalCommandIndex = scheduled.nextIndex;
        // Terminal input is deliberately sent after supervisory commands. A manual M104 can
        // therefore take effect for this interval, while the next host tick remains observable.
        firmwareCommands.push(...scheduled.commands);

        const pidStep = stepFirmwareQuickPid(pidState, {
          setpointC: plan.firmwareTargetC,
          measurementC: controlTemperature(snapshot),
          elapsedSeconds: step === 0 ? 0 : dt,
        });
        pidState = pidStep.state;
        const serialRx =
          firmwareCommands.length === 0 ? undefined : encodeFirmwareCommands(firmwareCommands);
        if (serialRx !== undefined) {
          recordFirmwareSerial({
            timeSeconds,
            direction: 'rx',
            text: `${firmwareCommands.join('\n')}\n`,
          });
        }
        const firmwareStep = firmwareRuntime.advance({
          elapsedUs: Math.round(dt * 1_000_000),
          sensorsC: {
            t1: snapshot.temperaturesC.t1,
            t2: snapshot.temperaturesC.t2,
            t3: snapshot.temperaturesC.t3,
          },
          serialRx,
        });
        const commandedActuator = firmwareStep.heaterDuty;
        const appliedActuator = firmwareStep.heaterDuty;
        const displayedPidOutput = firmwareStep.heaterDuty * 255;
        accumulateFirmwareIndicators(firmwareStep.indicators, dt);
        firmwareResetCount += firmwareStep.resetCount;
        if (firmwareStep.serialTx.byteLength > 0) {
          const text = firmwareTextDecoder.decode(firmwareStep.serialTx);
          if (text.length > 0) {
            recordFirmwareSerial({
              timeSeconds: timeSeconds + dt,
              direction: 'tx',
              text,
            });
          }
        }
        lastCommandedActuator = commandedActuator;
        lastAppliedActuator = appliedActuator;
        lastPidOutput = displayedPidOutput;

        if (step % sampleStepCount === 0) {
          samples.push(
            createSample(
              timeSeconds,
              requestedTargetC,
              plan,
              snapshot,
              commandedActuator,
              appliedActuator,
              displayedPidOutput,
            ),
          );
        }

        if ((step + 1) % sampleStepCount === 0) {
          flushFirmwareIndicators(timeSeconds + dt);
        }

        snapshot = twin.advance({ durationSeconds: dt, duty: appliedActuator });
        const nextTimeSeconds = (step + 1) * dt;
        const nextRequestedTargetC = targetAt(scenario.targets, nextTimeSeconds);
        const nextMeasurementC = controlTemperature(snapshot);
        const error = nextRequestedTargetC - nextMeasurementC;
        integralAbsoluteError += Math.abs(error) * dt;
        squaredError += error * error;
        maximumOvershoot = Math.max(maximumOvershoot, nextMeasurementC - nextRequestedTargetC);
        peakTemperature = Math.max(peakTemperature, nextMeasurementC);
        maximumSensorSpread = Math.max(
          maximumSensorSpread,
          Math.abs(snapshot.temperaturesC.t1 - snapshot.temperaturesC.t2),
        );
        if (appliedActuator >= 1) saturatedSteps += 1;

        if (nextTimeSeconds + INTEGER_TOLERANCE >= finalPoint.atSeconds) {
          if (
            riseTimeSeconds === null &&
            finalTargetC > previousFinalTarget &&
            nextMeasurementC >= riseThreshold
          ) {
            riseTimeSeconds = nextTimeSeconds - finalPoint.atSeconds;
          }
          finalPointInsideSettlingBand =
            Math.abs(finalTargetC - nextMeasurementC) <= settlingToleranceC;
          if (!finalPointInsideSettlingBand) lastOutsideSettlingBand = nextTimeSeconds;
        }
      }
    }

    flushFirmwareIndicators(scenario.durationSeconds);
    const trailingSerialText = firmwareTextDecoder.finish();
    if (trailingSerialText.length > 0) {
      recordFirmwareSerial({
        timeSeconds: scenario.durationSeconds,
        direction: 'tx',
        text: trailingSerialText,
      });
    }

    const finalRequestedTarget = targetAt(scenario.targets, scenario.durationSeconds);
    samples.push(
      createSample(
        scenario.durationSeconds,
        finalRequestedTarget,
        plan,
        snapshot,
        lastCommandedActuator,
        lastAppliedActuator,
        lastPidOutput,
      ),
    );

    const finalMeasurementC = controlTemperature(snapshot);
    const settlingTimeSeconds = finalPointInsideSettlingBand
      ? Math.max(0, (lastOutsideSettlingBand ?? finalPoint.atSeconds) - finalPoint.atSeconds)
      : null;
    const metrics: SimulationMetrics = {
      integralAbsoluteErrorCSeconds: integralAbsoluteError,
      rootMeanSquareErrorC: Math.sqrt(squaredError / totalSteps),
      maximumOvershootC: Math.max(0, maximumOvershoot),
      peakTemperatureC: peakTemperature,
      finalErrorC: finalTargetC - finalMeasurementC,
      riseTimeSeconds,
      settlingTimeSeconds,
      energyWh: snapshot.energy.electricalInputJ / 3_600,
      actuatorSaturationPercent: (saturatedSteps / totalSteps) * 100,
      maximumControlSensorSpreadC: maximumSensorSpread,
    };

    const result: SimulationResult = {
      samples,
      metrics,
      execution: {
        fixedStepSeconds: dt,
        totalSteps,
        timewarp,
        stepsPerBatch,
        simulatedSecondsPerBatch: stepsPerBatch * dt,
      },
      firmware: {
        buildId: selectedRuntime.artifact.buildId,
        serialTranscript: firmwareSerialTranscript.values(),
        indicatorSamples: firmwareIndicatorSamples.values(),
        resetCount: firmwareResetCount,
        truncation: (() => {
          const transcript = firmwareSerialTranscript.truncation();
          const indicators = firmwareIndicatorSamples.truncation();
          return {
            droppedSerialEvents: transcript.droppedEntries,
            droppedSerialBytes: transcript.droppedBytes,
            droppedIndicatorSamples: indicators.droppedEntries,
          };
        })(),
      },
    };
    return result;
  } finally {
    firmwareRuntime.dispose();
  }
}
