import { describe, expect, it } from 'vitest';

import { V1_PID_REFERENCE, V1ReferencePidController, simulateV1ClosedLoop } from './closed-loop';
import { V1_REFERENCE_CLOSED_LOOP_FIXTURES } from './closed-loop.fixtures';

// The literal 24,960-cell v1 solver is intentionally expensive. Keep enough
// headroom for concurrent renderer workers without relaxing any golden values.
const V1_REFERENCE_FIXTURE_TIMEOUT_MS = 15_000;

function expectCloseTrace(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((expectedValue, index) => {
    expect(actual[index]).toBeCloseTo(expectedValue, 8);
  });
}

describe('v1 deterministic closed-loop reference', () => {
  it('pins the exact historical package, gains, mistaken dt, and callback order', () => {
    expect(V1_PID_REFERENCE.package).toBe('node-pid-controller@1.0.1');
    expect(V1_PID_REFERENCE.integrity).toBe(
      'sha512-36gdeRz2emhIsznLpXksJSqmR13NU3vR+rkRlfHWCGGlZu9fK+dcTPRpud0FiH6b2Nhwm0kbcVk7vXFlg8Sw1w==',
    );
    expect(V1_PID_REFERENCE.gains).toEqual({
      proportional: 0.7,
      integral: 0.00004,
      derivative: 120,
    });
    expect(V1_PID_REFERENCE.controllerDt).toBe(100);
    expect(V1_PID_REFERENCE.callbackOrder).toBe('plant-then-controller');
  });

  it('matches node-pid-controller 1.0.1 arithmetic with the v1 constructor values', () => {
    const controller = new V1ReferencePidController();
    controller.setTarget(100);

    expect(controller.update(22)).toBeCloseTo(148.512, 12);
    expect(controller.sumError).toBe(7_800);
    expect(controller.update(22)).toBeCloseTo(55.224, 12);
    expect(controller.sumError).toBe(15_600);
  });

  it.each(V1_REFERENCE_CLOSED_LOOP_FIXTURES)(
    'matches the compact $name fixture',
    (fixture) => {
      const result = simulateV1ClosedLoop(fixture.scenario);

      expect(result.samples.map((sample) => sample.timeSeconds)).toEqual(
        fixture.expectedTimeSeconds,
      );
      expect(result.samples.map((sample) => sample.targetC)).toEqual(fixture.expectedTargetC);
      expectCloseTrace(
        result.samples.map((sample) => sample.sensorC),
        fixture.expectedSensorC,
      );
      expectCloseTrace(
        result.samples.map((sample) => sample.powerByte),
        fixture.expectedPowerByte,
      );
      expect(result.metrics.finalSensorC).toBeCloseTo(fixture.expectedMetrics.finalSensorC, 8);
      expect(result.metrics.minimumSensorC).toBeCloseTo(fixture.expectedMetrics.minimumSensorC, 8);
      expect(result.metrics.maximumSensorC).toBeCloseTo(fixture.expectedMetrics.maximumSensorC, 8);
      expect(result.metrics.minimumPowerByte).toBeCloseTo(
        fixture.expectedMetrics.minimumPowerByte,
        8,
      );
      expect(result.metrics.maximumPowerByte).toBeCloseTo(
        fixture.expectedMetrics.maximumPowerByte,
        8,
      );
      expect(result.execution.callbackOrder).toBe('plant-then-controller');
    },
    V1_REFERENCE_FIXTURE_TIMEOUT_MS,
  );

  it('is deterministic for an exact target-command schedule', () => {
    const scenario = {
      durationSeconds: 10,
      sampleEverySeconds: 1,
      targets: [
        { atSeconds: 0, targetC: 100 },
        { atSeconds: 5, targetC: 0 },
      ],
    } as const;

    expect(simulateV1ClosedLoop(scenario)).toEqual(simulateV1ClosedLoop(scenario));
  });
});
