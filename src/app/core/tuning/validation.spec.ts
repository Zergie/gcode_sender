import { describe, expect, it } from 'vitest';

import type { M105Telemetry } from './types';
import { calculateValidationMetrics } from './validation';

function sample(atMs: number, temperatureC: number, output = 80): M105Telemetry {
  return {
    atMs,
    t0C: temperatureC,
    t1C: temperatureC + 0.5,
    t2C: temperatureC - 0.5,
    t3C: 30,
    reportedTargetC: 100,
    output,
  };
}

describe('validation metrics', () => {
  it('calculates response, error, spread, and bounded pass metrics', () => {
    const temperatures = [20, 40, 60, 80, 95, 100, 101, 100, 100, 100, 100, 100, 100];
    const samples = temperatures.map((temperature, index) => sample(index * 10_000, temperature));
    const result = calculateValidationMetrics(samples, 100, {
      settlingBandC: 2,
      settlingHoldMs: 30_000,
      steadyStateWindowMs: 30_000,
      maximumOvershootC: 5,
      maximumSteadyStateErrorC: 1,
      maximumSensorSpreadC: 2,
    });

    expect(result.riseTimeMs).toBe(30_000);
    expect(result.settlingTimeMs).toBe(50_000);
    expect(result.overshootC).toBe(1);
    expect(result.steadyStateErrorC).toBe(0);
    expect(result.maximumSensorSpreadC).toBe(1);
    expect(result.integralAbsoluteErrorCSeconds).toBeGreaterThan(0);
    expect(result.passed).toBe(true);
  });

  it('marks a trace with overshoot and sensor disagreement as not passed', () => {
    const samples = [sample(0, 90), sample(1_000, 112), sample(2_000, 100)];
    samples[1] = { ...samples[1]!, t1C: 120, t2C: 90 };
    const result = calculateValidationMetrics(samples, 100, {
      settlingHoldMs: 1_000,
      steadyStateWindowMs: 1_000,
      maximumOvershootC: 5,
      maximumSensorSpreadC: 10,
    });
    expect(result.overshootC).toBe(12);
    expect(result.maximumSensorSpreadC).toBe(30);
    expect(result.passed).toBe(false);
  });

  it('rejects unordered and undersized traces', () => {
    expect(() => calculateValidationMetrics([sample(0, 20)], 100)).toThrowError(
      expect.objectContaining({ code: 'INVALID_VALIDATION_TRACE' }),
    );
    expect(() =>
      calculateValidationMetrics([sample(1_000, 20), sample(500, 30)], 100),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_VALIDATION_TRACE' }));
  });
});
