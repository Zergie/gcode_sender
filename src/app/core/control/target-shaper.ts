import { ControlDomainError } from './control-error';
import type { ModelAssistedTargetConfiguration, TargetShaperState } from './types';

export function validateTargetShaperConfiguration(
  configuration: ModelAssistedTargetConfiguration,
): void {
  if (
    !Number.isFinite(configuration.predictionHorizonSeconds) ||
    configuration.predictionHorizonSeconds <= 0
  ) {
    throw new ControlDomainError(
      'INVALID_TARGET_SHAPER_CONFIGURATION',
      'predictionHorizonSeconds must be finite and greater than zero.',
      'predictionHorizonSeconds',
    );
  }

  const nonNegativeFields: ReadonlyArray<readonly [string, number]> = [
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
  if (Math.ceil(configuration.minimumCommandC) > Math.floor(configuration.maximumCommandC)) {
    throw new ControlDomainError(
      'INVALID_TARGET_SHAPER_CONFIGURATION',
      'The command bounds must contain at least one whole-degree M104 target.',
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
