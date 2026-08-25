import type { TrendPoint } from '../../core/platform/workbench.store';
import type { SimulationComparisonResult, SimulationSample } from '../../core/simulation';

export const SIMULATION_TREND_ORIGIN_MS = Date.UTC(2026, 7, 15, 12, 0, 0);

export interface PreparedSimulationChartSeriesEntry {
  readonly id: string;
  readonly points: readonly TrendPoint[];
}

export interface PreparedSimulationChartSeries {
  readonly entries: readonly PreparedSimulationChartSeriesEntry[];
}

export const SIMULATION_CHART_OVERSAMPLING_FACTOR = 1.5;

const CHART_FIELDS = ['average', 't1', 't2', 't3', 'target', 'modelTarget', 'power'] as const;

function toTrendPoint(sample: SimulationSample): TrendPoint {
  return Object.freeze({
    time: SIMULATION_TREND_ORIGIN_MS + sample.timeSeconds * 1000,
    average: sample.temperatures.t0C,
    t1: sample.temperatures.t1C,
    t2: sample.temperatures.t2C,
    t3: sample.temperatures.t3C,
    target: sample.requestedTargetC,
    modelTarget: sample.firmwareTargetC,
    power: sample.actuator.pidOutput,
  });
}

/**
 * Converts every variant once into frozen chart points. The input result is
 * never changed, so callers can safely memoize this value by result identity.
 */
export function prepareSimulationChartSeries(
  comparison: SimulationComparisonResult,
): PreparedSimulationChartSeries {
  const entries = comparison.entries.map((entry) =>
    Object.freeze({
      id: entry.id,
      points: Object.freeze(entry.result.samples.map(toTrendPoint)),
    }),
  );
  return Object.freeze({ entries: Object.freeze(entries) });
}

/**
 * Selects one shared set of sample indexes for every comparison variant.
 * Buckets retain their boundary samples and the extrema of each plotted field,
 * so compression follows plot width without making variants drift apart.
 */
export function decimateSimulationChartSeries(
  prepared: PreparedSimulationChartSeries,
  plotWidth: number,
): PreparedSimulationChartSeries {
  const firstLength = prepared.entries[0]?.points.length ?? 0;
  const limit = Math.max(
    2,
    Math.ceil(Math.max(1, plotWidth) * SIMULATION_CHART_OVERSAMPLING_FACTOR),
  );
  if (firstLength <= limit || prepared.entries.length === 0) return prepared;

  const indexes = new Set<number>([0, firstLength - 1]);
  const bucketCount = Math.max(1, Math.floor(limit / 2));
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor((bucket * firstLength) / bucketCount);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * firstLength) / bucketCount));
    indexes.add(start);
    indexes.add(Math.min(firstLength - 1, end - 1));
    for (const field of CHART_FIELDS) {
      let minimumIndex = start;
      let maximumIndex = start;
      for (let index = start + 1; index < end && index < firstLength; index += 1) {
        const point = prepared.entries[0]!.points[index]!;
        const minimum = prepared.entries[0]!.points[minimumIndex]!;
        const maximum = prepared.entries[0]!.points[maximumIndex]!;
        if (point[field] < minimum[field]) minimumIndex = index;
        if (point[field] > maximum[field]) maximumIndex = index;
      }
      indexes.add(minimumIndex);
      indexes.add(maximumIndex);
      for (const entry of prepared.entries.slice(1)) {
        for (let index = start; index < end && index < entry.points.length; index += 1) {
          const point = entry.points[index]!;
          const minimum = entry.points[minimumIndex] ?? point;
          const maximum = entry.points[maximumIndex] ?? point;
          if (point[field] < minimum[field]) minimumIndex = index;
          if (point[field] > maximum[field]) maximumIndex = index;
        }
        indexes.add(minimumIndex);
        indexes.add(maximumIndex);
      }
    }
  }
  const sortedIndexes = [...indexes].sort((left, right) => left - right);
  const selected =
    sortedIndexes.length <= limit
      ? sortedIndexes
      : [
          sortedIndexes[0]!,
          ...sortedIndexes.slice(1, limit - 1),
          sortedIndexes[sortedIndexes.length - 1]!,
        ];
  return Object.freeze({
    entries: Object.freeze(
      prepared.entries.map((entry) =>
        Object.freeze({
          id: entry.id,
          points: Object.freeze(selected.map((index) => entry.points[index]!).filter(Boolean)),
        }),
      ),
    ),
  });
}
