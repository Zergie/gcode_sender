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
});
