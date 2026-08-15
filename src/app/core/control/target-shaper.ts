import { ControlDomainError } from './control-error';
import type {
  ControlMode,
  ModelAssistedTargetConfiguration,
  TargetShaperState,
  TargetShaperStepResult,
} from './types';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function validateTargetShaperConfiguration(
  configuration: ModelAssistedTargetConfiguration,
): void {
  const positiveFields: ReadonlyArray<readonly [string, number]> = [
    ['heatingRampCPerMinute', configuration.heatingRampCPerMinute],
    ['coolingRampCPerMinute', configuration.coolingRampCPerMinute],
  ];
  for (const [path, value] of positiveFields) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ControlDomainError(
        'INVALID_TARGET_SHAPER_CONFIGURATION',
        `${path} must be finite and greater than zero.`,
        path,
      );
    }
  }

  const nonNegativeFields: ReadonlyArray<readonly [string, number]> = [
    ['predictionHorizonSeconds', configuration.predictionHorizonSeconds],
    ['maximumTargetLeadC', configuration.maximumTargetLeadC],
  ];
  for (const [path, value] of nonNegativeFields) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ControlDomainError(
        'INVALID_TARGET_SHAPER_CONFIGURATION',
        `${path} must be finite and non-negative.`,
        path,
      );
    }
  }

  if (
    !Number.isFinite(configuration.minimumCommandC) ||
    !Number.isFinite(configuration.maximumCommandC) ||
    configuration.minimumCommandC >= configuration.maximumCommandC
  ) {
    throw new ControlDomainError(
      'INVALID_TARGET_SHAPER_CONFIGURATION',
      'minimumCommandC must be finite and less than maximumCommandC.',
      'minimumCommandC',
    );
  }
}

export function createTargetShaperState(initialTemperatureC: number): TargetShaperState {
  if (!Number.isFinite(initialTemperatureC)) {
    throw new ControlDomainError(
      'INVALID_TARGET_SHAPER_CONFIGURATION',
      'Initial target-shaper temperature must be finite.',
      'initialTemperatureC',
    );
  }
  return {
    trajectoryTargetC: initialTemperatureC,
    firmwareTargetC: initialTemperatureC,
  };
}

/**
 * Produces the target sent to unchanged firmware. Model-assisted mode ramps the
 * operator target and adds a bounded look-ahead; it never manipulates actuator
 * output directly.
 */
export function stepTargetShaper(
  mode: ControlMode,
  configuration: ModelAssistedTargetConfiguration,
  state: TargetShaperState,
  requestedTargetC: number,
  stepSeconds: number,
): TargetShaperStepResult {
  validateTargetShaperConfiguration(configuration);
  if (!Number.isFinite(requestedTargetC) || !Number.isFinite(stepSeconds) || stepSeconds <= 0) {
    throw new ControlDomainError(
      'INVALID_TARGET_SHAPER_CONFIGURATION',
      'requestedTargetC must be finite and stepSeconds must be greater than zero.',
    );
  }

  const boundedRequest = clamp(
    requestedTargetC,
    configuration.minimumCommandC,
    configuration.maximumCommandC,
  );
  if (mode === 'pid') {
    const nextState = {
      trajectoryTargetC: boundedRequest,
      firmwareTargetC: boundedRequest,
    };
    return {
      requestedTargetC,
      trajectoryTargetC: boundedRequest,
      firmwareTargetC: boundedRequest,
      trajectoryRateCPerSecond: 0,
      targetLeadC: 0,
      state: nextState,
    };
  }

  const difference = boundedRequest - state.trajectoryTargetC;
  const rampPerSecond =
    difference >= 0
      ? configuration.heatingRampCPerMinute / 60
      : configuration.coolingRampCPerMinute / 60;
  const maximumChange = rampPerSecond * stepSeconds;
  const change = clamp(difference, -maximumChange, maximumChange);
  const trajectoryTargetC = state.trajectoryTargetC + change;
  const trajectoryRateCPerSecond = change / stepSeconds;
  const targetLeadC = clamp(
    trajectoryRateCPerSecond * configuration.predictionHorizonSeconds,
    -configuration.maximumTargetLeadC,
    configuration.maximumTargetLeadC,
  );
  const firmwareTargetC = clamp(
    trajectoryTargetC + targetLeadC,
    configuration.minimumCommandC,
    configuration.maximumCommandC,
  );
  const nextState = { trajectoryTargetC, firmwareTargetC };
  return {
    requestedTargetC,
    trajectoryTargetC,
    firmwareTargetC,
    trajectoryRateCPerSecond,
    targetLeadC,
    state: nextState,
  };
}
