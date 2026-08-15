import { describe, expect, it } from 'vitest';

import { DEFAULT_OVEN_PROFILE, DEFAULT_SIMULATION_CONTROLLER } from './default-profile';
import { simulate } from './engine';
import { fit } from './fit';
import { SimulationDomainError } from './simulation-error';

describe('reduced-order model fitting', () => {
  it('produces a physically valid proposal from a deterministic heating trace', () => {
    const sourceProfile = {
      ...DEFAULT_OVEN_PROFILE,
      sensors: {
        ...DEFAULT_OVEN_PROFILE.sensors,
        t1LagSeconds: 0,
        t2LagSeconds: 0,
        t3LagSeconds: 0,
        noiseStandardDeviationC: 0,
      },
    };
    const simulation = simulate({
      profile: sourceProfile,
      controller: DEFAULT_SIMULATION_CONTROLLER,
      scenario: {
        durationSeconds: 900,
        targets: [
          { atSeconds: 0, targetC: 180 },
          { atSeconds: 600, targetC: 100 },
        ],
        sampleEverySeconds: 0.5,
      },
      seed: 7,
    });
    const trace = simulation.samples.map((sample) => ({
      timeSeconds: sample.timeSeconds,
      actuator: sample.actuator.commanded,
      t1C: sample.temperatures.t1C,
      t2C: sample.temperatures.t2C,
      t3C: sample.temperatures.t3C,
    }));

    const result = fit({
      trace,
      baseProfile: sourceProfile,
      maximumDeadTimeSeconds: 10,
    });
    expect(result.profile.kind).toBe('dual-zone-shared-actuator');
    expect(result.profile.thermal.topZoneThermalMassJPerC).toBeGreaterThan(0);
    expect(result.profile.thermal.bottomZoneThermalMassJPerC).toBeGreaterThan(0);
    expect(result.quality.samplesUsed).toBe(trace.length);
    expect(result.quality.estimatedDeadTimeSeconds).toBeGreaterThanOrEqual(0);
    expect(result.quality.estimatedDeadTimeSeconds).toBeLessThanOrEqual(10);
    expect(sourceProfile.name).toBe(DEFAULT_OVEN_PROFILE.name);
  });

  it('rejects a flat, uninformative trace with a typed error', () => {
    const trace = Array.from({ length: 20 }, (_, index) => ({
      timeSeconds: index,
      actuator: 0,
      t1C: 22,
      t2C: 22,
      t3C: 22,
    }));
    expect(() => fit({ trace })).toThrow(SimulationDomainError);
    try {
      fit({ trace });
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_FIT_FAILED' });
    }
  });
});
