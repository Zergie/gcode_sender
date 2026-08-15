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
  });
});
