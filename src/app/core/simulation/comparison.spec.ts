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
      seed: 123,
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
    expect(comparison.entries[1]?.result.execution.seed).toBe(
      comparison.entries[0]?.result.execution.seed,
    );
    expect(comparison.entries[1]?.result.samples).not.toEqual(
      comparison.entries[0]?.result.samples,
    );
    expect(comparison.entries[1]?.result.metrics).not.toEqual(
      comparison.entries[0]?.result.metrics,
    );
  });

  it('produces meaningfully different plant responses for the default PID comparison', () => {
    const pid = DEFAULT_SIMULATION_CONTROLLER.pid;
    const comparison = compareSimulations({
      profile: DEFAULT_OVEN_PROFILE,
      scenario: {
        durationSeconds: 35 * 60,
        targets: [{ atSeconds: 0, targetC: 200 }],
        sampleEverySeconds: 5,
      },
      seed: 20260815,
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
    const maximumTemperatureDifferenceC = Math.max(
      ...baseline.samples.map((sample, index) => {
        const assistedSample = assisted.samples[index];
        if (assistedSample === undefined) throw new Error('Comparison samples are misaligned.');
        return Math.abs(sample.temperatures.t0C - assistedSample.temperatures.t0C);
      }),
    );
    expect(maximumTemperatureDifferenceC).toBeGreaterThanOrEqual(0.5);
    expect(Math.abs(baseline.metrics.energyWh - assisted.metrics.energyWh)).toBeGreaterThanOrEqual(
      1,
    );
  });
});
