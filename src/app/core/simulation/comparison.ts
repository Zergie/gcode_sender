import { simulate } from './engine';
import { SimulationDomainError } from './simulation-error';
import type {
  SimulationComparisonRequest,
  SimulationComparisonResult,
  SimulationMetricDelta,
  SimulationMetrics,
} from './types';

function subtractMetrics(
  candidate: SimulationMetrics,
  baseline: SimulationMetrics,
): SimulationMetricDelta {
  return {
    integralAbsoluteErrorCSeconds:
      candidate.integralAbsoluteErrorCSeconds - baseline.integralAbsoluteErrorCSeconds,
    rootMeanSquareErrorC: candidate.rootMeanSquareErrorC - baseline.rootMeanSquareErrorC,
    maximumOvershootC: candidate.maximumOvershootC - baseline.maximumOvershootC,
    finalErrorC: candidate.finalErrorC - baseline.finalErrorC,
    energyWh: candidate.energyWh - baseline.energyWh,
    actuatorSaturationPercent:
      candidate.actuatorSaturationPercent - baseline.actuatorSaturationPercent,
  };
}

/** Runs every controller against identical deterministic physics and initial state. */
export function compareSimulations(
  request: SimulationComparisonRequest,
): SimulationComparisonResult {
  if (request.variants.length < 2) {
    throw new SimulationDomainError(
      'INVALID_COMPARISON_REQUEST',
      'A comparison requires at least two controller variants.',
      'variants',
    );
  }
  const identifiers = new Set(request.variants.map((variant) => variant.id));
  if (
    identifiers.size !== request.variants.length ||
    [...identifiers].some((identifier) => identifier.trim().length === 0)
  ) {
    throw new SimulationDomainError(
      'INVALID_COMPARISON_REQUEST',
      'Comparison variant identifiers must be non-empty and unique.',
      'variants',
    );
  }
  if (!identifiers.has(request.baselineId)) {
    throw new SimulationDomainError(
      'INVALID_COMPARISON_REQUEST',
      'baselineId must identify one of the variants.',
      'baselineId',
    );
  }

  const executed = request.variants.map((variant) => ({
    variant,
    result: simulate({
      profile: request.profile,
      controller: variant.controller,
      scenario: request.scenario,
      controllerRuntime: request.controllerRuntime,
      timewarp: request.timewarp,
    }),
  }));
  const baseline = executed.find(({ variant }) => variant.id === request.baselineId);
  if (baseline === undefined) {
    throw new SimulationDomainError(
      'INVALID_COMPARISON_REQUEST',
      'The baseline simulation result is unavailable.',
    );
  }

  return {
    baselineId: request.baselineId,
    entries: executed.map(({ variant, result }) => ({
      id: variant.id,
      label: variant.label,
      result,
      deltaFromBaseline: subtractMetrics(result.metrics, baseline.result.metrics),
    })),
  };
}
