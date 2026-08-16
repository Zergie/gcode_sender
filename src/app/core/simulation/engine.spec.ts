import { describe, expect, it } from 'vitest';

import { DEFAULT_OVEN_PROFILE, DEFAULT_SIMULATION_CONTROLLER } from './default-profile';
import { simulate } from './engine';
import type { SimulationRequest } from './types';

function request(overrides: Partial<SimulationRequest> = {}): SimulationRequest {
  return {
    profile: DEFAULT_OVEN_PROFILE,
    controller: DEFAULT_SIMULATION_CONTROLLER,
    scenario: {
      durationSeconds: 120,
      targets: [{ atSeconds: 0, targetC: 180 }],
      sampleEverySeconds: 1,
    },
    seed: 42,
    ...overrides,
  };
}

describe('dual-zone oven simulation', () => {
  it('is deterministic for a seed and keeps T0 as the exact T1/T2 average', () => {
    const first = simulate(request());
    const second = simulate(request());
    expect(first).toEqual(second);
    for (const sample of first.samples) {
      expect(sample.temperatures.t0C).toBe((sample.temperatures.t1C + sample.temperatures.t2C) / 2);
    }
  });

  it('uses one actuator command for both independently powered heaters', () => {
    const result = simulate(
      request({
        profile: {
          ...DEFAULT_OVEN_PROFILE,
          sensors: { ...DEFAULT_OVEN_PROFILE.sensors, noiseStandardDeviationC: 0 },
          topHeater: { ...DEFAULT_OVEN_PROFILE.topHeater, watts: 1_100 },
          bottomHeater: { ...DEFAULT_OVEN_PROFILE.bottomHeater, watts: 700 },
        },
      }),
    );
    const final = result.samples.at(-1);
    expect(final).toBeDefined();
    expect(final?.temperatures.topZoneC).toBeGreaterThan(final?.temperatures.bottomZoneC ?? 0);
    expect(final?.actuator.commanded).toBeGreaterThanOrEqual(0);
    expect(final?.actuator.commanded).toBeLessThanOrEqual(1);
  });

  it('makes element heat-release lag independently tunable', () => {
    const laggedResponse = simulate(request());
    const immediateResponse = simulate(
      request({
        profile: {
          ...DEFAULT_OVEN_PROFILE,
          topHeater: { ...DEFAULT_OVEN_PROFILE.topHeater, responseTimeSeconds: 0 },
          bottomHeater: { ...DEFAULT_OVEN_PROFILE.bottomHeater, responseTimeSeconds: 0 },
        },
      }),
    );

    expect(immediateResponse.samples.at(-1)?.temperatures.t0C).toBeGreaterThan(
      laggedResponse.samples.at(-1)?.temperatures.t0C ?? 0,
    );
  });

  it('defaults heater response time for version-1 profiles saved before the field existed', () => {
    const legacyProfile = {
      ...DEFAULT_OVEN_PROFILE,
      topHeater: {
        watts: DEFAULT_OVEN_PROFILE.topHeater.watts,
        efficiency: DEFAULT_OVEN_PROFILE.topHeater.efficiency,
      },
      bottomHeater: {
        watts: DEFAULT_OVEN_PROFILE.bottomHeater.watts,
        efficiency: DEFAULT_OVEN_PROFILE.bottomHeater.efficiency,
      },
    } as unknown as SimulationRequest['profile'];

    expect(simulate(request({ profile: legacyProfile }))).toEqual(simulate(request()));
  });

  it('keeps fixed-step physics identical at every timewarp', () => {
    const normal = simulate(request({ timewarp: 1 }));
    const maximum = simulate(request({ timewarp: 'maximum' }));
    expect(maximum.samples).toEqual(normal.samples);
    expect(maximum.metrics).toEqual(normal.metrics);
    expect(maximum.execution.fixedStepSeconds).toBe(normal.execution.fixedStepSeconds);
    expect(maximum.execution.stepsPerBatch).toBeGreaterThan(normal.execution.stepsPerBatch);
  });

  it('exposes requested, ramped, and predictive targets in model-assisted mode', () => {
    const result = simulate(
      request({
        controller: { ...DEFAULT_SIMULATION_CONTROLLER, mode: 'model-assisted-pid' },
      }),
    );
    const initial = result.samples[0];
    expect(initial?.requestedTargetC).toBe(180);
    expect(initial?.trajectoryTargetC).toBeLessThan(180);
    expect(initial?.firmwareTargetC).toBeGreaterThan(initial?.trajectoryTargetC ?? 0);
  });

  it('uses different deterministic noise sequences for different seeds', () => {
    const first = simulate(request({ seed: 1 }));
    const second = simulate(request({ seed: 2 }));
    expect(first.samples[1]?.temperatures.t1C).not.toBe(second.samples[1]?.temperatures.t1C);
  });

  it('reproduces the sustained heater cycling seen around a held temperature', () => {
    const targetC = 200;
    const result = simulate(
      request({
        profile: {
          ...DEFAULT_OVEN_PROFILE,
          sensors: { ...DEFAULT_OVEN_PROFILE.sensors, noiseStandardDeviationC: 0 },
        },
        scenario: {
          durationSeconds: 2_100,
          targets: [{ atSeconds: 0, targetC }],
          sampleEverySeconds: 1,
        },
      }),
    );
    const settledTrace = result.samples.filter((sample) => sample.timeSeconds >= 1_500);
    const errors = settledTrace.map((sample) => sample.temperatures.t0C - targetC);
    const crossingTimes = settledTrace
      .slice(1)
      .filter((sample, index) => {
        const error = sample.temperatures.t0C - targetC;
        const previousError = errors[index] ?? error;
        return error * previousError < 0;
      })
      .map((sample) => sample.timeSeconds);
    const fullPeriodsSeconds = crossingTimes
      .slice(2)
      .map((crossingTime, index) => crossingTime - crossingTimes[index]!);
    const peakToPeakC = Math.max(...errors) - Math.min(...errors);

    expect(crossingTimes.length).toBeGreaterThanOrEqual(4);
    expect(crossingTimes.length).toBeLessThanOrEqual(12);
    expect(peakToPeakC).toBeGreaterThanOrEqual(5);
    expect(peakToPeakC).toBeLessThanOrEqual(7);
    expect(fullPeriodsSeconds.length).toBeGreaterThan(0);
    expect(fullPeriodsSeconds.every((period) => period >= 120 && period <= 360)).toBe(true);
  });
});
