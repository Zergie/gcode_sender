import type { TrendPoint } from '../../core/platform/workbench.store';
import type { SimulationComparisonResult, SimulationSample } from '../../core/simulation';

const SIMULATION_TREND_ORIGIN_MS = Date.UTC(2026, 7, 15, 12, 0, 0);

export interface PreparedSimulationChartSeriesEntry {
  readonly id: string;
  readonly points: readonly TrendPoint[];
}

export interface PreparedSimulationChartSeries {
  readonly entries: readonly PreparedSimulationChartSeriesEntry[];
}

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
