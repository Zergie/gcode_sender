import { describe, expect, it } from 'vitest';

import { DEFAULT_OVEN_PROFILE, DEFAULT_SIMULATION_CONTROLLER } from '../default-profile';
import { simulate } from '../engine';
import { TEST_FIRMWARE_RUNTIME } from '../firmware-in-loop/firmware-in-loop.fixture';
import { PHYSICAL_200C_CYCLE } from './physical-cycle.fixture';
import {
  DEFAULT_THERMAL_TWIN_PROFILE,
  THERMAL_BODY_IDS,
  ThermalTwinValidationError,
  createThermalTwin,
  type ThermalBodyId,
  type ThermalTwinProfile,
  type ThermalTwinSnapshot,
} from './index';

function copyProfile(overrides: Partial<ThermalTwinProfile> = {}): ThermalTwinProfile {
  return {
    ...DEFAULT_THERMAL_TWIN_PROFILE,
    geometry: { ...DEFAULT_THERMAL_TWIN_PROFILE.geometry },
    bodies: Object.fromEntries(
      THERMAL_BODY_IDS.map((body) => [body, { ...DEFAULT_THERMAL_TWIN_PROFILE.bodies[body] }]),
    ) as Record<ThermalBodyId, { heatCapacityJPerK: number }>,
    heaters: {
      top: { ...DEFAULT_THERMAL_TWIN_PROFILE.heaters.top },
      bottom: { ...DEFAULT_THERMAL_TWIN_PROFILE.heaters.bottom },
    },
    linearLinks: DEFAULT_THERMAL_TWIN_PROFILE.linearLinks.map((link) => ({ ...link })),
    radiationLinks: DEFAULT_THERMAL_TWIN_PROFILE.radiationLinks.map((link) => ({ ...link })),
    ambient: { ...DEFAULT_THERMAL_TWIN_PROFILE.ambient },
    ...overrides,
  };
}

function adiabatic(profile: ThermalTwinProfile = copyProfile()): ThermalTwinProfile {
  return {
    ...profile,
    ambient: {
      ...profile.ambient,
      enclosureConductanceWPerK: 0,
      enclosureRadiatingAreaM2: 0,
      topAirExchangeM3PerSecond: 0,
      bottomAirExchangeM3PerSecond: 0,
      t3AmbientConductanceWPerK: 0,
    },
  };
}

function internalEnergyBetween(
  profile: ThermalTwinProfile,
  before: ThermalTwinSnapshot,
  after: ThermalTwinSnapshot,
  bodies: readonly ThermalBodyId[],
): number {
  return bodies.reduce(
    (energyJ, body) =>
      energyJ +
      profile.bodies[body].heatCapacityJPerK *
        (after.temperaturesC[body] - before.temperaturesC[body]),
    0,
  );
}

function maximumTemperatureDifference(
  first: ThermalTwinSnapshot,
  second: ThermalTwinSnapshot,
): number {
  return Math.max(
    ...THERMAL_BODY_IDS.map((body) =>
      Math.abs(first.temperaturesC[body] - second.temperaturesC[body]),
    ),
  );
}

function replayPhysicalCycle(profile: ThermalTwinProfile = DEFAULT_THERMAL_TWIN_PROFILE) {
  const { initial, samples } = PHYSICAL_200C_CYCLE;
  const initialAverageC = (initial.t1C + initial.t2C) / 2;
  const twin = createThermalTwin({
    profile,
    initialTemperatureC: initialAverageC,
    initialTemperaturesC: { t1: initial.t1C, t2: initial.t2C, t3: initial.t3C },
  });
  const controlErrorsC: number[] = [];
  const t3ErrorsC: number[] = [];
  const heatGainsC: number[] = [];
  let previousControlC = initialAverageC;
  let reachedTargetBand = false;
  let firstTargetBandSeconds: number | null = null;

  for (const [timeSeconds, duty, measuredT1C, measuredT2C, measuredT3C] of samples) {
    const snapshot = twin.advance({ durationSeconds: 20, duty });
    const controlC = (snapshot.temperaturesC.t1 + snapshot.temperaturesC.t2) / 2;
    const measuredControlC = (measuredT1C + measuredT2C) / 2;
    controlErrorsC.push(controlC - measuredControlC);
    t3ErrorsC.push(snapshot.temperaturesC.t3 - measuredT3C);
    if (!reachedTargetBand) heatGainsC.push(controlC - previousControlC);
    if (controlC >= 199) {
      reachedTargetBand = true;
      firstTargetBandSeconds ??= timeSeconds;
    }
    previousControlC = controlC;
  }

  const rmse = (errors: readonly number[]) =>
    Math.sqrt(errors.reduce((sum, errorC) => sum + errorC ** 2, 0) / errors.length);
  return {
    controlRmseC: rmse(controlErrorsC),
    t3RmseC: rmse(t3ErrorsC),
    minimumHeatGainC: Math.min(...heatGainsC),
    firstTargetBandSeconds,
  };
}

describe('physical thermal twin', () => {
  it('replays the measured 200 C physical cycle without triggering the firmware heat-rate fault', () => {
    const replay = replayPhysicalCycle();
    expect(replay.minimumHeatGainC).toBeGreaterThanOrEqual(1);
    expect(replay.firstTargetBandSeconds).toBeGreaterThanOrEqual(140);
    expect(replay.firstTargetBandSeconds).toBeLessThanOrEqual(220);
    expect(replay.controlRmseC).toBeLessThan(12);
    expect(replay.t3RmseC).toBeLessThan(8);
  });

  it('keeps ambient equilibrium exactly at zero duty', () => {
    const twin = createThermalTwin();
    const result = twin.advance({ durationSeconds: 60, duty: 0 });

    for (const body of THERMAL_BODY_IDS) {
      expect(result.temperaturesC[body]).toBe(DEFAULT_THERMAL_TWIN_PROFILE.ambientTemperatureC);
    }
    expect(result.energy.internalEnergyChangeJ).toBe(0);
    expect(result.energy.electricalInputJ).toBe(0);
    expect(result.energy.netHeatToAmbientJ).toBe(0);
    expect(result.energy.balanceResidualJ).toBe(0);
  });

  it('conserves total energy for pairwise conduction, convection, and radiation', () => {
    const twin = createThermalTwin({
      profile: adiabatic(),
      initialTemperatureC: 40,
      initialTemperaturesC: {
        topHeater: 310,
        bottomHeater: 180,
        topAir: 80,
        bottomAir: 55,
        standardLoad: 25,
        enclosure: 45,
      },
    });

    const result = twin.advance({ durationSeconds: 20, duty: 0 });

    expect(result.energy.electricalInputJ).toBe(0);
    expect(result.energy.netHeatToAmbientJ).toBe(0);
    expect(Math.abs(result.energy.internalEnergyChangeJ)).toBeLessThan(1e-8);
    expect(Math.abs(result.energy.balanceResidualJ)).toBeLessThan(1e-8);
  });

  it('creates no heat at zero power and accounts for all heat rejected to ambient', () => {
    const twin = createThermalTwin({ initialTemperatureC: 120 });
    const result = twin.advance({ durationSeconds: 10, duty: 0 });

    expect(result.energy.electricalInputJ).toBe(0);
    expect(result.energy.internalEnergyChangeJ).toBeLessThan(0);
    expect(result.energy.netHeatToAmbientJ).toBeGreaterThan(0);
    expect(Math.abs(result.energy.balanceResidualJ)).toBeLessThan(1e-8);
  });

  it('releases heater-body stored energy during a zero-duty coast-down', () => {
    const profile = copyProfile();
    const twin = createThermalTwin({ profile });
    const beforeCoast = twin.advance({ durationSeconds: 20, duty: 1 });
    const afterCoast = twin.advance({ durationSeconds: 30, duty: 0 });
    const heaterBodies = ['topHeater', 'bottomHeater'] as const;
    const receivingBodies = THERMAL_BODY_IDS.filter(
      (body) => !heaterBodies.includes(body as (typeof heaterBodies)[number]),
    );
    const heaterEnergyChangeJ = internalEnergyBetween(
      profile,
      beforeCoast,
      afterCoast,
      heaterBodies,
    );
    const receivingEnergyChangeJ = internalEnergyBetween(
      profile,
      beforeCoast,
      afterCoast,
      receivingBodies,
    );
    const coastAmbientHeatJ =
      afterCoast.energy.netHeatToAmbientJ - beforeCoast.energy.netHeatToAmbientJ;

    expect(afterCoast.temperaturesC.topHeater).toBeLessThan(beforeCoast.temperaturesC.topHeater);
    expect(afterCoast.temperaturesC.bottomHeater).toBeLessThan(
      beforeCoast.temperaturesC.bottomHeater,
    );
    expect(heaterEnergyChangeJ).toBeLessThan(0);
    expect(receivingEnergyChangeJ).toBeGreaterThan(0);
    expect(afterCoast.energy.electricalInputJ).toBe(beforeCoast.energy.electricalInputJ);
    expect(-heaterEnergyChangeJ).toBeCloseTo(receivingEnergyChangeJ + coastAmbientHeatJ, 7);
  });

  it('moves radiative heat from the hotter body to the colder body in either direction', () => {
    const radiationOnly = adiabatic(
      copyProfile({
        heaters: {
          top: { body: 'topHeater', ratedPowerW: 0 },
          bottom: { body: 'bottomHeater', ratedPowerW: 0 },
        },
        linearLinks: [],
        radiationLinks: [
          {
            a: 'topHeater',
            b: 'standardLoad',
            areaM2: 0.02,
            emissivity: 0.8,
            viewFactor: 1,
          },
        ],
      }),
    );
    const forward = createThermalTwin({
      profile: radiationOnly,
      initialTemperatureC: 20,
      initialTemperaturesC: { topHeater: 200 },
    });
    const reverse = createThermalTwin({
      profile: radiationOnly,
      initialTemperatureC: 20,
      initialTemperaturesC: { standardLoad: 200 },
    });

    const forwardResult = forward.advance({ durationSeconds: 1, duty: 0 });
    const reverseResult = reverse.advance({ durationSeconds: 1, duty: 0 });

    expect(forwardResult.temperaturesC.topHeater).toBeLessThan(200);
    expect(forwardResult.temperaturesC.standardLoad).toBeGreaterThan(20);
    expect(reverseResult.temperaturesC.standardLoad).toBeLessThan(200);
    expect(reverseResult.temperaturesC.topHeater).toBeGreaterThan(20);
  });

  it('applies one shared duty while preserving physical heater asymmetry', () => {
    const profile = copyProfile({
      heaters: {
        top: { body: 'topHeater', ratedPowerW: 1_000 },
        bottom: { body: 'bottomHeater', ratedPowerW: 500 },
      },
    });
    const twin = createThermalTwin({ profile });
    const result = twin.advance({ durationSeconds: 1, duty: 0.4 });

    expect(result.duty).toBe(0.4);
    expect(result.energy.electricalInputJ).toBeCloseTo(600, 10);
    expect(result.temperaturesC.topHeater).toBeGreaterThan(result.temperaturesC.bottomHeater);
  });

  it('derives thermistor response from sensor heat capacity and contact conductance', () => {
    const profile = adiabatic(
      copyProfile({
        heaters: {
          top: { body: 'topHeater', ratedPowerW: 0 },
          bottom: { body: 'bottomHeater', ratedPowerW: 0 },
        },
        linearLinks: [
          {
            a: 'topAir',
            b: 't1',
            mechanism: 'sensor-contact',
            conductanceWPerK: 0.06,
          },
        ],
        radiationLinks: [],
      }),
    );
    const twin = createThermalTwin({
      profile,
      initialTemperatureC: 20,
      initialTemperaturesC: { topAir: 100 },
    });
    const result = twin.advance({ durationSeconds: 0.5, duty: 0 });

    expect(result.temperaturesC.t1).toBeGreaterThan(20);
    expect(result.temperaturesC.t1).toBeLessThan(result.temperaturesC.topAir);
    expect(result.temperaturesC.topAir).toBeLessThan(100);
    expect(result.temperaturesC.t2).toBe(20);
    expect(result.temperaturesC.t3).toBe(20);
  });

  it('cools the exposed T3 bead to ambient through a ledger-accounted physical path', () => {
    const isolated = adiabatic(
      copyProfile({
        heaters: {
          top: { body: 'topHeater', ratedPowerW: 0 },
          bottom: { body: 'bottomHeater', ratedPowerW: 0 },
        },
        linearLinks: [],
        radiationLinks: [],
      }),
    );
    const profile: ThermalTwinProfile = {
      ...isolated,
      ambient: {
        ...isolated.ambient,
        t3AmbientConductanceWPerK: 0.12,
      },
    };
    const twin = createThermalTwin({
      profile,
      initialTemperatureC: profile.ambientTemperatureC,
      initialTemperaturesC: { t3: 100 },
    });
    const result = twin.advance({ durationSeconds: 1, duty: 0 });

    expect(result.temperaturesC.t3).toBeGreaterThan(profile.ambientTemperatureC);
    expect(result.temperaturesC.t3).toBeLessThan(100);
    expect(result.energy.electricalInputJ).toBe(0);
    expect(result.energy.netHeatToAmbientJ).toBeGreaterThan(0);
    expect(result.energy.internalEnergyChangeJ).toBeCloseTo(-result.energy.netHeatToAmbientJ, 10);
    expect(Math.abs(result.energy.balanceResidualJ)).toBeLessThan(1e-10);
  });

  it('keeps an enclosure-contact T3 cooler when its bead is exposed to ambient', () => {
    const initialTemperaturesC = { enclosure: 200, t3: 22 } as const;
    const exposed = createThermalTwin({ initialTemperaturesC });
    const sheltered = createThermalTwin({
      profile: copyProfile({
        ambient: {
          ...DEFAULT_THERMAL_TWIN_PROFILE.ambient,
          t3AmbientConductanceWPerK: 0,
        },
      }),
      initialTemperaturesC,
    });

    const exposedResult = exposed.advance({ durationSeconds: 10, duty: 0 });
    const shelteredResult = sheltered.advance({ durationSeconds: 10, duty: 0 });

    expect(exposedResult.temperaturesC.t3).toBeGreaterThan(22);
    expect(exposedResult.temperaturesC.t3).toBeLessThan(shelteredResult.temperaturesC.t3);
    expect(exposedResult.energy.netHeatToAmbientJ).toBeGreaterThan(
      shelteredResult.energy.netHeatToAmbientJ,
    );
  });

  it('makes observer correction explicit and starts a new energy-ledger epoch', () => {
    const twin = createThermalTwin();
    const before = twin.advance({ durationSeconds: 2, duty: 0.5 });
    const observation = {
      t1C: before.temperaturesC.t1 + 3,
      t2C: before.temperaturesC.t2 - 1,
      t3C: before.temperaturesC.t3 + 2,
    };
    const expectedCorrectionJ =
      DEFAULT_THERMAL_TWIN_PROFILE.bodies.t1.heatCapacityJPerK * 3 -
      DEFAULT_THERMAL_TWIN_PROFILE.bodies.t2.heatCapacityJPerK +
      DEFAULT_THERMAL_TWIN_PROFILE.bodies.t3.heatCapacityJPerK * 2;
    const correction = twin.assimilateSensorObservation(observation);

    expect(correction.snapshot.timeSeconds).toBe(before.timeSeconds);
    expect(correction.snapshot.temperaturesC.topHeater).toBe(before.temperaturesC.topHeater);
    expect(correction.snapshot.temperaturesC.standardLoad).toBe(before.temperaturesC.standardLoad);
    expect(correction.snapshot.temperaturesC.t1).toBe(observation.t1C);
    expect(correction.snapshot.temperaturesC.t2).toBe(observation.t2C);
    expect(correction.snapshot.temperaturesC.t3).toBe(observation.t3C);
    expect(correction.imposedInternalEnergyChangeJ).toBeCloseTo(expectedCorrectionJ, 10);
    expect(correction.snapshot.energy.internalEnergyChangeJ).toBe(0);
    expect(correction.snapshot.energy.electricalInputJ).toBe(0);
    expect(correction.snapshot.energy.netHeatToAmbientJ).toBe(0);
    expect(correction.snapshot.energy.balanceResidualJ).toBe(0);

    const advanced = twin.advance({ durationSeconds: 0.05, duty: 0.5 });
    expect(Math.abs(advanced.energy.balanceResidualJ)).toBeLessThan(1e-9);
  });

  it('keeps the exposed T3 bead below 80 C in the default firmware-parity 200 C run', () => {
    const result = simulate({
      profile: DEFAULT_OVEN_PROFILE,
      controller: DEFAULT_SIMULATION_CONTROLLER,
      controllerRuntime: TEST_FIRMWARE_RUNTIME,
      scenario: {
        durationSeconds: 2_100,
        targets: [{ atSeconds: 0, targetC: 200 }],
        sampleEverySeconds: 5,
      },
    });
    const maximumT3C = Math.max(...result.samples.map((sample) => sample.temperatures.t3C));

    expect(maximumT3C).toBeGreaterThan(DEFAULT_OVEN_PROFILE.ambientTemperatureC);
    expect(maximumT3C).toBeLessThan(80);
  });

  it('forks into deterministic, independent simulation cursors', () => {
    const original = createThermalTwin();
    original.advance({ durationSeconds: 2, duty: 0.25 });
    const branch = original.fork();

    const originalResult = original.advance({ durationSeconds: 3, duty: 0.7 });
    const branchResult = branch.advance({ durationSeconds: 3, duty: 0.7 });
    expect(branchResult).toEqual(originalResult);

    branch.advance({ durationSeconds: 1, duty: 0 });
    expect(original.snapshot()).toEqual(originalResult);
    expect(branch.snapshot()).not.toEqual(originalResult);
  });

  it('converges as the fixed RK4 step is refined', () => {
    const simulateAtStep = (solverStepSeconds: number): ThermalTwinSnapshot => {
      const twin = createThermalTwin({
        profile: copyProfile({ solverStepSeconds }),
        initialTemperaturesC: { topHeater: 80, bottomHeater: 60 },
      });
      return twin.advance({ durationSeconds: 30, duty: 0.63 });
    };

    const coarse = simulateAtStep(0.1);
    const medium = simulateAtStep(0.05);
    const fine = simulateAtStep(0.025);
    const coarseError = maximumTemperatureDifference(coarse, fine);
    const mediumError = maximumTemperatureDifference(medium, fine);

    expect(mediumError).toBeLessThan(coarseError);
    expect(mediumError).toBeLessThan(0.001);
    expect(Math.abs(fine.energy.balanceResidualJ)).toBeLessThan(1e-8);
  });
});

describe('thermal twin validation', () => {
  it('rejects nonphysical profiles and commands without silently clamping them', () => {
    const invalidProfile = copyProfile({
      bodies: {
        ...DEFAULT_THERMAL_TWIN_PROFILE.bodies,
        topHeater: { heatCapacityJPerK: -1 },
      },
    });

    expect(() => createThermalTwin({ profile: invalidProfile })).toThrow(
      ThermalTwinValidationError,
    );
    expect(() =>
      createThermalTwin({
        profile: copyProfile({
          ambient: {
            ...DEFAULT_THERMAL_TWIN_PROFILE.ambient,
            t3AmbientConductanceWPerK: -0.01,
          },
        }),
      }),
    ).toThrow(/ambient\.t3AmbientConductanceWPerK/);
    expect(() =>
      createThermalTwin({
        profile: { ...copyProfile(), geometry: undefined } as unknown as ThermalTwinProfile,
      }),
    ).toThrow(/geometry: must be an object/);
    expect(() => createThermalTwin({ initialTemperatureC: -273.15 })).toThrow(/absolute zero/);

    const twin = createThermalTwin();
    expect(() => twin.advance({ durationSeconds: 1, duty: 1.01 })).toThrow(/0\.\.1/);
    expect(() => twin.advance({ durationSeconds: 0.01, duty: 0 })).toThrow(/integer multiple/);
  });
});
