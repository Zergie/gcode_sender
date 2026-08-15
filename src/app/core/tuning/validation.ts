import { TuningDomainError } from './tuning-error';
import type { M105Telemetry, ValidationLimits, ValidationMetrics } from './types';

const DEFAULT_VALIDATION_LIMITS: ValidationLimits = Object.freeze({
  settlingBandC: 2,
  settlingHoldMs: 60_000,
  steadyStateWindowMs: 60_000,
  maximumOvershootC: 8,
  maximumSteadyStateErrorC: 2,
  maximumSensorSpreadC: 15,
});

function resolveLimits(overrides: Partial<ValidationLimits>): ValidationLimits {
  const resolved = { ...DEFAULT_VALIDATION_LIMITS, ...overrides };
  const positive: readonly (keyof ValidationLimits)[] = [
    'settlingBandC',
    'settlingHoldMs',
    'steadyStateWindowMs',
    'maximumOvershootC',
    'maximumSteadyStateErrorC',
    'maximumSensorSpreadC',
  ];
  for (const key of positive) {
    if (!Number.isFinite(resolved[key]) || resolved[key] <= 0) {
      throw new TuningDomainError(
        'INVALID_VALIDATION_TRACE',
        `${key} must be finite and greater than zero.`,
        key,
      );
    }
  }
  return resolved;
}

function firstCrossing(
  samples: readonly M105Telemetry[],
  thresholdC: number,
  rising: boolean,
): number | undefined {
  return samples.find((sample) => (rising ? sample.t0C >= thresholdC : sample.t0C <= thresholdC))
    ?.atMs;
}

function settlingTime(
  samples: readonly M105Telemetry[],
  targetC: number,
  bandC: number,
  holdMs: number,
): number | undefined {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  for (let index = 0; index < samples.length; index += 1) {
    const candidate = samples[index];
    if (candidate === undefined || last.atMs - candidate.atMs < holdMs) {
      continue;
    }
    const remaining = samples.slice(index);
    if (remaining.every((sample) => Math.abs(sample.t0C - targetC) <= bandC)) {
      return candidate.atMs - first.atMs;
    }
  }
  return undefined;
}

function integrateAbsoluteError(samples: readonly M105Telemetry[], targetC: number): number {
  let integral = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const stepSeconds = (current.atMs - previous.atMs) / 1000;
    integral +=
      ((Math.abs(previous.t0C - targetC) + Math.abs(current.t0C - targetC)) / 2) * stepSeconds;
  }
  return integral;
}

/** Calculates metrics for an explicitly separate, bounded validation run. */
export function calculateValidationMetrics(
  samples: readonly M105Telemetry[],
  targetC: number,
  limitOverrides: Partial<ValidationLimits> = {},
): ValidationMetrics {
  if (!Number.isFinite(targetC)) {
    throw new TuningDomainError(
      'INVALID_VALIDATION_TRACE',
      'Validation target must be finite.',
      'targetC',
    );
  }
  if (samples.length < 2) {
    throw new TuningDomainError(
      'INVALID_VALIDATION_TRACE',
      'Validation metrics require at least two samples.',
      'samples',
    );
  }
  samples.forEach((sample, index) => {
    const values = [sample.atMs, sample.t0C, sample.t1C, sample.t2C, sample.t3C, sample.output];
    if (!values.every(Number.isFinite)) {
      throw new TuningDomainError(
        'INVALID_VALIDATION_TRACE',
        'Validation samples must contain finite values.',
        `samples[${index}]`,
      );
    }
    if (index > 0 && sample.atMs <= (samples[index - 1]?.atMs ?? -1)) {
      throw new TuningDomainError(
        'INVALID_VALIDATION_TRACE',
        'Validation samples must have strictly increasing timestamps.',
        `samples[${index}].atMs`,
      );
    }
  });

  const limits = resolveLimits(limitOverrides);
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    throw new TuningDomainError('INVALID_VALIDATION_TRACE', 'Validation trace is empty.');
  }
  const rising = targetC >= first.t0C;
  const span = targetC - first.t0C;
  const tenPercentC = first.t0C + span * 0.1;
  const ninetyPercentC = first.t0C + span * 0.9;
  const tenPercentAt = firstCrossing(samples, tenPercentC, rising);
  const ninetyPercentAt = firstCrossing(samples, ninetyPercentC, rising);
  const riseTimeMs =
    tenPercentAt !== undefined && ninetyPercentAt !== undefined && ninetyPercentAt >= tenPercentAt
      ? ninetyPercentAt - tenPercentAt
      : undefined;

  const temperatures = samples.map((sample) => sample.t0C);
  const maximum = Math.max(...temperatures);
  const minimum = Math.min(...temperatures);
  const overshootC = Math.max(0, maximum - targetC);
  const undershootC = Math.max(0, targetC - minimum);
  const steadyStartMs = last.atMs - limits.steadyStateWindowMs;
  const steadySamples = samples.filter((sample) => sample.atMs >= steadyStartMs);
  const steadyStateErrorC =
    steadySamples.reduce((sum, sample) => sum + (sample.t0C - targetC), 0) / steadySamples.length;
  const maximumSensorSpreadC = Math.max(
    ...samples.map((sample) => Math.abs(sample.t1C - sample.t2C)),
  );
  const t3Values = samples.map((sample) => sample.t3C);
  const settledAtMs = settlingTime(samples, targetC, limits.settlingBandC, limits.settlingHoldMs);
  const meanOutputPercent =
    (samples.reduce((sum, sample) => sum + sample.output, 0) / samples.length / 255) * 100;

  return {
    targetC,
    durationMs: last.atMs - first.atMs,
    sampleCount: samples.length,
    riseTimeMs,
    settlingTimeMs: settledAtMs,
    overshootC,
    undershootC,
    steadyStateErrorC,
    integralAbsoluteErrorCSeconds: integrateAbsoluteError(samples, targetC),
    maximumSensorSpreadC,
    t3RangeC: [Math.min(...t3Values), Math.max(...t3Values)],
    meanOutputPercent,
    passed:
      settledAtMs !== undefined &&
      overshootC <= limits.maximumOvershootC &&
      Math.abs(steadyStateErrorC) <= limits.maximumSteadyStateErrorC &&
      maximumSensorSpreadC <= limits.maximumSensorSpreadC,
  };
}
