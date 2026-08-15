import { ControlDomainError } from './control-error';
import { advancePidGainTransition, interpolatePidGains, validatePidSchedule } from './pid-schedule';
import type {
  PidControllerConfiguration,
  PidControllerState,
  PidStepInput,
  PidStepResult,
} from './types';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function validatePidControllerConfiguration(
  configuration: PidControllerConfiguration,
): void {
  validatePidSchedule(configuration.schedule);

  const finiteFields: ReadonlyArray<readonly [string, number]> = [
    ['gainTransitionSeconds', configuration.gainTransitionSeconds],
    ['outputMinimum', configuration.outputMinimum],
    ['outputMaximum', configuration.outputMaximum],
    ['integralMinimum', configuration.integralMinimum],
    ['integralMaximum', configuration.integralMaximum],
    ['derivativeFilterSeconds', configuration.derivativeFilterSeconds],
  ];
  for (const [path, value] of finiteFields) {
    if (!Number.isFinite(value)) {
      throw new ControlDomainError('INVALID_PID_CONFIGURATION', `${path} must be finite.`, path);
    }
  }
  if (configuration.gainTransitionSeconds < 0) {
    throw new ControlDomainError(
      'INVALID_PID_CONFIGURATION',
      'gainTransitionSeconds must be non-negative.',
      'gainTransitionSeconds',
    );
  }
  if (configuration.derivativeFilterSeconds < 0) {
    throw new ControlDomainError(
      'INVALID_PID_CONFIGURATION',
      'derivativeFilterSeconds must be non-negative.',
      'derivativeFilterSeconds',
    );
  }
  if (configuration.outputMinimum >= configuration.outputMaximum) {
    throw new ControlDomainError(
      'INVALID_PID_CONFIGURATION',
      'outputMinimum must be less than outputMaximum.',
      'outputMinimum',
    );
  }
  if (configuration.integralMinimum > configuration.integralMaximum) {
    throw new ControlDomainError(
      'INVALID_PID_CONFIGURATION',
      'integralMinimum must not exceed integralMaximum.',
      'integralMinimum',
    );
  }
}

export function createPidControllerState(
  configuration: PidControllerConfiguration,
  initialSetpointC: number,
  initialMeasurementC: number,
): PidControllerState {
  validatePidControllerConfiguration(configuration);
  if (!Number.isFinite(initialSetpointC) || !Number.isFinite(initialMeasurementC)) {
    throw new ControlDomainError(
      'INVALID_PID_CONFIGURATION',
      'Initial setpoint and measurement must be finite.',
    );
  }
  return {
    integralTerm: 0,
    previousMeasurementC: initialMeasurementC,
    filteredDerivativeCPerSecond: 0,
    activeGains: interpolatePidGains(configuration.schedule, initialSetpointC),
  };
}

/** One immutable PID step using derivative-on-measurement and anti-windup. */
export function stepPidController(
  configuration: PidControllerConfiguration,
  state: PidControllerState,
  input: PidStepInput,
): PidStepResult {
  if (
    !Number.isFinite(input.setpointC) ||
    !Number.isFinite(input.measurementC) ||
    !Number.isFinite(input.stepSeconds) ||
    input.stepSeconds <= 0
  ) {
    throw new ControlDomainError(
      'INVALID_PID_CONFIGURATION',
      'PID step inputs must be finite and stepSeconds must be greater than zero.',
    );
  }

  const scheduled = interpolatePidGains(configuration.schedule, input.setpointC);
  const gains = advancePidGainTransition(
    state.activeGains,
    scheduled,
    input.stepSeconds,
    configuration.gainTransitionSeconds,
  );
  const error = input.setpointC - input.measurementC;
  const measurementDerivative =
    -(input.measurementC - state.previousMeasurementC) / input.stepSeconds;
  const filterBlend =
    configuration.derivativeFilterSeconds === 0
      ? 1
      : input.stepSeconds / (configuration.derivativeFilterSeconds + input.stepSeconds);
  const filteredDerivative =
    state.filteredDerivativeCPerSecond +
    filterBlend * (measurementDerivative - state.filteredDerivativeCPerSecond);

  const proportional = gains.kp * error;
  const candidateIntegral = clamp(
    state.integralTerm + gains.ki * error * input.stepSeconds,
    configuration.integralMinimum,
    configuration.integralMaximum,
  );
  const derivative = gains.kd * filteredDerivative;
  const candidateRawOutput = proportional + candidateIntegral + derivative;
  const pushesFurtherIntoSaturation =
    (candidateRawOutput > configuration.outputMaximum && error > 0) ||
    (candidateRawOutput < configuration.outputMinimum && error < 0);
  const integral = pushesFurtherIntoSaturation ? state.integralTerm : candidateIntegral;
  const output = clamp(
    proportional + integral + derivative,
    configuration.outputMinimum,
    configuration.outputMaximum,
  );

  return {
    output,
    terms: { proportional, integral, derivative },
    gains,
    state: {
      integralTerm: integral,
      previousMeasurementC: input.measurementC,
      filteredDerivativeCPerSecond: filteredDerivative,
      activeGains: gains,
    },
  };
}
