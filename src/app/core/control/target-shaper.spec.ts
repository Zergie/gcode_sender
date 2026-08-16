import { describe, expect, it } from 'vitest';

import { createTargetShaperState, validateTargetShaperConfiguration } from './target-shaper';

describe('model-assistance configuration', () => {
  it('validates bounds and initializes state without inventing a response curve', () => {
    expect(() =>
      validateTargetShaperConfiguration({
        predictionHorizonSeconds: 15,
        maximumTargetLeadC: 15,
        minimumCommandC: 0,
        maximumCommandC: 250,
      }),
    ).not.toThrow();
    expect(createTargetShaperState(20)).toEqual({
      trajectoryTargetC: 20,
      firmwareTargetC: 20,
    });
  });
});
