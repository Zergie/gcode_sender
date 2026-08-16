import { describe, expect, it } from 'vitest';

import { compareSimulations } from './comparison';
import { DEFAULT_OVEN_PROFILE, DEFAULT_SIMULATION_CONTROLLER } from './default-profile';

describe('simulation comparison', () => {
  it('runs variants with shared conditions and reports baseline-relative metrics', () => {
    const comparison = compareSimulations({
      profile: DEFAULT_OVEN_PROFILE,
      scenario: {
        durationSeconds: 60,
        targets: [{ atSeconds: 0, targetC: 150 }],
        sampleEverySeconds: 1,
      },
      baselineId: 'pid',
      variants: [
        { id: 'pid', label: 'PID', controller: DEFAULT_SIMULATION_CONTROLLER },
        {
          id: 'assisted',
          label: 'Model-assisted PID',
          controller: { ...DEFAULT_SIMULATION_CONTROLLER, mode: 'model-assisted-pid' },
        },
      ],
    });
    expect(comparison.entries).toHaveLength(2);
    expect(comparison.entries[0]?.deltaFromBaseline).toEqual({
      integralAbsoluteErrorCSeconds: 0,
      rootMeanSquareErrorC: 0,
      maximumOvershootC: 0,
      finalErrorC: 0,
      energyWh: 0,
      actuatorSaturationPercent: 0,
    });
    expect(comparison.entries[1]?.result.samples).not.toEqual(
      comparison.entries[0]?.result.samples,
    );
    expect(comparison.entries[1]?.result.metrics).not.toEqual(
      comparison.entries[0]?.result.metrics,
    );
  });

  it('keeps twin-derived planning physically bounded through a long default comparison', () => {
    const pid = DEFAULT_SIMULATION_CONTROLLER.pid;
    const comparison = compareSimulations({
      profile: DEFAULT_OVEN_PROFILE,
      scenario: {
        durationSeconds: 35 * 60,
        targets: [{ atSeconds: 0, targetC: 200 }],
        sampleEverySeconds: 5,
      },
      baselineId: 'pid',
      variants: [
        {
          id: 'pid',
          label: 'PID',
          controller: { ...DEFAULT_SIMULATION_CONTROLLER, mode: 'pid', pid },
        },
        {
          id: 'assisted',
          label: 'Model-assisted PID',
          controller: { ...DEFAULT_SIMULATION_CONTROLLER, mode: 'model-assisted-pid', pid },
        },
      ],
    });
    const baseline = comparison.entries[0]?.result;
    const assisted = comparison.entries[1]?.result;
    if (baseline === undefined || assisted === undefined) {
      throw new Error('Expected both comparison results.');
    }
    expect(assisted.samples).toHaveLength(baseline.samples.length);
    expect(
      assisted.samples.every(
        (sample) =>
          sample.trajectoryTargetC === sample.requestedTargetC &&
          Number.isInteger(sample.firmwareTargetC) &&
          Math.abs(sample.firmwareTargetC - sample.requestedTargetC) <=
            DEFAULT_SIMULATION_CONTROLLER.modelAssistance.maximumTargetLeadC,
      ),
    ).toBe(true);
    expect(
      assisted.samples.some((sample) => sample.firmwareTargetC !== sample.requestedTargetC),
    ).toBe(true);
    expect(
      assisted.samples.every(
        (sample) =>
          Number.isFinite(sample.temperatures.t0C) &&
          Number.isFinite(sample.temperatures.t1C) &&
          Number.isFinite(sample.temperatures.t2C) &&
          Number.isFinite(sample.temperatures.t3C) &&
          sample.temperatures.t3C < 80,
      ),
    ).toBe(true);
    expect(
      Object.values(assisted.metrics).every((metric) => metric === null || Number.isFinite(metric)),
    ).toBe(true);
    expect(
      baseline.samples.every(
        (sample, index) => sample.timeSeconds === assisted.samples[index]?.timeSeconds,
      ),
    ).toBe(true);
  }, 30_000);
});
