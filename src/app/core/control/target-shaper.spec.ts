import { describe, expect, it } from 'vitest';

import { createTargetShaperState, stepTargetShaper } from './target-shaper';
import type { ModelAssistedTargetConfiguration } from './types';

const configuration: ModelAssistedTargetConfiguration = {
  heatingRampCPerMinute: 60,
  coolingRampCPerMinute: 120,
  predictionHorizonSeconds: 10,
  maximumTargetLeadC: 5,
  minimumCommandC: 0,
  maximumCommandC: 250,
};

describe('model-assisted target shaping', () => {
  it('ramps and applies a bounded predictive target lead', () => {
    const result = stepTargetShaper(
      'model-assisted-pid',
      configuration,
      createTargetShaperState(20),
      200,
      1,
    );
    expect(result.trajectoryTargetC).toBe(21);
    expect(result.targetLeadC).toBe(5);
    expect(result.firmwareTargetC).toBe(26);
  });

  it('uses the requested target directly in PID mode', () => {
    const result = stepTargetShaper('pid', configuration, createTargetShaperState(20), 180, 1);
    expect(result.firmwareTargetC).toBe(180);
    expect(result.targetLeadC).toBe(0);
  });
});
