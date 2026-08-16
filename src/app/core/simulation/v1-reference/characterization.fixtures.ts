import type { V1ReferenceScenario } from './types';

export interface V1ReferenceCharacterizationFixture {
  readonly name: string;
  readonly scenario: V1ReferenceScenario;
  readonly expectedTimeSeconds: readonly number[];
  readonly expectedDutyFraction: readonly number[];
  readonly expectedSensorC: readonly number[];
  readonly expectedMetrics: {
    readonly finalSensorC: number;
    readonly minimumSensorC: number;
    readonly maximumSensorC: number;
  };
}

const AMBIENT_TRACE = [22, 22, 22, 22, 22] as const;
const SHORT_TRACE_TIMES = [0, 15, 30, 45, 60] as const;

// In v1, every one of these positive duties drives the heater cells into their
// 1,200 C cap on the first step. Their sampled traces are consequently equal.
// Keeping a shared fixture makes that historical defect visible rather than
// accidentally presenting the values as a realistic actuator response.
const SATURATED_HEAT_TRACE = [
  22, 99.513119712, 134.959411825, 148.467522556, 153.573833647,
] as const;

const SATURATED_HEAT_METRICS = {
  finalSensorC: 153.573833647,
  minimumSensorC: 22,
  maximumSensorC: 153.573833647,
} as const;

function openLoopFixture(
  name: string,
  dutyFraction: number,
  expectedSensorC: readonly number[],
  expectedMetrics: V1ReferenceCharacterizationFixture['expectedMetrics'],
): V1ReferenceCharacterizationFixture {
  return {
    name,
    scenario: {
      durationSeconds: 60,
      sampleEverySeconds: 15,
      duty: [{ atSeconds: 0, dutyFraction }],
    },
    expectedTimeSeconds: SHORT_TRACE_TIMES,
    expectedDutyFraction: SHORT_TRACE_TIMES.map(() => dutyFraction),
    expectedSensorC,
    expectedMetrics,
  };
}

/**
 * Compact golden traces from the deterministic port of v1 commit 56e7583.
 * Values are rounded to 1e-9 C so fixtures are robust to libm differences.
 */
export const V1_REFERENCE_CHARACTERIZATION_FIXTURES: readonly V1ReferenceCharacterizationFixture[] =
  [
    openLoopFixture('0% direct duty', 0, AMBIENT_TRACE, {
      finalSensorC: 22,
      minimumSensorC: 22,
      maximumSensorC: 22,
    }),
    openLoopFixture('25% direct duty', 0.25, SATURATED_HEAT_TRACE, SATURATED_HEAT_METRICS),
    openLoopFixture('50% direct duty', 0.5, SATURATED_HEAT_TRACE, SATURATED_HEAT_METRICS),
    openLoopFixture('100% direct duty', 1, SATURATED_HEAT_TRACE, SATURATED_HEAT_METRICS),
    {
      name: '100% heat for 300 s, then cooldown for 300 s',
      scenario: {
        durationSeconds: 600,
        sampleEverySeconds: 60,
        duty: [
          { atSeconds: 0, dutyFraction: 1 },
          { atSeconds: 300, dutyFraction: 0 },
        ],
      },
      expectedTimeSeconds: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600],
      expectedDutyFraction: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
      expectedSensorC: [
        22, 153.573833647, 158.41255351, 160.959445516, 163.40828375, 165.783177045, 46.714488826,
        43.482777647, 42.611737609, 41.807878288, 41.034683812,
      ],
      expectedMetrics: {
        finalSensorC: 41.034683812,
        minimumSensorC: 22,
        maximumSensorC: 165.808653605,
      },
    },
  ] as const;
