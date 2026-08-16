import type {
  V1ReferenceDutyPoint,
  V1ReferenceResult,
  V1ReferenceSample,
  V1ReferenceScenario,
} from './types';

/** Commit containing the legacy dummy-MCU plant copied by this harness. */
export const V1_REFERENCE_COMMIT = '56e7583';

/**
 * Constants copied from dummy-mcu/simulation.js at {@link V1_REFERENCE_COMMIT}.
 * Keep these values literal: changing them would redefine the historical
 * reference rather than improve a production digital twin.
 */
export const V1_REFERENCE_CONSTANTS = {
  fixedStepSeconds: 0.1,
  cellSizeMillimeters: 5,
  chamberMillimeters: { width: 80, depth: 220, height: 60 },
  ambientC: 22,
  ambientHeatLoss: 0.8,
  convectionRate: 0.05,
  heater: {
    voltage: 230,
    amperage: 8,
    efficiency: 0.98,
    maximumCellC: 1_200,
  },
  air: {
    specificHeatJPerKilogramK: 1_005,
    densityKilogramsPerCubicMeter: 1.2,
  },
} as const;

const GRID_X = 8 + Math.floor(80 / 5);
const GRID_Y = 8 + Math.floor(220 / 5);
const GRID_Z = 8 + Math.floor(60 / 5);
const GRID_CELL_COUNT = GRID_X * GRID_Y * GRID_Z;
const CELL_SIZE_METERS = V1_REFERENCE_CONSTANTS.cellSizeMillimeters / 1_000;
const CELL_SIZE_SQUARED_METERS = CELL_SIZE_METERS ** 2;
const MATERIAL_AMBIENT = 1;
const MATERIAL_GAS = 2;

interface CellDefinition {
  readonly index: number;
  readonly alpha: number;
  readonly material: number;
}

function gridIndex(x: number, y: number, z: number): number {
  return (x * GRID_Y + y) * GRID_Z + z;
}

function legacyMaterial(x: number, y: number, z: number): { alpha: number; material: number } {
  const dx = V1_REFERENCE_CONSTANTS.cellSizeMillimeters;
  const alphaAir = 2.2e-5;
  const alphaDoubleGlassed = 1e-7 * (dx / 20);
  const alphaGlassFiber = 5e-8 * (dx / 15);
  const alphaSteel = 4.05e-6 * (dx / 0.5);

  // This ordering is the original switch(true) ordering. Intersections inherit
  // the first matching material, even where that is not physically meaningful.
  if (
    x === 0 ||
    y === 0 ||
    z === 0 ||
    x === GRID_X - 1 ||
    y === GRID_Y - 1 ||
    z === GRID_Z - 1 ||
    x === 1 ||
    y === 1 ||
    z === 1 ||
    x === GRID_X - 2 ||
    y === GRID_Y - 2 ||
    z === GRID_Z - 2
  ) {
    return { alpha: alphaAir, material: MATERIAL_AMBIENT };
  }
  if (x === 2 || y === 2 || z === 2 || y === GRID_Y - 3 || z === GRID_Z - 3) {
    return { alpha: alphaGlassFiber, material: 0 };
  }
  if (x === GRID_X - 4) {
    return { alpha: alphaDoubleGlassed, material: 0 };
  }
  if (x === 3 || z === 3 || z === GRID_Z - 4 || y === 3 || y === GRID_Y - 4) {
    return { alpha: alphaSteel, material: 0 };
  }
  return { alpha: alphaAir, material: MATERIAL_GAS };
}

function createInteriorCells(): readonly CellDefinition[] {
  const cells: CellDefinition[] = [];
  for (let x = 1; x < GRID_X - 1; x += 1) {
    for (let y = 1; y < GRID_Y - 1; y += 1) {
      for (let z = 1; z < GRID_Z - 1; z += 1) {
        const definition = legacyMaterial(x, y, z);
        cells.push({ index: gridIndex(x, y, z), ...definition });
      }
    }
  }
  return cells;
}

function createHeaterCells(): readonly number[] {
  const cells: number[] = [];
  const start = 2;
  const end = GRID_Y - 3;
  const center = Math.floor(GRID_X / 2);
  for (const x of [center]) {
    for (let y = start; y < end; y += 1) {
      for (const z of [3, GRID_Z - 4]) {
        cells.push(gridIndex(x, y, z));
      }
    }
  }
  return cells;
}

const INTERIOR_CELLS = createInteriorCells();
const HEATER_CELLS = createHeaterCells();
// The legacy sensor coordinates were converted to cells without the grid's
// four-cell shell offset. Preserve that positional error for comparison.
const SENSOR_INDEX = gridIndex(Math.floor(40 / 5), Math.floor(110 / 5), Math.floor(30 / 5));

/** Legacy nonlinear PWM-to-power function, including its >100% full-duty gain. */
export function v1ReferenceActuatorGain(dutyFraction: number): number {
  return Math.max(0, Math.sin(dutyFraction) + dutyFraction / 2 - 0.25);
}

/**
 * Literal, deterministic execution of the old v1 3-D update loop.
 *
 * Float64 flat arrays replace nested arrays only as a storage optimization.
 * Cell traversal, arithmetic, write ordering, convection side effects, heater
 * cap, and the legacy air-mass heater calculation remain unchanged. Noise and
 * wall-clock timers are deliberately omitted so the result can be a fixture.
 */
export class V1ReferencePlant {
  private readonly temperatures = new Float64Array(GRID_CELL_COUNT);
  private readonly previousTemperatures = new Float64Array(GRID_CELL_COUNT);

  constructor() {
    this.temperatures.fill(V1_REFERENCE_CONSTANTS.ambientC);
    this.previousTemperatures.fill(V1_REFERENCE_CONSTANTS.ambientC);
  }

  get sensorC(): number {
    return this.temperatures[SENSOR_INDEX] ?? V1_REFERENCE_CONSTANTS.ambientC;
  }

  step(dutyFraction: number): number {
    if (!Number.isFinite(dutyFraction) || dutyFraction < 0 || dutyFraction > 1) {
      throw new RangeError('v1 reference duty must be between 0 and 1');
    }

    this.applyLegacyHeater(dutyFraction);
    this.updateLegacyTemperature();
    return this.sensorC;
  }

  private applyLegacyHeater(dutyFraction: number): void {
    const constants = V1_REFERENCE_CONSTANTS;
    const powerWatts =
      constants.heater.voltage * constants.heater.amperage * v1ReferenceActuatorGain(dutyFraction);
    const energyTotalJoules = powerWatts * constants.heater.efficiency * constants.fixedStepSeconds;
    const cellVolumeCubicMeters = CELL_SIZE_METERS ** 3;
    const cellMassKilograms = constants.air.densityKilogramsPerCubicMeter * cellVolumeCubicMeters;
    const energyPerCellJoules = energyTotalJoules / HEATER_CELLS.length;
    const deltaC =
      energyPerCellJoules / (cellMassKilograms * constants.air.specificHeatJPerKilogramK);

    for (const index of HEATER_CELLS) {
      this.temperatures[index] = Math.min(
        (this.temperatures[index] ?? constants.ambientC) + deltaC,
        constants.heater.maximumCellC,
      );
    }
  }

  private updateLegacyTemperature(): void {
    const constants = V1_REFERENCE_CONSTANTS;
    this.previousTemperatures.set(this.temperatures);

    for (const cell of INTERIOR_CELLS) {
      const index = cell.index;
      const temperature = this.previousTemperatures[index] ?? constants.ambientC;
      const laplacian =
        ((this.previousTemperatures[index + GRID_Y * GRID_Z] ?? constants.ambientC) +
          (this.previousTemperatures[index - GRID_Y * GRID_Z] ?? constants.ambientC) +
          (this.previousTemperatures[index + GRID_Z] ?? constants.ambientC) +
          (this.previousTemperatures[index - GRID_Z] ?? constants.ambientC) +
          (this.previousTemperatures[index + 1] ?? constants.ambientC) +
          (this.previousTemperatures[index - 1] ?? constants.ambientC) -
          6 * temperature) /
        CELL_SIZE_SQUARED_METERS;

      this.temperatures[index] = temperature + cell.alpha * constants.fixedStepSeconds * laplacian;

      if (cell.material === MATERIAL_AMBIENT) {
        const deltaC = (this.temperatures[index] ?? constants.ambientC) - constants.ambientC;
        this.temperatures[index] =
          (this.temperatures[index] ?? constants.ambientC) - deltaC * constants.ambientHeatLoss;
      } else if (cell.material === MATERIAL_GAS) {
        const aboveC = this.previousTemperatures[index + 1] ?? constants.ambientC;
        if (temperature > aboveC) {
          const deltaC =
            constants.convectionRate * constants.fixedStepSeconds * (temperature - aboveC);
          this.temperatures[index] = (this.temperatures[index] ?? constants.ambientC) - deltaC;
          this.temperatures[index + 1] =
            (this.temperatures[index + 1] ?? constants.ambientC) + deltaC;
        }

        const belowC = this.previousTemperatures[index - 1] ?? constants.ambientC;
        if (temperature < belowC) {
          const deltaC =
            constants.convectionRate * constants.fixedStepSeconds * (belowC - temperature);
          this.temperatures[index] = (this.temperatures[index] ?? constants.ambientC) + deltaC;
          this.temperatures[index - 1] =
            (this.temperatures[index - 1] ?? constants.ambientC) - deltaC;
        }
      }
    }
  }
}

function validateScenario(scenario: V1ReferenceScenario): void {
  const dt = V1_REFERENCE_CONSTANTS.fixedStepSeconds;
  if (!Number.isFinite(scenario.durationSeconds) || scenario.durationSeconds < 0) {
    throw new RangeError('v1 reference duration must be a non-negative finite number');
  }
  if (!Number.isFinite(scenario.sampleEverySeconds) || scenario.sampleEverySeconds <= 0) {
    throw new RangeError('v1 reference sample interval must be a positive finite number');
  }
  if (Math.abs(scenario.durationSeconds / dt - Math.round(scenario.durationSeconds / dt)) > 1e-9) {
    throw new RangeError('v1 reference duration must align with the fixed 0.1 s step');
  }
  if (
    Math.abs(scenario.sampleEverySeconds / dt - Math.round(scenario.sampleEverySeconds / dt)) > 1e-9
  ) {
    throw new RangeError('v1 reference sample interval must align with the fixed 0.1 s step');
  }
  if (scenario.duty.length === 0 || scenario.duty[0]?.atSeconds !== 0) {
    throw new RangeError('v1 reference duty schedule must start at 0 s');
  }

  let previousTime = -Infinity;
  for (const point of scenario.duty) {
    if (
      !Number.isFinite(point.atSeconds) ||
      point.atSeconds < 0 ||
      point.atSeconds > scenario.durationSeconds ||
      point.atSeconds <= previousTime
    ) {
      throw new RangeError('v1 reference duty points must be ordered within the scenario');
    }
    if (
      Math.abs(point.atSeconds / dt - Math.round(point.atSeconds / dt)) > 1e-9 ||
      !Number.isFinite(point.dutyFraction) ||
      point.dutyFraction < 0 ||
      point.dutyFraction > 1
    ) {
      throw new RangeError('v1 reference duty points must align to 0.1 s and use duty 0..1');
    }
    previousTime = point.atSeconds;
  }
}

function dutyAtStep(schedule: readonly V1ReferenceDutyPoint[], currentPoint: number): number {
  return schedule[currentPoint]?.dutyFraction ?? 0;
}

export function simulateV1Reference(scenario: V1ReferenceScenario): V1ReferenceResult {
  validateScenario(scenario);
  const dt = V1_REFERENCE_CONSTANTS.fixedStepSeconds;
  const stepCount = Math.round(scenario.durationSeconds / dt);
  const sampleStepCount = Math.round(scenario.sampleEverySeconds / dt);
  const plant = new V1ReferencePlant();
  const samples: V1ReferenceSample[] = [];
  let dutyPointIndex = 0;
  let dutyFraction = dutyAtStep(scenario.duty, dutyPointIndex);
  samples.push({ timeSeconds: 0, dutyFraction, sensorC: plant.sensorC });

  let minimumSensorC = plant.sensorC;
  let maximumSensorC = plant.sensorC;
  for (let step = 0; step < stepCount; step += 1) {
    const atSeconds = step * dt;
    while (
      dutyPointIndex + 1 < scenario.duty.length &&
      atSeconds >= (scenario.duty[dutyPointIndex + 1]?.atSeconds ?? Infinity) - 1e-9
    ) {
      dutyPointIndex += 1;
    }
    dutyFraction = dutyAtStep(scenario.duty, dutyPointIndex);
    const sensorC = plant.step(dutyFraction);
    minimumSensorC = Math.min(minimumSensorC, sensorC);
    maximumSensorC = Math.max(maximumSensorC, sensorC);
    if ((step + 1) % sampleStepCount === 0 || step + 1 === stepCount) {
      samples.push({
        timeSeconds: (step + 1) * dt,
        dutyFraction,
        sensorC,
      });
    }
  }

  return {
    samples,
    metrics: {
      finalSensorC: plant.sensorC,
      minimumSensorC,
      maximumSensorC,
    },
    execution: {
      fixedStepSeconds: dt,
      simulatedSteps: stepCount,
      gridCells: GRID_CELL_COUNT,
    },
  };
}
