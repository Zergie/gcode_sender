import {
  ControlDomainError,
  createPidControllerState,
  createTargetShaperState,
  stepPidController,
  stepTargetShaper,
  validatePidControllerConfiguration,
  validateTargetShaperConfiguration,
} from '../control';
import { cloneOvenModelProfile } from './default-profile';
import { SeededRandom } from './seeded-random';
import { SimulationDomainError } from './simulation-error';
import type {
  OvenModelProfile,
  SimulationMetrics,
  SimulationRequest,
  SimulationResult,
  SimulationSample,
  SimulationTimewarp,
  TemperatureTargetPoint,
} from './types';

const MAXIMUM_SIMULATION_STEPS = 2_000_000;
const DEFAULT_SEED = 0x5eed1234;
const INTEGER_TOLERANCE = 1e-8;

interface PlantState {
  readonly topZoneC: number;
  readonly bottomZoneC: number;
  readonly enclosureC: number;
  readonly topHeaterFraction: number;
  readonly bottomHeaterFraction: number;
}

interface SensorState {
  readonly filteredT1C: number;
  readonly filteredT2C: number;
  readonly filteredT3C: number;
  readonly t1C: number;
  readonly t2C: number;
  readonly t3C: number;
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

function assertNonNegative(value: number, path: string): void {
  assertFinite(value, path, 'INVALID_MODEL_PROFILE');
  if (value < 0) {
    throw new SimulationDomainError('INVALID_MODEL_PROFILE', `${path} must be non-negative.`, path);
  }
}

export function validateOvenModelProfile(profile: OvenModelProfile): void {
  profile = cloneOvenModelProfile(profile);
  if (profile.version !== 1 || profile.kind !== 'dual-zone-shared-actuator') {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'Only version 1 dual-zone shared-actuator oven profiles are supported.',
      'profile.kind',
    );
  }
  if (profile.name.trim().length === 0) {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'The oven profile name must not be empty.',
      'profile.name',
    );
  }

  assertFinite(profile.ambientTemperatureC, 'profile.ambientTemperatureC', 'INVALID_MODEL_PROFILE');
  assertPositive(profile.topHeater.watts, 'profile.topHeater.watts', 'INVALID_MODEL_PROFILE');
  assertPositive(profile.bottomHeater.watts, 'profile.bottomHeater.watts', 'INVALID_MODEL_PROFILE');
  assertNonNegative(profile.topHeater.responseTimeSeconds, 'profile.topHeater.responseTimeSeconds');
  assertNonNegative(
    profile.bottomHeater.responseTimeSeconds,
    'profile.bottomHeater.responseTimeSeconds',
  );
  for (const [path, efficiency] of [
    ['profile.topHeater.efficiency', profile.topHeater.efficiency],
    ['profile.bottomHeater.efficiency', profile.bottomHeater.efficiency],
  ] as const) {
    assertPositive(efficiency, path, 'INVALID_MODEL_PROFILE');
    if (efficiency > 1) {
      throw new SimulationDomainError(
        'INVALID_MODEL_PROFILE',
        `${path} must not exceed one.`,
        path,
      );
    }
  }

  const thermalMasses: ReadonlyArray<readonly [string, number]> = [
    ['profile.thermal.topZoneThermalMassJPerC', profile.thermal.topZoneThermalMassJPerC],
    ['profile.thermal.bottomZoneThermalMassJPerC', profile.thermal.bottomZoneThermalMassJPerC],
    ['profile.thermal.enclosureThermalMassJPerC', profile.thermal.enclosureThermalMassJPerC],
  ];
  for (const [path, value] of thermalMasses) {
    assertPositive(value, path, 'INVALID_MODEL_PROFILE');
  }

  const conductances: ReadonlyArray<readonly [string, number]> = [
    ['profile.thermal.topZoneHeatLossWPerC', profile.thermal.topZoneHeatLossWPerC],
    ['profile.thermal.bottomZoneHeatLossWPerC', profile.thermal.bottomZoneHeatLossWPerC],
    ['profile.thermal.enclosureHeatLossWPerC', profile.thermal.enclosureHeatLossWPerC],
    ['profile.thermal.zoneCouplingWPerC', profile.thermal.zoneCouplingWPerC],
    ['profile.thermal.topToEnclosureCouplingWPerC', profile.thermal.topToEnclosureCouplingWPerC],
    [
      'profile.thermal.bottomToEnclosureCouplingWPerC',
      profile.thermal.bottomToEnclosureCouplingWPerC,
    ],
  ];
  for (const [path, value] of conductances) {
    assertNonNegative(value, path);
  }

  assertNonNegative(profile.actuationDeadTimeSeconds, 'profile.actuationDeadTimeSeconds');
  assertNonNegative(profile.sensors.t1LagSeconds, 'profile.sensors.t1LagSeconds');
  assertNonNegative(profile.sensors.t2LagSeconds, 'profile.sensors.t2LagSeconds');
  assertNonNegative(profile.sensors.t3LagSeconds, 'profile.sensors.t3LagSeconds');
  assertNonNegative(
    profile.sensors.noiseStandardDeviationC,
    'profile.sensors.noiseStandardDeviationC',
  );
  assertPositive(profile.solverStepSeconds, 'profile.solverStepSeconds', 'INVALID_MODEL_PROFILE');
  if (profile.solverStepSeconds > 5) {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'solverStepSeconds must not exceed 5 seconds.',
      'profile.solverStepSeconds',
    );
  }
  assertFinite(profile.minimumTemperatureC, 'profile.minimumTemperatureC', 'INVALID_MODEL_PROFILE');
  assertFinite(profile.maximumTemperatureC, 'profile.maximumTemperatureC', 'INVALID_MODEL_PROFILE');
  if (profile.minimumTemperatureC >= profile.maximumTemperatureC) {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'minimumTemperatureC must be less than maximumTemperatureC.',
      'profile.minimumTemperatureC',
    );
  }
  if (
    profile.ambientTemperatureC < profile.minimumTemperatureC ||
    profile.ambientTemperatureC > profile.maximumTemperatureC
  ) {
    throw new SimulationDomainError(
      'INVALID_MODEL_PROFILE',
      'ambientTemperatureC must be within the model temperature limits.',
      'profile.ambientTemperatureC',
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

  const steps = Math.round(scenario.durationSeconds / request.profile.solverStepSeconds);
  if (steps > MAXIMUM_SIMULATION_STEPS) {
    throw new SimulationDomainError(
      'SIMULATION_LIMIT_EXCEEDED',
      `The requested run has ${steps} steps; the limit is ${MAXIMUM_SIMULATION_STEPS}.`,
      'scenario.durationSeconds',
    );
  }
  if (
    request.seed !== undefined &&
    (!Number.isInteger(request.seed) || !Number.isFinite(request.seed))
  ) {
    throw new SimulationDomainError(
      'INVALID_SIMULATION_REQUEST',
      'seed must be a finite integer.',
      'seed',
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
    if (point === undefined || point.atSeconds > timeSeconds + INTEGER_TOLERANCE) {
      break;
    }
    target = point.targetC;
  }
  return target;
}

function updatePlant(
  profile: OvenModelProfile,
  state: PlantState,
  appliedActuator: number,
): PlantState {
  const { thermal, ambientTemperatureC: ambient, solverStepSeconds: dt } = profile;
  const topHeaterFraction = lagged(
    state.topHeaterFraction,
    appliedActuator,
    dt,
    profile.topHeater.responseTimeSeconds,
  );
  const bottomHeaterFraction = lagged(
    state.bottomHeaterFraction,
    appliedActuator,
    dt,
    profile.bottomHeater.responseTimeSeconds,
  );
  const zoneTransfer = thermal.zoneCouplingWPerC * (state.bottomZoneC - state.topZoneC);
  const topEnclosureTransfer =
    thermal.topToEnclosureCouplingWPerC * (state.enclosureC - state.topZoneC);
  const bottomEnclosureTransfer =
    thermal.bottomToEnclosureCouplingWPerC * (state.enclosureC - state.bottomZoneC);
  const topHeaterPower = topHeaterFraction * profile.topHeater.watts * profile.topHeater.efficiency;
  const bottomHeaterPower =
    bottomHeaterFraction * profile.bottomHeater.watts * profile.bottomHeater.efficiency;

  const topPower =
    topHeaterPower +
    thermal.topZoneHeatLossWPerC * (ambient - state.topZoneC) +
    zoneTransfer +
    topEnclosureTransfer;
  const bottomPower =
    bottomHeaterPower +
    thermal.bottomZoneHeatLossWPerC * (ambient - state.bottomZoneC) -
    zoneTransfer +
    bottomEnclosureTransfer;
  const enclosurePower =
    thermal.enclosureHeatLossWPerC * (ambient - state.enclosureC) -
    topEnclosureTransfer -
    bottomEnclosureTransfer;

  return {
    topZoneC: clamp(
      state.topZoneC + (topPower / thermal.topZoneThermalMassJPerC) * dt,
      profile.minimumTemperatureC,
      profile.maximumTemperatureC,
    ),
    bottomZoneC: clamp(
      state.bottomZoneC + (bottomPower / thermal.bottomZoneThermalMassJPerC) * dt,
      profile.minimumTemperatureC,
      profile.maximumTemperatureC,
    ),
    enclosureC: clamp(
      state.enclosureC + (enclosurePower / thermal.enclosureThermalMassJPerC) * dt,
      profile.minimumTemperatureC,
      profile.maximumTemperatureC,
    ),
    topHeaterFraction,
    bottomHeaterFraction,
  };
}

function lagged(
  previous: number,
  physical: number,
  stepSeconds: number,
  lagSeconds: number,
): number {
  if (lagSeconds === 0) {
    return physical;
  }
  const blend = 1 - Math.exp(-stepSeconds / lagSeconds);
  return previous + blend * (physical - previous);
}

function updateSensors(
  profile: OvenModelProfile,
  state: SensorState,
  plant: PlantState,
  random: SeededRandom,
): SensorState {
  const { sensors, solverStepSeconds } = profile;
  const filteredT1C = lagged(
    state.filteredT1C,
    plant.topZoneC,
    solverStepSeconds,
    sensors.t1LagSeconds,
  );
  const filteredT2C = lagged(
    state.filteredT2C,
    plant.bottomZoneC,
    solverStepSeconds,
    sensors.t2LagSeconds,
  );
  const filteredT3C = lagged(
    state.filteredT3C,
    plant.enclosureC,
    solverStepSeconds,
    sensors.t3LagSeconds,
  );
  const noise = sensors.noiseStandardDeviationC;
  return {
    filteredT1C,
    filteredT2C,
    filteredT3C,
    t1C: clamp(
      filteredT1C + random.gaussian() * noise,
      profile.minimumTemperatureC,
      profile.maximumTemperatureC,
    ),
    t2C: clamp(
      filteredT2C + random.gaussian() * noise,
      profile.minimumTemperatureC,
      profile.maximumTemperatureC,
    ),
    t3C: clamp(
      filteredT3C + random.gaussian() * noise,
      profile.minimumTemperatureC,
      profile.maximumTemperatureC,
    ),
  };
}

function delayedActuator(
  history: readonly number[],
  delaySeconds: number,
  stepSeconds: number,
): number {
  const delaySteps = delaySeconds / stepSeconds;
  const recentIndex = history.length - 1;
  const wholeSteps = Math.floor(delaySteps);
  const fraction = delaySteps - wholeSteps;
  const newer = history[recentIndex - wholeSteps] ?? 0;
  const older = history[recentIndex - wholeSteps - 1] ?? 0;
  return newer * (1 - fraction) + older * fraction;
}

function batchSize(timewarp: SimulationTimewarp, totalSteps: number): number {
  return timewarp === 'maximum' ? Math.max(1, Math.min(totalSteps, 10_000)) : timewarp;
}

function createSample(
  timeSeconds: number,
  requestedTargetC: number,
  trajectoryTargetC: number,
  firmwareTargetC: number,
  targetLeadC: number,
  plant: PlantState,
  sensors: SensorState,
  commanded: number,
  applied: number,
  pidOutput: number,
  gains: SimulationSample['pid']['gains'],
  terms: SimulationSample['pid']['terms'],
): SimulationSample {
  return {
    timeSeconds,
    requestedTargetC,
    trajectoryTargetC,
    firmwareTargetC,
    targetLeadC,
    temperatures: {
      t0C: (sensors.t1C + sensors.t2C) / 2,
      t1C: sensors.t1C,
      t2C: sensors.t2C,
      t3C: sensors.t3C,
      topZoneC: plant.topZoneC,
      bottomZoneC: plant.bottomZoneC,
      enclosureC: plant.enclosureC,
    },
    actuator: { commanded, applied, pidOutput },
    pid: { gains, terms },
  };
}

/**
 * Runs a deterministic, fixed-step dual-zone oven simulation. Inputs are never
 * mutated; timewarp only determines internal batch size and result metadata.
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
  const timewarp = normalizedRequest.timewarp ?? 1;
  const stepsPerBatch = batchSize(timewarp, totalSteps);
  const seed = (normalizedRequest.seed ?? DEFAULT_SEED) >>> 0;
  const random = new SeededRandom(seed);
  const initialTemperatureC = scenario.initialTemperatureC ?? profile.ambientTemperatureC;

  let plant: PlantState = {
    topZoneC: initialTemperatureC,
    bottomZoneC: initialTemperatureC,
    enclosureC: initialTemperatureC,
    topHeaterFraction: 0,
    bottomHeaterFraction: 0,
  };
  let sensors: SensorState = {
    filteredT1C: initialTemperatureC,
    filteredT2C: initialTemperatureC,
    filteredT3C: initialTemperatureC,
    t1C: initialTemperatureC,
    t2C: initialTemperatureC,
    t3C: initialTemperatureC,
  };
  let targetShaperState = createTargetShaperState(initialTemperatureC);
  const initialRequestedTarget = targetAt(scenario.targets, 0);
  let pidState = createPidControllerState(
    controller.pid,
    initialRequestedTarget,
    initialTemperatureC,
  );
  let lastTrajectoryTargetC = initialTemperatureC;
  let lastFirmwareTargetC = initialTemperatureC;
  let lastTargetLeadC = 0;
  let lastCommandedActuator = 0;
  let lastAppliedActuator = 0;
  let lastPidOutput = 0;
  let lastGains = pidState.activeGains;
  let lastTerms = { proportional: 0, integral: 0, derivative: 0 };
  const actuatorHistory: number[] = [];
  const samples: SimulationSample[] = [];

  let integralAbsoluteError = 0;
  let squaredError = 0;
  let maximumOvershoot = 0;
  let peakTemperature = initialTemperatureC;
  let energyWh = 0;
  let saturatedSteps = 0;
  let maximumSensorSpread = 0;

  const finalPoint = scenario.targets[scenario.targets.length - 1];
  if (finalPoint === undefined) {
    throw new SimulationDomainError('INVALID_SIMULATION_REQUEST', 'The target program is empty.');
  }
  const finalTargetC = finalPoint.targetC;
  const previousFinalTarget =
    scenario.targets.length > 1
      ? (scenario.targets[scenario.targets.length - 2]?.targetC ?? initialTemperatureC)
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
      const targetStep = stepTargetShaper(
        controller.mode,
        controller.modelAssistance,
        targetShaperState,
        requestedTargetC,
        dt,
      );
      targetShaperState = targetStep.state;
      const measurementC = (sensors.t1C + sensors.t2C) / 2;
      const pidStep = stepPidController(controller.pid, pidState, {
        setpointC: targetStep.firmwareTargetC,
        measurementC,
        stepSeconds: dt,
      });
      pidState = pidStep.state;
      const outputSpan = controller.pid.outputMaximum - controller.pid.outputMinimum;
      const commandedActuator = clamp(
        (pidStep.output - controller.pid.outputMinimum) / outputSpan,
        0,
        1,
      );
      actuatorHistory.push(commandedActuator);
      const appliedActuator = delayedActuator(
        actuatorHistory,
        profile.actuationDeadTimeSeconds,
        dt,
      );

      lastTrajectoryTargetC = targetStep.trajectoryTargetC;
      lastFirmwareTargetC = targetStep.firmwareTargetC;
      lastTargetLeadC = targetStep.targetLeadC;
      lastCommandedActuator = commandedActuator;
      lastAppliedActuator = appliedActuator;
      lastPidOutput = pidStep.output;
      lastGains = pidStep.gains;
      lastTerms = pidStep.terms;

      if (step % sampleStepCount === 0) {
        samples.push(
          createSample(
            timeSeconds,
            requestedTargetC,
            targetStep.trajectoryTargetC,
            targetStep.firmwareTargetC,
            targetStep.targetLeadC,
            plant,
            sensors,
            commandedActuator,
            appliedActuator,
            pidStep.output,
            pidStep.gains,
            pidStep.terms,
          ),
        );
      }

      plant = updatePlant(profile, plant, appliedActuator);
      sensors = updateSensors(profile, sensors, plant, random);

      const nextTimeSeconds = (step + 1) * dt;
      const nextRequestedTargetC = targetAt(scenario.targets, nextTimeSeconds);
      const nextMeasurementC = (sensors.t1C + sensors.t2C) / 2;
      const error = nextRequestedTargetC - nextMeasurementC;
      integralAbsoluteError += Math.abs(error) * dt;
      squaredError += error * error;
      maximumOvershoot = Math.max(maximumOvershoot, nextMeasurementC - nextRequestedTargetC);
      peakTemperature = Math.max(peakTemperature, nextMeasurementC);
      maximumSensorSpread = Math.max(maximumSensorSpread, Math.abs(sensors.t1C - sensors.t2C));
      energyWh +=
        (appliedActuator *
          (profile.topHeater.watts * profile.topHeater.efficiency +
            profile.bottomHeater.watts * profile.bottomHeater.efficiency) *
          dt) /
        3_600;
      if (commandedActuator >= 1 - 1e-9) {
        saturatedSteps += 1;
      }

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
        if (!finalPointInsideSettlingBand) {
          lastOutsideSettlingBand = nextTimeSeconds;
        }
      }
    }
  }

  const finalRequestedTarget = targetAt(scenario.targets, scenario.durationSeconds);
  samples.push(
    createSample(
      scenario.durationSeconds,
      finalRequestedTarget,
      lastTrajectoryTargetC,
      lastFirmwareTargetC,
      lastTargetLeadC,
      plant,
      sensors,
      lastCommandedActuator,
      lastAppliedActuator,
      lastPidOutput,
      lastGains,
      lastTerms,
    ),
  );

  const finalMeasurementC = (sensors.t1C + sensors.t2C) / 2;
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
    energyWh,
    actuatorSaturationPercent: (saturatedSteps / totalSteps) * 100,
    maximumControlSensorSpreadC: maximumSensorSpread,
  };

  return {
    samples,
    metrics,
    execution: {
      fixedStepSeconds: dt,
      totalSteps,
      seed,
      timewarp,
      stepsPerBatch,
      simulatedSecondsPerBatch: stepsPerBatch * dt,
    },
  };
}
