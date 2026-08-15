import { cloneOvenModelProfile, DEFAULT_OVEN_PROFILE } from './default-profile';
import { validateOvenModelProfile } from './engine';
import { SimulationDomainError } from './simulation-error';
import type {
  ModelFitConfidence,
  ModelFitRequest,
  ModelFitResult,
  OvenModelProfile,
  OvenTelemetryPoint,
} from './types';

interface RegressionRow {
  readonly features: readonly number[];
  readonly response: number;
}

interface RegressionResult {
  readonly coefficients: readonly number[];
  readonly squaredError: number;
  readonly totalVariation: number;
  readonly count: number;
}

interface CandidateFit {
  readonly deadTimeSeconds: number;
  readonly top: RegressionResult;
  readonly bottom: RegressionResult;
  readonly enclosure: RegressionResult;
  readonly squaredError: number;
  readonly totalVariation: number;
  readonly count: number;
}

const MINIMUM_TRACE_POINTS = 20;
const MINIMUM_HEATING_COEFFICIENT = 1e-8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle];
  if (high === undefined) {
    throw new SimulationDomainError(
      'INVALID_TELEMETRY_TRACE',
      'Cannot find a median of no values.',
    );
  }
  if (sorted.length % 2 === 1) {
    return high;
  }
  return ((sorted[middle - 1] ?? high) + high) / 2;
}

function validateTrace(trace: readonly OvenTelemetryPoint[]): number {
  if (trace.length < MINIMUM_TRACE_POINTS) {
    throw new SimulationDomainError(
      'INVALID_TELEMETRY_TRACE',
      `At least ${MINIMUM_TRACE_POINTS} telemetry points are required.`,
      'trace',
    );
  }

  const intervals: number[] = [];
  let previousTime = Number.NEGATIVE_INFINITY;
  let minimumTemperature = Number.POSITIVE_INFINITY;
  let maximumTemperature = Number.NEGATIVE_INFINITY;
  trace.forEach((point, index) => {
    const path = `trace[${index}]`;
    for (const [field, value] of [
      ['timeSeconds', point.timeSeconds],
      ['actuator', point.actuator],
      ['t1C', point.t1C],
      ['t2C', point.t2C],
      ['t3C', point.t3C],
    ] as const) {
      if (!Number.isFinite(value)) {
        throw new SimulationDomainError(
          'INVALID_TELEMETRY_TRACE',
          `${path}.${field} must be finite.`,
          `${path}.${field}`,
        );
      }
    }
    if (point.timeSeconds <= previousTime) {
      throw new SimulationDomainError(
        'INVALID_TELEMETRY_TRACE',
        'Telemetry timestamps must be strictly increasing.',
        `${path}.timeSeconds`,
      );
    }
    if (point.actuator < 0 || point.actuator > 1) {
      throw new SimulationDomainError(
        'INVALID_TELEMETRY_TRACE',
        'Telemetry actuator values must be normalized to 0..1.',
        `${path}.actuator`,
      );
    }
    if (index > 0) {
      intervals.push(point.timeSeconds - previousTime);
    }
    previousTime = point.timeSeconds;
    minimumTemperature = Math.min(minimumTemperature, point.t1C, point.t2C);
    maximumTemperature = Math.max(maximumTemperature, point.t1C, point.t2C);
  });

  if (maximumTemperature - minimumTemperature < 2) {
    throw new SimulationDomainError(
      'MODEL_FIT_FAILED',
      'The trace needs at least 2°C of control-sensor excitation.',
      'trace',
    );
  }
  return median(intervals);
}

function actuatorAt(trace: readonly OvenTelemetryPoint[], timeSeconds: number): number {
  const first = trace[0];
  const last = trace[trace.length - 1];
  if (first === undefined || last === undefined) {
    return 0;
  }
  // A trace is assumed to start from an inactive actuator. This makes a
  // recorded turn-on transient useful for dead-time identification.
  if (timeSeconds < first.timeSeconds) {
    return 0;
  }
  if (timeSeconds >= last.timeSeconds) {
    return last.actuator;
  }

  let low = 0;
  let high = trace.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const point = trace[middle];
    if (point !== undefined && point.timeSeconds <= timeSeconds) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const before = trace[low];
  const after = trace[high];
  if (before === undefined || after === undefined) {
    return 0;
  }
  const ratio = (timeSeconds - before.timeSeconds) / (after.timeSeconds - before.timeSeconds);
  return before.actuator + (after.actuator - before.actuator) * ratio;
}

function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  vector: readonly number[],
): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index] ?? 0]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]?.[column] ?? 0) > Math.abs(augmented[pivot]?.[column] ?? 0)) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot]?.[column] ?? 0) < 1e-12) {
      return null;
    }
    if (pivot !== column) {
      const temporary = augmented[column];
      const replacement = augmented[pivot];
      if (temporary === undefined || replacement === undefined) {
        return null;
      }
      augmented[column] = replacement;
      augmented[pivot] = temporary;
    }

    const pivotRow = augmented[column];
    const pivotValue = pivotRow?.[column];
    if (pivotRow === undefined || pivotValue === undefined) {
      return null;
    }
    for (let entry = column; entry <= size; entry += 1) {
      const value = pivotRow[entry];
      if (value === undefined) {
        return null;
      }
      pivotRow[entry] = value / pivotValue;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }
      const targetRow = augmented[row];
      const multiplier = targetRow?.[column];
      if (targetRow === undefined || multiplier === undefined) {
        return null;
      }
      for (let entry = column; entry <= size; entry += 1) {
        const rowValue = targetRow[entry];
        const pivotRowValue = pivotRow[entry];
        if (rowValue === undefined || pivotRowValue === undefined) {
          return null;
        }
        targetRow[entry] = rowValue - multiplier * pivotRowValue;
      }
    }
  }

  return augmented.map((row) => row[size] ?? 0);
}

function regress(rows: readonly RegressionRow[], featureCount: number): RegressionResult | null {
  const normalMatrix = Array.from({ length: featureCount }, () =>
    Array<number>(featureCount).fill(0),
  );
  const normalVector = Array<number>(featureCount).fill(0);
  for (const row of rows) {
    for (let left = 0; left < featureCount; left += 1) {
      const leftValue = row.features[left] ?? 0;
      normalVector[left] = (normalVector[left] ?? 0) + leftValue * row.response;
      const normalRow = normalMatrix[left];
      if (normalRow === undefined) {
        return null;
      }
      for (let right = 0; right < featureCount; right += 1) {
        normalRow[right] = (normalRow[right] ?? 0) + leftValue * (row.features[right] ?? 0);
      }
    }
  }
  // A small ridge keeps physically redundant traces (for example equal T1/T2)
  // solvable without introducing an intercept that would distort heat loss.
  for (let index = 0; index < featureCount; index += 1) {
    const normalRow = normalMatrix[index];
    if (normalRow === undefined) {
      return null;
    }
    normalRow[index] = (normalRow[index] ?? 0) + 1e-9;
  }
  const solved = solveLinearSystem(normalMatrix, normalVector);
  if (solved === null) {
    return null;
  }
  const coefficients = solved.map((coefficient) => Math.max(0, coefficient));
  const mean = rows.reduce((sum, row) => sum + row.response, 0) / rows.length;
  let squaredError = 0;
  let totalVariation = 0;
  for (const row of rows) {
    const prediction = row.features.reduce(
      (sum, feature, index) => sum + feature * (coefficients[index] ?? 0),
      0,
    );
    squaredError += (row.response - prediction) ** 2;
    totalVariation += (row.response - mean) ** 2;
  }
  return { coefficients, squaredError, totalVariation, count: rows.length };
}

function fitCandidate(
  trace: readonly OvenTelemetryPoint[],
  ambientTemperatureC: number,
  deadTimeSeconds: number,
): CandidateFit | null {
  const topRows: RegressionRow[] = [];
  const bottomRows: RegressionRow[] = [];
  const enclosureRows: RegressionRow[] = [];
  for (let index = 1; index < trace.length; index += 1) {
    const previous = trace[index - 1];
    const current = trace[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const interval = current.timeSeconds - previous.timeSeconds;
    const middleTime = (current.timeSeconds + previous.timeSeconds) / 2;
    const top = (current.t1C + previous.t1C) / 2;
    const bottom = (current.t2C + previous.t2C) / 2;
    const enclosure = (current.t3C + previous.t3C) / 2;
    const delayedInput = actuatorAt(trace, middleTime - deadTimeSeconds);
    topRows.push({
      features: [delayedInput, ambientTemperatureC - top, bottom - top, enclosure - top],
      response: (current.t1C - previous.t1C) / interval,
    });
    bottomRows.push({
      features: [delayedInput, ambientTemperatureC - bottom, top - bottom, enclosure - bottom],
      response: (current.t2C - previous.t2C) / interval,
    });
    enclosureRows.push({
      features: [ambientTemperatureC - enclosure, top - enclosure, bottom - enclosure],
      response: (current.t3C - previous.t3C) / interval,
    });
  }

  const top = regress(topRows, 4);
  const bottom = regress(bottomRows, 4);
  const enclosure = regress(enclosureRows, 3);
  if (top === null || bottom === null || enclosure === null) {
    return null;
  }
  return {
    deadTimeSeconds,
    top,
    bottom,
    enclosure,
    squaredError: top.squaredError + bottom.squaredError + enclosure.squaredError,
    totalVariation: top.totalVariation + bottom.totalVariation + enclosure.totalVariation,
    count: top.count + bottom.count + enclosure.count,
  };
}

function deriveMass(
  heatingCoefficient: number,
  availablePowerWatts: number,
  fallback: number,
  label: string,
  warnings: string[],
): number {
  if (heatingCoefficient <= MINIMUM_HEATING_COEFFICIENT) {
    warnings.push(
      `${label} thermal mass could not be identified; the previous value was retained.`,
    );
    return fallback;
  }
  const estimated = availablePowerWatts / heatingCoefficient;
  if (!Number.isFinite(estimated) || estimated < 100 || estimated > 10_000_000) {
    warnings.push(
      `${label} thermal mass estimate was implausible; the previous value was retained.`,
    );
    return fallback;
  }
  return estimated;
}

function confidenceFor(rSquared: number, temperatureSpanC: number): ModelFitConfidence {
  if (rSquared >= 0.85 && temperatureSpanC >= 15) {
    return 'high';
  }
  if (rSquared >= 0.6 && temperatureSpanC >= 5) {
    return 'medium';
  }
  return 'low';
}

/**
 * Identifies a reduced-order profile from actuator and thermistor telemetry.
 * Sensor lag is intentionally retained because it is not uniquely identifiable
 * from a single closed-loop trace.
 */
export function fit(request: ModelFitRequest): ModelFitResult {
  const medianInterval = validateTrace(request.trace);
  const baseProfile = cloneOvenModelProfile(request.baseProfile ?? DEFAULT_OVEN_PROFILE);
  validateOvenModelProfile(baseProfile);
  const ambientTemperatureC = request.ambientTemperatureC ?? baseProfile.ambientTemperatureC;
  if (!Number.isFinite(ambientTemperatureC)) {
    throw new SimulationDomainError(
      'INVALID_TELEMETRY_TRACE',
      'ambientTemperatureC must be finite.',
      'ambientTemperatureC',
    );
  }
  const first = request.trace[0];
  const last = request.trace[request.trace.length - 1];
  if (first === undefined || last === undefined) {
    throw new SimulationDomainError('INVALID_TELEMETRY_TRACE', 'The telemetry trace is empty.');
  }
  const duration = last.timeSeconds - first.timeSeconds;
  const maximumDeadTime = request.maximumDeadTimeSeconds ?? Math.min(120, duration / 3);
  if (!Number.isFinite(maximumDeadTime) || maximumDeadTime < 0 || maximumDeadTime > duration / 2) {
    throw new SimulationDomainError(
      'INVALID_TELEMETRY_TRACE',
      'maximumDeadTimeSeconds must be non-negative and no more than half the trace duration.',
      'maximumDeadTimeSeconds',
    );
  }

  let best: CandidateFit | null = null;
  const candidateCount = Math.max(1, Math.floor(maximumDeadTime / medianInterval));
  for (let index = 0; index <= candidateCount; index += 1) {
    const deadTimeSeconds = Math.min(maximumDeadTime, index * medianInterval);
    const candidate = fitCandidate(request.trace, ambientTemperatureC, deadTimeSeconds);
    if (candidate !== null && (best === null || candidate.squaredError < best.squaredError)) {
      best = candidate;
    }
  }
  if (best === null) {
    throw new SimulationDomainError(
      'MODEL_FIT_FAILED',
      'The telemetry trace does not contain enough independent information to fit the model.',
      'trace',
    );
  }

  const warnings: string[] = [
    'Sensor lag was retained from the base profile because one closed-loop trace cannot identify it independently.',
  ];
  const topMass = deriveMass(
    best.top.coefficients[0] ?? 0,
    baseProfile.topHeater.watts * baseProfile.topHeater.efficiency,
    baseProfile.thermal.topZoneThermalMassJPerC,
    'Top-zone',
    warnings,
  );
  const bottomMass = deriveMass(
    best.bottom.coefficients[0] ?? 0,
    baseProfile.bottomHeater.watts * baseProfile.bottomHeater.efficiency,
    baseProfile.thermal.bottomZoneThermalMassJPerC,
    'Bottom-zone',
    warnings,
  );
  const enclosureMass = baseProfile.thermal.enclosureThermalMassJPerC;
  const averagePhysicalCoefficient = (firstValue: number, secondValue: number): number =>
    Math.max(0, (firstValue + secondValue) / 2);
  const zoneCoupling = averagePhysicalCoefficient(
    (best.top.coefficients[2] ?? 0) * topMass,
    (best.bottom.coefficients[2] ?? 0) * bottomMass,
  );
  const topEnclosureCoupling = averagePhysicalCoefficient(
    (best.top.coefficients[3] ?? 0) * topMass,
    (best.enclosure.coefficients[1] ?? 0) * enclosureMass,
  );
  const bottomEnclosureCoupling = averagePhysicalCoefficient(
    (best.bottom.coefficients[3] ?? 0) * bottomMass,
    (best.enclosure.coefficients[2] ?? 0) * enclosureMass,
  );

  const profile: OvenModelProfile = {
    ...baseProfile,
    name: `${baseProfile.name} (fitted)`,
    ambientTemperatureC,
    thermal: {
      topZoneThermalMassJPerC: topMass,
      bottomZoneThermalMassJPerC: bottomMass,
      enclosureThermalMassJPerC: enclosureMass,
      topZoneHeatLossWPerC: clamp((best.top.coefficients[1] ?? 0) * topMass, 0, 10_000),
      bottomZoneHeatLossWPerC: clamp((best.bottom.coefficients[1] ?? 0) * bottomMass, 0, 10_000),
      enclosureHeatLossWPerC: clamp(
        (best.enclosure.coefficients[0] ?? 0) * enclosureMass,
        0,
        10_000,
      ),
      zoneCouplingWPerC: clamp(zoneCoupling, 0, 10_000),
      topToEnclosureCouplingWPerC: clamp(topEnclosureCoupling, 0, 10_000),
      bottomToEnclosureCouplingWPerC: clamp(bottomEnclosureCoupling, 0, 10_000),
    },
    actuationDeadTimeSeconds: best.deadTimeSeconds,
  };
  validateOvenModelProfile(profile);

  const temperatures = request.trace.flatMap((point) => [point.t1C, point.t2C]);
  const temperatureSpan = Math.max(...temperatures) - Math.min(...temperatures);
  const rSquared =
    best.totalVariation <= Number.EPSILON
      ? 0
      : clamp(1 - best.squaredError / best.totalVariation, -1, 1);
  const confidence = confidenceFor(rSquared, temperatureSpan);
  if (confidence === 'low') {
    warnings.push(
      'Fit confidence is low; compare this proposal against the recorded trace before use.',
    );
  }

  return {
    profile,
    quality: {
      derivativeRmseCPerSecond: Math.sqrt(best.squaredError / best.count),
      rSquared,
      samplesUsed: request.trace.length,
      estimatedDeadTimeSeconds: best.deadTimeSeconds,
      confidence,
    },
    warnings,
  };
}
