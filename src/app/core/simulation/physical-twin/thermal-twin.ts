import { DEFAULT_THERMAL_TWIN_PROFILE } from './default-profile';
import {
  THERMAL_BODY_IDS,
  ThermalTwinValidationError,
  type AmbientBoundaryConfiguration,
  type LinearHeatLink,
  type RadiationHeatLink,
  type ThermalBodyId,
  type ThermalObserverCorrection,
  type ThermalSensorObservation,
  type ThermalTemperatures,
  type ThermalTwin,
  type ThermalTwinAdvanceCommand,
  type ThermalTwinInitialConditions,
  type ThermalTwinProfile,
  type ThermalTwinSnapshot,
} from './types';

const ABSOLUTE_ZERO_C = -273.15;
const STEFAN_BOLTZMANN_W_PER_M2_K4 = 5.670374419e-8;
const DURATION_GRID_TOLERANCE = 1e-9;

const BODY_INDEX: Readonly<Record<ThermalBodyId, number>> = Object.freeze(
  Object.fromEntries(THERMAL_BODY_IDS.map((body, index) => [body, index])) as Record<
    ThermalBodyId,
    number
  >,
);

interface SolverState {
  stepIndex: number;
  temperaturesC: number[];
  electricalInputJ: number;
  netHeatToAmbientJ: number;
  duty: number;
}

interface StateDerivative {
  temperaturesCPerSecond: number[];
  electricalInputW: number;
  heatToAmbientW: number;
}

interface PreparedProfile {
  readonly publicProfile: ThermalTwinProfile;
  readonly capacitiesJPerK: readonly number[];
  readonly linearLinks: readonly PreparedLinearLink[];
  readonly radiationLinks: readonly PreparedRadiationLink[];
  readonly topHeaterIndex: number;
  readonly bottomHeaterIndex: number;
}

interface PreparedLinearLink {
  readonly a: number;
  readonly b: number;
  readonly conductanceWPerK: number;
}

interface PreparedRadiationLink {
  readonly a: number;
  readonly b: number;
  readonly coefficientWPerK4: number;
}

export function validateThermalTwinProfile(profile: ThermalTwinProfile): void {
  if (profile.version !== 1) {
    fail('must be 1', 'version');
  }
  if (typeof profile.name !== 'string' || profile.name.trim().length === 0) {
    fail('must be a non-empty string', 'name');
  }
  requireObject(profile.geometry, 'geometry');
  validatePositive(profile.geometry.widthM, 'geometry.widthM');
  validatePositive(profile.geometry.depthM, 'geometry.depthM');
  validatePositive(profile.geometry.heightM, 'geometry.heightM');
  validateTemperature(profile.ambientTemperatureC, 'ambientTemperatureC');
  validatePositive(profile.solverStepSeconds, 'solverStepSeconds');

  requireObject(profile.bodies, 'bodies');
  for (const body of THERMAL_BODY_IDS) {
    const configuration = profile.bodies[body];
    if (!configuration || typeof configuration !== 'object') {
      fail('is required', `bodies.${body}`);
    }
    validatePositive(configuration.heatCapacityJPerK, `bodies.${body}.heatCapacityJPerK`);
  }

  requireObject(profile.heaters, 'heaters');
  requireObject(profile.heaters.top, 'heaters.top');
  requireObject(profile.heaters.bottom, 'heaters.bottom');
  if (profile.heaters.top.body !== 'topHeater') {
    fail("must be 'topHeater'", 'heaters.top.body');
  }
  if (profile.heaters.bottom.body !== 'bottomHeater') {
    fail("must be 'bottomHeater'", 'heaters.bottom.body');
  }
  validateNonNegative(profile.heaters.top.ratedPowerW, 'heaters.top.ratedPowerW');
  validateNonNegative(profile.heaters.bottom.ratedPowerW, 'heaters.bottom.ratedPowerW');

  if (!Array.isArray(profile.linearLinks)) {
    fail('must be an array', 'linearLinks');
  }
  profile.linearLinks.forEach(validateLinearLink);
  if (!Array.isArray(profile.radiationLinks)) {
    fail('must be an array', 'radiationLinks');
  }
  profile.radiationLinks.forEach(validateRadiationLink);
  requireObject(profile.ambient, 'ambient');
  validateAmbientBoundary(profile.ambient);
}

export function createThermalTwin(initial: ThermalTwinInitialConditions = {}): ThermalTwin {
  const prepared = prepareProfile(initial.profile ?? DEFAULT_THERMAL_TWIN_PROFILE);
  const fallbackTemperatureC =
    initial.initialTemperatureC ?? prepared.publicProfile.ambientTemperatureC;
  validateTemperature(fallbackTemperatureC, 'initialTemperatureC');

  const temperaturesC = THERMAL_BODY_IDS.map((body) => {
    const temperatureC = initial.initialTemperaturesC?.[body] ?? fallbackTemperatureC;
    validateTemperature(temperatureC, `initialTemperaturesC.${body}`);
    return temperatureC;
  });

  return new ThermalTwinCursor(prepared, {
    stepIndex: 0,
    temperaturesC,
    electricalInputJ: 0,
    netHeatToAmbientJ: 0,
    duty: 0,
  });
}

class ThermalTwinCursor implements ThermalTwin {
  readonly profile: ThermalTwinProfile;
  private initialInternalEnergyJ: number;

  constructor(
    private readonly prepared: PreparedProfile,
    private state: SolverState,
    initialInternalEnergyJ?: number,
  ) {
    this.profile = prepared.publicProfile;
    this.initialInternalEnergyJ =
      initialInternalEnergyJ ?? internalEnergyJ(state.temperaturesC, prepared.capacitiesJPerK);
  }

  snapshot(): ThermalTwinSnapshot {
    const temperaturesC = Object.freeze(
      Object.fromEntries(
        THERMAL_BODY_IDS.map((body) => [body, this.state.temperaturesC[BODY_INDEX[body]]!]),
      ) as Record<ThermalBodyId, number>,
    );
    const currentInternalEnergyJ = internalEnergyJ(
      this.state.temperaturesC,
      this.prepared.capacitiesJPerK,
    );
    const internalEnergyChangeJ = currentInternalEnergyJ - this.initialInternalEnergyJ;
    const balanceResidualJ =
      internalEnergyChangeJ - this.state.electricalInputJ + this.state.netHeatToAmbientJ;

    return Object.freeze({
      timeSeconds: this.state.stepIndex * this.profile.solverStepSeconds,
      duty: this.state.duty,
      temperaturesC: temperaturesC as ThermalTemperatures,
      energy: Object.freeze({
        initialInternalEnergyJ: this.initialInternalEnergyJ,
        currentInternalEnergyJ,
        internalEnergyChangeJ,
        electricalInputJ: this.state.electricalInputJ,
        netHeatToAmbientJ: this.state.netHeatToAmbientJ,
        balanceResidualJ,
      }),
    });
  }

  advance(command: ThermalTwinAdvanceCommand): ThermalTwinSnapshot {
    const stepCount = validateCommand(command, this.profile.solverStepSeconds);
    for (let step = 0; step < stepCount; step += 1) {
      this.integrateOneStep(command.duty);
    }
    if (stepCount > 0) {
      this.state.duty = command.duty;
    }
    return this.snapshot();
  }

  assimilateSensorObservation(observation: ThermalSensorObservation): ThermalObserverCorrection {
    validateTemperature(observation.t1C, 'observation.t1C');
    validateTemperature(observation.t2C, 'observation.t2C');
    validateTemperature(observation.t3C, 'observation.t3C');
    const previousSensorsC = Object.freeze({
      t1C: this.state.temperaturesC[BODY_INDEX.t1]!,
      t2C: this.state.temperaturesC[BODY_INDEX.t2]!,
      t3C: this.state.temperaturesC[BODY_INDEX.t3]!,
    });
    const correctedTemperaturesC = [...this.state.temperaturesC];
    correctedTemperaturesC[BODY_INDEX.t1] = observation.t1C;
    correctedTemperaturesC[BODY_INDEX.t2] = observation.t2C;
    correctedTemperaturesC[BODY_INDEX.t3] = observation.t3C;
    const previousInternalEnergyJ = internalEnergyJ(
      this.state.temperaturesC,
      this.prepared.capacitiesJPerK,
    );
    const correctedInternalEnergyJ = internalEnergyJ(
      correctedTemperaturesC,
      this.prepared.capacitiesJPerK,
    );

    this.state = {
      ...this.state,
      temperaturesC: correctedTemperaturesC,
      electricalInputJ: 0,
      netHeatToAmbientJ: 0,
    };
    this.initialInternalEnergyJ = correctedInternalEnergyJ;

    return Object.freeze({
      previousSensorsC,
      observedSensorsC: Object.freeze({ ...observation }),
      imposedInternalEnergyChangeJ: correctedInternalEnergyJ - previousInternalEnergyJ,
      snapshot: this.snapshot(),
    });
  }

  fork(): ThermalTwin {
    return new ThermalTwinCursor(
      this.prepared,
      {
        ...this.state,
        temperaturesC: [...this.state.temperaturesC],
      },
      this.initialInternalEnergyJ,
    );
  }

  private integrateOneStep(duty: number): void {
    const stepSeconds = this.profile.solverStepSeconds;
    const startTemperatures = this.state.temperaturesC;
    const k1 = derivative(startTemperatures, duty, this.prepared);
    const k2 = derivative(
      addScaledTemperatures(startTemperatures, k1.temperaturesCPerSecond, stepSeconds / 2),
      duty,
      this.prepared,
    );
    const k3 = derivative(
      addScaledTemperatures(startTemperatures, k2.temperaturesCPerSecond, stepSeconds / 2),
      duty,
      this.prepared,
    );
    const k4 = derivative(
      addScaledTemperatures(startTemperatures, k3.temperaturesCPerSecond, stepSeconds),
      duty,
      this.prepared,
    );

    const nextTemperaturesC = startTemperatures.map(
      (temperatureC, index) =>
        temperatureC +
        (stepSeconds / 6) *
          (k1.temperaturesCPerSecond[index]! +
            2 * k2.temperaturesCPerSecond[index]! +
            2 * k3.temperaturesCPerSecond[index]! +
            k4.temperaturesCPerSecond[index]!),
    );
    assertSolverTemperatures(nextTemperaturesC);

    this.state = {
      stepIndex: this.state.stepIndex + 1,
      temperaturesC: nextTemperaturesC,
      electricalInputJ:
        this.state.electricalInputJ +
        rk4Integral(
          stepSeconds,
          k1.electricalInputW,
          k2.electricalInputW,
          k3.electricalInputW,
          k4.electricalInputW,
        ),
      netHeatToAmbientJ:
        this.state.netHeatToAmbientJ +
        rk4Integral(
          stepSeconds,
          k1.heatToAmbientW,
          k2.heatToAmbientW,
          k3.heatToAmbientW,
          k4.heatToAmbientW,
        ),
      duty,
    };
  }
}

function derivative(
  temperaturesC: readonly number[],
  duty: number,
  prepared: PreparedProfile,
): StateDerivative {
  assertSolverTemperatures(temperaturesC);
  const powersW = new Array<number>(THERMAL_BODY_IDS.length).fill(0);
  const topHeaterPowerW = prepared.publicProfile.heaters.top.ratedPowerW * duty;
  const bottomHeaterPowerW = prepared.publicProfile.heaters.bottom.ratedPowerW * duty;
  powersW[prepared.topHeaterIndex] = topHeaterPowerW;
  powersW[prepared.bottomHeaterIndex] = bottomHeaterPowerW;

  for (const link of prepared.linearLinks) {
    const heatFromAToBW = link.conductanceWPerK * (temperaturesC[link.a]! - temperaturesC[link.b]!);
    powersW[link.a] = powersW[link.a]! - heatFromAToBW;
    powersW[link.b] = powersW[link.b]! + heatFromAToBW;
  }

  for (const link of prepared.radiationLinks) {
    const aKelvin = temperaturesC[link.a]! - ABSOLUTE_ZERO_C;
    const bKelvin = temperaturesC[link.b]! - ABSOLUTE_ZERO_C;
    const heatFromAToBW = link.coefficientWPerK4 * (aKelvin ** 4 - bKelvin ** 4);
    powersW[link.a] = powersW[link.a]! - heatFromAToBW;
    powersW[link.b] = powersW[link.b]! + heatFromAToBW;
  }

  const ambient = prepared.publicProfile.ambient;
  const ambientTemperatureC = prepared.publicProfile.ambientTemperatureC;
  const enclosureIndex = BODY_INDEX.enclosure;
  const topAirIndex = BODY_INDEX.topAir;
  const bottomAirIndex = BODY_INDEX.bottomAir;
  const t3Index = BODY_INDEX.t3;
  const enclosureKelvin = temperaturesC[enclosureIndex]! - ABSOLUTE_ZERO_C;
  const ambientKelvin = ambientTemperatureC - ABSOLUTE_ZERO_C;

  const enclosureConductionW =
    ambient.enclosureConductanceWPerK * (temperaturesC[enclosureIndex]! - ambientTemperatureC);
  const enclosureRadiationW =
    STEFAN_BOLTZMANN_W_PER_M2_K4 *
    ambient.enclosureRadiatingAreaM2 *
    ambient.enclosureEmissivity *
    (enclosureKelvin ** 4 - ambientKelvin ** 4);
  const airVolumetricHeatCapacityJPerM3K =
    ambient.airDensityKgPerM3 * ambient.airSpecificHeatJPerKgK;
  const topAirExchangeW =
    ambient.topAirExchangeM3PerSecond *
    airVolumetricHeatCapacityJPerM3K *
    (temperaturesC[topAirIndex]! - ambientTemperatureC);
  const bottomAirExchangeW =
    ambient.bottomAirExchangeM3PerSecond *
    airVolumetricHeatCapacityJPerM3K *
    (temperaturesC[bottomAirIndex]! - ambientTemperatureC);
  const t3AmbientW =
    ambient.t3AmbientConductanceWPerK * (temperaturesC[t3Index]! - ambientTemperatureC);
  const heatToAmbientW =
    enclosureConductionW + enclosureRadiationW + topAirExchangeW + bottomAirExchangeW + t3AmbientW;

  powersW[enclosureIndex] = powersW[enclosureIndex]! - enclosureConductionW - enclosureRadiationW;
  powersW[topAirIndex] = powersW[topAirIndex]! - topAirExchangeW;
  powersW[bottomAirIndex] = powersW[bottomAirIndex]! - bottomAirExchangeW;
  powersW[t3Index] = powersW[t3Index]! - t3AmbientW;

  return {
    temperaturesCPerSecond: powersW.map(
      (powerW, index) => powerW / prepared.capacitiesJPerK[index]!,
    ),
    electricalInputW: topHeaterPowerW + bottomHeaterPowerW,
    heatToAmbientW,
  };
}

function prepareProfile(profile: ThermalTwinProfile): PreparedProfile {
  validateThermalTwinProfile(profile);
  const publicProfile = copyAndFreezeProfile(profile);
  return Object.freeze({
    publicProfile,
    capacitiesJPerK: Object.freeze(
      THERMAL_BODY_IDS.map((body) => publicProfile.bodies[body].heatCapacityJPerK),
    ),
    linearLinks: Object.freeze(
      publicProfile.linearLinks.map((link) =>
        Object.freeze({
          a: BODY_INDEX[link.a],
          b: BODY_INDEX[link.b],
          conductanceWPerK: link.conductanceWPerK,
        }),
      ),
    ),
    radiationLinks: Object.freeze(
      publicProfile.radiationLinks.map((link) =>
        Object.freeze({
          a: BODY_INDEX[link.a],
          b: BODY_INDEX[link.b],
          coefficientWPerK4:
            STEFAN_BOLTZMANN_W_PER_M2_K4 * link.areaM2 * link.emissivity * link.viewFactor,
        }),
      ),
    ),
    topHeaterIndex: BODY_INDEX[publicProfile.heaters.top.body],
    bottomHeaterIndex: BODY_INDEX[publicProfile.heaters.bottom.body],
  });
}

function copyAndFreezeProfile(profile: ThermalTwinProfile): ThermalTwinProfile {
  const bodies = Object.fromEntries(
    THERMAL_BODY_IDS.map((body) => [
      body,
      Object.freeze({ heatCapacityJPerK: profile.bodies[body].heatCapacityJPerK }),
    ]),
  ) as Record<ThermalBodyId, { readonly heatCapacityJPerK: number }>;

  return Object.freeze({
    version: 1,
    name: profile.name,
    geometry: Object.freeze({ ...profile.geometry }),
    ambientTemperatureC: profile.ambientTemperatureC,
    solverStepSeconds: profile.solverStepSeconds,
    bodies: Object.freeze(bodies),
    heaters: Object.freeze({
      top: Object.freeze({ ...profile.heaters.top }),
      bottom: Object.freeze({ ...profile.heaters.bottom }),
    }),
    linearLinks: Object.freeze(profile.linearLinks.map((link) => Object.freeze({ ...link }))),
    radiationLinks: Object.freeze(profile.radiationLinks.map((link) => Object.freeze({ ...link }))),
    ambient: Object.freeze({ ...profile.ambient }),
  });
}

function validateLinearLink(link: LinearHeatLink, index: number): void {
  const path = `linearLinks.${index}`;
  requireObject(link, path);
  validateBodyId(link.a, `${path}.a`);
  validateBodyId(link.b, `${path}.b`);
  if (link.a === link.b) {
    fail('must connect two different bodies', path);
  }
  if (!['conduction', 'convection', 'sensor-contact'].includes(link.mechanism)) {
    fail('must name a supported physical heat-transfer mechanism', `${path}.mechanism`);
  }
  validateNonNegative(link.conductanceWPerK, `${path}.conductanceWPerK`);
}

function validateRadiationLink(link: RadiationHeatLink, index: number): void {
  const path = `radiationLinks.${index}`;
  requireObject(link, path);
  validateBodyId(link.a, `${path}.a`);
  validateBodyId(link.b, `${path}.b`);
  if (link.a === link.b) {
    fail('must connect two different bodies', path);
  }
  validateNonNegative(link.areaM2, `${path}.areaM2`);
  validateUnitInterval(link.emissivity, `${path}.emissivity`);
  validateUnitInterval(link.viewFactor, `${path}.viewFactor`);
}

function validateAmbientBoundary(ambient: AmbientBoundaryConfiguration): void {
  validateNonNegative(ambient.enclosureConductanceWPerK, 'ambient.enclosureConductanceWPerK');
  validateNonNegative(ambient.enclosureRadiatingAreaM2, 'ambient.enclosureRadiatingAreaM2');
  validateUnitInterval(ambient.enclosureEmissivity, 'ambient.enclosureEmissivity');
  validateNonNegative(ambient.topAirExchangeM3PerSecond, 'ambient.topAirExchangeM3PerSecond');
  validateNonNegative(ambient.bottomAirExchangeM3PerSecond, 'ambient.bottomAirExchangeM3PerSecond');
  validateNonNegative(ambient.t3AmbientConductanceWPerK, 'ambient.t3AmbientConductanceWPerK');
  validatePositive(ambient.airDensityKgPerM3, 'ambient.airDensityKgPerM3');
  validatePositive(ambient.airSpecificHeatJPerKgK, 'ambient.airSpecificHeatJPerKgK');
}

function validateCommand(command: ThermalTwinAdvanceCommand, stepSeconds: number): number {
  validateNonNegative(command.durationSeconds, 'command.durationSeconds');
  validateUnitInterval(command.duty, 'command.duty');
  const rawStepCount = command.durationSeconds / stepSeconds;
  const stepCount = Math.round(rawStepCount);
  if (
    Math.abs(rawStepCount - stepCount) >
    DURATION_GRID_TOLERANCE * Math.max(1, Math.abs(rawStepCount))
  ) {
    fail(
      `must be an integer multiple of fixed solverStepSeconds (${stepSeconds})`,
      'command.durationSeconds',
    );
  }
  return stepCount;
}

function validateBodyId(value: unknown, path: string): asserts value is ThermalBodyId {
  if (typeof value !== 'string' || !THERMAL_BODY_IDS.includes(value as ThermalBodyId)) {
    fail(`must be one of ${THERMAL_BODY_IDS.join(', ')}`, path);
  }
}

function requireObject(value: unknown, path: string): asserts value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('must be an object', path);
  }
}

function validateTemperature(value: number, path: string): void {
  validateFinite(value, path);
  if (value <= ABSOLUTE_ZERO_C) {
    fail(`must be above absolute zero (${ABSOLUTE_ZERO_C} C)`, path);
  }
}

function validatePositive(value: number, path: string): void {
  validateFinite(value, path);
  if (value <= 0) {
    fail('must be greater than zero', path);
  }
}

function validateNonNegative(value: number, path: string): void {
  validateFinite(value, path);
  if (value < 0) {
    fail('must be zero or greater', path);
  }
}

function validateUnitInterval(value: number, path: string): void {
  validateFinite(value, path);
  if (value < 0 || value > 1) {
    fail('must be in the closed interval 0..1', path);
  }
}

function validateFinite(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    fail('must be finite', path);
  }
}

function assertSolverTemperatures(temperaturesC: readonly number[]): void {
  temperaturesC.forEach((temperatureC, index) => {
    const body = THERMAL_BODY_IDS[index]!;
    if (!Number.isFinite(temperatureC)) {
      fail('solver produced a non-finite temperature; reduce solverStepSeconds', `state.${body}`);
    }
    if (temperatureC <= ABSOLUTE_ZERO_C) {
      fail(
        'solver crossed absolute zero; reduce solverStepSeconds or correct the profile',
        `state.${body}`,
      );
    }
  });
}

function addScaledTemperatures(
  temperaturesC: readonly number[],
  derivativeCPerSecond: readonly number[],
  scaleSeconds: number,
): number[] {
  return temperaturesC.map(
    (temperatureC, index) => temperatureC + derivativeCPerSecond[index]! * scaleSeconds,
  );
}

function internalEnergyJ(
  temperaturesC: readonly number[],
  capacitiesJPerK: readonly number[],
): number {
  return temperaturesC.reduce(
    (energyJ, temperatureC, index) => energyJ + temperatureC * capacitiesJPerK[index]!,
    0,
  );
}

function rk4Integral(stepSeconds: number, k1: number, k2: number, k3: number, k4: number): number {
  return (stepSeconds / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
}

function fail(message: string, path: string): never {
  throw new ThermalTwinValidationError(message, path);
}
