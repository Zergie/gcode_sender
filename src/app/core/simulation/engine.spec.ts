import { describe, expect, it } from 'vitest';

import { DEFAULT_OVEN_PROFILE, DEFAULT_SIMULATION_CONTROLLER } from './default-profile';
import { simulate } from './engine';
import type { OvenModelProfile, SimulationRequest } from './types';

function request(overrides: Partial<SimulationRequest> = {}): SimulationRequest {
  return {
    profile: DEFAULT_OVEN_PROFILE,
    controller: DEFAULT_SIMULATION_CONTROLLER,
    scenario: {
      durationSeconds: 30,
      targets: [{ atSeconds: 0, targetC: 180 }],
      sampleEverySeconds: 1,
    },
    ...overrides,
  };
}

function withBodyCapacity(
  profile: OvenModelProfile,
  body: keyof OvenModelProfile['bodies'],
  heatCapacityJPerK: number,
): OvenModelProfile {
  return {
    ...profile,
    bodies: {
      ...profile.bodies,
      [body]: { heatCapacityJPerK },
    },
  };
}

describe('physical oven digital twin orchestration', () => {
  it('is deterministic and keeps T0 as the exact firmware T1/T2 average', () => {
    const first = simulate(request());
    const second = simulate(request());
    expect(first).toEqual(second);
    for (const sample of first.samples) {
      expect(sample.temperatures.t0C).toBe((sample.temperatures.t1C + sample.temperatures.t2C) / 2);
    }
  });

  it('uses one quantized actuator for two physically independent heaters', () => {
    const result = simulate(
      request({
        profile: {
          ...DEFAULT_OVEN_PROFILE,
          heaters: {
            top: { ...DEFAULT_OVEN_PROFILE.heaters.top, ratedPowerW: 1_100 },
            bottom: { ...DEFAULT_OVEN_PROFILE.heaters.bottom, ratedPowerW: 700 },
          },
        },
      }),
    );
    const final = result.samples.at(-1);
    expect(final?.temperatures.topZoneC).toBeGreaterThan(final?.temperatures.bottomZoneC ?? 0);
    expect(final?.actuator.applied).toBeGreaterThanOrEqual(0);
    expect(final?.actuator.applied).toBeLessThanOrEqual(1);
    expect((final?.actuator.applied ?? 0) * 255).toBe(
      Math.trunc((final?.actuator.applied ?? 0) * 255),
    );
  });

  it('derives heater coast and delay from stored thermal energy', () => {
    const lighterElements = simulate(
      request({ profile: withBodyCapacity(DEFAULT_OVEN_PROFILE, 'topHeater', 25) }),
    );
    const heavierElements = simulate(
      request({ profile: withBodyCapacity(DEFAULT_OVEN_PROFILE, 'topHeater', 250) }),
    );
    expect(lighterElements.samples.at(-1)?.temperatures.topZoneC).not.toBeCloseTo(
      heavierElements.samples.at(-1)?.temperatures.topZoneC ?? 0,
      3,
    );
  });

  it('migrates old profiles without carrying artificial lag parameters forward', () => {
    const legacyProfile = {
      version: 1,
      kind: 'dual-zone-shared-actuator',
      name: 'Legacy oven',
      ambientTemperatureC: 24,
      topHeater: { watts: 1_010, efficiency: 0.8, responseTimeSeconds: 91 },
      bottomHeater: { watts: 870, efficiency: 0.8, responseTimeSeconds: 2 },
      actuationDeadTimeSeconds: 12,
    } as unknown as OvenModelProfile;
    const result = simulate(request({ profile: legacyProfile }));
    expect(result.samples[0]?.temperatures.t0C).toBe(24);
    expect(result.samples.at(-1)?.temperatures.topZoneC).toBeGreaterThan(
      result.samples.at(-1)?.temperatures.bottomZoneC ?? 0,
    );
  });

  it('keeps fixed-step physics identical at every timewarp', () => {
    const normal = simulate(request({ timewarp: 1 }));
    const maximum = simulate(request({ timewarp: 'maximum' }));
    expect(maximum.samples).toEqual(normal.samples);
    expect(maximum.metrics).toEqual(normal.metrics);
    expect(maximum.execution.fixedStepSeconds).toBe(normal.execution.fixedStepSeconds);
    expect(maximum.execution.stepsPerBatch).toBeGreaterThan(normal.execution.stepsPerBatch);
  });

  it('derives model-assisted commands from the physical twin profile', () => {
    const controller = {
      ...DEFAULT_SIMULATION_CONTROLLER,
      mode: 'model-assisted-pid' as const,
      modelAssistance: {
        ...DEFAULT_SIMULATION_CONTROLLER.modelAssistance,
        predictionHorizonSeconds: 5,
      },
    };
    const scenario = {
      durationSeconds: 20,
      targets: [{ atSeconds: 0, targetC: 150 }],
      sampleEverySeconds: 1,
    };
    const nominalHeaters = simulate(request({ controller, scenario }));
    const lowPowerHeaters = simulate(
      request({
        controller,
        scenario,
        profile: {
          ...DEFAULT_OVEN_PROFILE,
          heaters: {
            top: { ...DEFAULT_OVEN_PROFILE.heaters.top, ratedPowerW: 250 },
            bottom: { ...DEFAULT_OVEN_PROFILE.heaters.bottom, ratedPowerW: 250 },
          },
        },
      }),
    );
    expect(nominalHeaters.samples.map((sample) => sample.firmwareTargetC)).not.toEqual(
      lowPowerHeaters.samples.map((sample) => sample.firmwareTargetC),
    );
  });

  it('leaves the requested heating-profile trajectory unchanged', () => {
    const result = simulate(
      request({
        controller: { ...DEFAULT_SIMULATION_CONTROLLER, mode: 'model-assisted-pid' },
        scenario: {
          durationSeconds: 12,
          targets: [
            { atSeconds: 0, targetC: 100 },
            { atSeconds: 5, targetC: 150 },
          ],
          sampleEverySeconds: 1,
        },
      }),
    );
    const withoutFutureStep = simulate(
      request({
        controller: { ...DEFAULT_SIMULATION_CONTROLLER, mode: 'model-assisted-pid' },
        scenario: {
          durationSeconds: 12,
          targets: [{ atSeconds: 0, targetC: 100 }],
          sampleEverySeconds: 1,
        },
      }),
    );

    expect(
      result.samples.every((sample) => sample.trajectoryTargetC === sample.requestedTargetC),
    ).toBe(true);
    expect(result.samples.filter((sample) => sample.timeSeconds < 5)).toEqual(
      withoutFutureStep.samples.filter((sample) => sample.timeSeconds < 5),
    );
  });

  it('does not synthesize a target oscillator at ambient equilibrium', () => {
    const result = simulate(
      request({
        controller: { ...DEFAULT_SIMULATION_CONTROLLER, mode: 'model-assisted-pid' },
        scenario: {
          durationSeconds: 10,
          targets: [{ atSeconds: 0, targetC: 22 }],
          sampleEverySeconds: 1,
        },
      }),
    );

    expect(result.samples.map((sample) => sample.firmwareTargetC)).toEqual(
      Array.from({ length: 11 }, () => 22),
    );
  });

  it('is deterministic without stochastic simulation inputs', () => {
    const first = simulate(request());
    const second = simulate(request());
    expect(first.samples).toEqual(second.samples);
  });

  it('uses whole-degree firmware targets and electrical input energy', () => {
    const result = simulate(
      request({
        scenario: {
          durationSeconds: 10,
          targets: [{ atSeconds: 0, targetC: 180.9 }],
          sampleEverySeconds: 1,
        },
      }),
    );
    expect(result.samples.every((sample) => Number.isInteger(sample.firmwareTargetC))).toBe(true);
    expect(result.metrics.energyWh).toBeGreaterThan(0);
  });
});
