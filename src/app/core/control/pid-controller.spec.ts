import { describe, expect, it } from 'vitest';

import { createPidControllerState, stepPidController } from './pid-controller';
import type { PidControllerConfiguration } from './types';

const configuration: PidControllerConfiguration = {
  schedule: [{ temperatureC: 100, gains: { kp: 10, ki: 2, kd: 0 } }],
  gainTransitionSeconds: 0,
  outputMinimum: 0,
  outputMaximum: 255,
  integralMinimum: 0,
  integralMaximum: 255,
  derivativeFilterSeconds: 0,
};

describe('PID controller', () => {
  it('clamps output and prevents integral windup while saturated', () => {
    const initial = createPidControllerState(configuration, 100, 20);
    const first = stepPidController(configuration, initial, {
      setpointC: 100,
      measurementC: 20,
      stepSeconds: 1,
    });
    expect(first.output).toBe(255);
    expect(first.state.integralTerm).toBe(0);

    const second = stepPidController(configuration, first.state, {
      setpointC: 100,
      measurementC: 99,
      stepSeconds: 1,
    });
    expect(second.output).toBe(12);
    expect(second.state.integralTerm).toBe(2);
  });
});
