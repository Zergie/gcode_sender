import { describe, expect, it } from 'vitest';

import { validatePidControllerConfiguration } from './pid-controller';

describe('firmware PID scheduling configuration', () => {
  it('validates only the host-side gain schedule and transition', () => {
    expect(() =>
      validatePidControllerConfiguration({
        schedule: [{ temperatureC: 100, gains: { kp: 25, ki: 1, kd: 110 } }],
        gainTransitionSeconds: 5,
      }),
    ).not.toThrow();
    expect(() =>
      validatePidControllerConfiguration({
        schedule: [{ temperatureC: 100, gains: { kp: 25, ki: 1, kd: 110 } }],
        gainTransitionSeconds: -1,
      }),
    ).toThrow(/non-negative/);
  });
});
