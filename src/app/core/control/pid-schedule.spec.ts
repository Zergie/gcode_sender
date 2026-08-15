import { describe, expect, it } from 'vitest';

import { ControlDomainError } from './control-error';
import { advancePidGainTransition, createPidSchedule, interpolatePidGains } from './pid-schedule';

describe('PID schedules', () => {
  const schedule = createPidSchedule([
    { temperatureC: 100, gains: { kp: 10, ki: 1, kd: 2 } },
    { temperatureC: 200, gains: { kp: 20, ki: 3, kd: 6 } },
  ]);

  it('clamps outside the breakpoint range and interpolates inside it', () => {
    expect(interpolatePidGains(schedule, 50)).toEqual({ kp: 10, ki: 1, kd: 2 });
    expect(interpolatePidGains(schedule, 150)).toEqual({ kp: 15, ki: 2, kd: 4 });
    expect(interpolatePidGains(schedule, 250)).toEqual({ kp: 20, ki: 3, kd: 6 });
  });

  it('rejects unsorted breakpoints and negative gains with typed errors', () => {
    expect(() =>
      createPidSchedule([
        { temperatureC: 150, gains: { kp: 1, ki: 1, kd: 1 } },
        { temperatureC: 150, gains: { kp: 2, ki: 2, kd: 2 } },
      ]),
    ).toThrow(ControlDomainError);
    expect(() =>
      createPidSchedule([{ temperatureC: 150, gains: { kp: -1, ki: 1, kd: 1 } }]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PID_SCHEDULE' }));
  });

  it('smoothly approaches newly scheduled gains without overshoot', () => {
    const transitioned = advancePidGainTransition(
      { kp: 1, ki: 2, kd: 3 },
      { kp: 11, ki: 12, kd: 13 },
      0.5,
      5,
    );
    expect(transitioned.kp).toBeGreaterThan(1);
    expect(transitioned.kp).toBeLessThan(11);
    expect(transitioned.ki - 2).toBeCloseTo(transitioned.kp - 1);
    expect(
      advancePidGainTransition({ kp: 1, ki: 2, kd: 3 }, { kp: 11, ki: 12, kd: 13 }, 0.5, 0),
    ).toEqual({ kp: 11, ki: 12, kd: 13 });
  });
});
