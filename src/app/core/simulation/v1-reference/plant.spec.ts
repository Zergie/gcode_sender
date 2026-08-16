import { describe, expect, it } from 'vitest';

import { V1_REFERENCE_CHARACTERIZATION_FIXTURES } from './characterization.fixtures';
import {
  V1_REFERENCE_COMMIT,
  V1_REFERENCE_CONSTANTS,
  simulateV1Reference,
  v1ReferenceActuatorGain,
} from './plant';

function expectCloseTrace(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((expectedC, index) => {
    expect(actual[index]).toBeCloseTo(expectedC, 8);
  });
}

describe('v1 deterministic characterization reference', () => {
  it('identifies its source and preserves the legacy nonlinear actuator', () => {
    expect(V1_REFERENCE_COMMIT).toBe('56e7583');
    expect(V1_REFERENCE_CONSTANTS.fixedStepSeconds).toBe(0.1);
    expect(v1ReferenceActuatorGain(0)).toBe(0);
    expect(v1ReferenceActuatorGain(0.25)).toBeCloseTo(0.12240395925452296, 14);
    expect(v1ReferenceActuatorGain(0.5)).toBeCloseTo(0.479425538604203, 14);
    expect(v1ReferenceActuatorGain(1)).toBeCloseTo(1.0914709848078965, 14);
    expect(v1ReferenceActuatorGain(1)).toBeGreaterThan(1);
  });

  it.each(V1_REFERENCE_CHARACTERIZATION_FIXTURES)(
    'matches the compact $name fixture',
    (fixture) => {
      const result = simulateV1Reference(fixture.scenario);

      expect(result.samples.map((sample) => sample.timeSeconds)).toEqual(
        fixture.expectedTimeSeconds,
      );
      expect(result.samples.map((sample) => sample.dutyFraction)).toEqual(
        fixture.expectedDutyFraction,
      );
      expectCloseTrace(
        result.samples.map((sample) => sample.sensorC),
        fixture.expectedSensorC,
      );
      expect(result.metrics.finalSensorC).toBeCloseTo(fixture.expectedMetrics.finalSensorC, 8);
      expect(result.metrics.minimumSensorC).toBeCloseTo(fixture.expectedMetrics.minimumSensorC, 8);
      expect(result.metrics.maximumSensorC).toBeCloseTo(fixture.expectedMetrics.maximumSensorC, 8);
      expect(result.execution.fixedStepSeconds).toBe(0.1);
      expect(result.execution.simulatedSteps).toBe(
        Math.round(fixture.scenario.durationSeconds / 0.1),
      );
      expect(result.execution.gridCells).toBe(24_960);
    },
  );

  it('is bit-for-bit deterministic without timer jitter or sensor noise', () => {
    const scenario = V1_REFERENCE_CHARACTERIZATION_FIXTURES[3]?.scenario;
    expect(scenario).toBeDefined();
    if (!scenario) {
      return;
    }

    expect(simulateV1Reference(scenario)).toEqual(simulateV1Reference(scenario));
  });

  it('records the legacy first-step heater-cap collapse at 25%, 50%, and 100% duty', () => {
    const traces = [0.25, 0.5, 1].map((dutyFraction) =>
      simulateV1Reference({
        durationSeconds: 15,
        sampleEverySeconds: 15,
        duty: [{ atSeconds: 0, dutyFraction }],
      }).samples.map((sample) => sample.sensorC),
    );

    expect(traces[1]).toEqual(traces[0]);
    expect(traces[2]).toEqual(traces[0]);
  });
});
