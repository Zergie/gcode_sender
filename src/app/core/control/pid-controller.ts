import { ControlDomainError } from './control-error';
import { validatePidSchedule } from './pid-schedule';
import type { PidControllerConfiguration } from './types';

/** Validates desktop gain scheduling around the firmware-owned QuickPID loop. */
export function validatePidControllerConfiguration(
  configuration: PidControllerConfiguration,
): void {
  validatePidSchedule(configuration.schedule);
  if (
    !Number.isFinite(configuration.gainTransitionSeconds) ||
    configuration.gainTransitionSeconds < 0
  ) {
    throw new ControlDomainError(
      'INVALID_PID_CONFIGURATION',
      'gainTransitionSeconds must be finite and non-negative.',
      'gainTransitionSeconds',
    );
  }
}
