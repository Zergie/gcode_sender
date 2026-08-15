import { ControlDomainError } from './control-error';
import type { PidGains, PidSchedule } from './types';

function assertFiniteNonNegative(value: number, path: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ControlDomainError(
      'INVALID_PID_SCHEDULE',
      `${path} must be a finite, non-negative number.`,
      path,
    );
  }
}

function assertGains(gains: PidGains, path: string): void {
  if (gains === undefined || gains === null) {
    throw new ControlDomainError('INVALID_PID_SCHEDULE', `${path} is required.`, path);
  }

  assertFiniteNonNegative(gains.kp, `${path}.kp`);
  assertFiniteNonNegative(gains.ki, `${path}.ki`);
  assertFiniteNonNegative(gains.kd, `${path}.kd`);
}

export function validatePidSchedule(schedule: PidSchedule): void {
  if (schedule.length === 0) {
    throw new ControlDomainError(
      'INVALID_PID_SCHEDULE',
      'A PID schedule requires at least one breakpoint.',
      'schedule',
    );
  }

  let previousTemperature = Number.NEGATIVE_INFINITY;

  schedule.forEach((breakpoint, index) => {
    const path = `schedule[${index}]`;
    if (!Number.isFinite(breakpoint.temperatureC)) {
      throw new ControlDomainError(
        'INVALID_PID_SCHEDULE',
        `${path}.temperatureC must be finite.`,
        `${path}.temperatureC`,
      );
    }
    if (breakpoint.temperatureC <= previousTemperature) {
      throw new ControlDomainError(
        'INVALID_PID_SCHEDULE',
        'PID breakpoint temperatures must be strictly increasing.',
        `${path}.temperatureC`,
      );
    }
    assertGains(breakpoint.gains, `${path}.gains`);
    previousTemperature = breakpoint.temperatureC;
  });
}

/** Validates, clones, and freezes a schedule so callers cannot mutate it later. */
export function createPidSchedule(breakpoints: PidSchedule): PidSchedule {
  validatePidSchedule(breakpoints);
  return Object.freeze(
    breakpoints.map((breakpoint) =>
      Object.freeze({
        temperatureC: breakpoint.temperatureC,
        gains: Object.freeze({ ...breakpoint.gains }),
      }),
    ),
  );
}

function mix(from: number, to: number, ratio: number): number {
  return from + (to - from) * ratio;
}

/**
 * Returns the gain triplet for a temperature. Values outside the schedule are
 * clamped; values between breakpoints are linearly interpolated.
 */
export function interpolatePidGains(schedule: PidSchedule, temperatureC: number): PidGains {
  validatePidSchedule(schedule);
  if (!Number.isFinite(temperatureC)) {
    throw new ControlDomainError(
      'INVALID_PID_SCHEDULE',
      'The interpolation temperature must be finite.',
      'temperatureC',
    );
  }

  const first = schedule[0];
  const last = schedule[schedule.length - 1];
  if (first === undefined || last === undefined) {
    // The preceding validation makes this unreachable, but it keeps indexed
    // access safe under strict TypeScript settings.
    throw new ControlDomainError('INVALID_PID_SCHEDULE', 'The PID schedule is empty.');
  }

  if (temperatureC <= first.temperatureC) {
    return { ...first.gains };
  }
  if (temperatureC >= last.temperatureC) {
    return { ...last.gains };
  }

  for (let index = 1; index < schedule.length; index += 1) {
    const upper = schedule[index];
    const lower = schedule[index - 1];
    if (upper !== undefined && lower !== undefined && temperatureC <= upper.temperatureC) {
      const ratio = (temperatureC - lower.temperatureC) / (upper.temperatureC - lower.temperatureC);
      return {
        kp: mix(lower.gains.kp, upper.gains.kp, ratio),
        ki: mix(lower.gains.ki, upper.gains.ki, ratio),
        kd: mix(lower.gains.kd, upper.gains.kd, ratio),
      };
    }
  }

  return { ...last.gains };
}

/**
 * Advances gains towards a newly scheduled triplet without overshoot. The
 * transition duration means approximately 99% settled, which makes repeated
 * calls safe even while the scheduled temperature is moving.
 */
export function advancePidGainTransition(
  current: PidGains,
  scheduled: PidGains,
  stepSeconds: number,
  transitionSeconds: number,
): PidGains {
  assertGains(current, 'current');
  assertGains(scheduled, 'scheduled');
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) {
    throw new ControlDomainError(
      'INVALID_PID_CONFIGURATION',
      'stepSeconds must be finite and greater than zero.',
      'stepSeconds',
    );
  }
  if (!Number.isFinite(transitionSeconds) || transitionSeconds < 0) {
    throw new ControlDomainError(
      'INVALID_PID_CONFIGURATION',
      'transitionSeconds must be finite and non-negative.',
      'transitionSeconds',
    );
  }

  const blend =
    transitionSeconds === 0 ? 1 : 1 - Math.exp((-Math.log(100) * stepSeconds) / transitionSeconds);
  return {
    kp: mix(current.kp, scheduled.kp, blend),
    ki: mix(current.ki, scheduled.ki, blend),
    kd: mix(current.kd, scheduled.kd, blend),
  };
}
