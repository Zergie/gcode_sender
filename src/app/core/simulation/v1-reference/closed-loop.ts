import { V1_REFERENCE_CONSTANTS, V1ReferencePlant } from './plant';
import type {
  V1ReferenceClosedLoopResult,
  V1ReferenceClosedLoopSample,
  V1ReferenceClosedLoopScenario,
} from './types';

/**
 * Exact historical controller provenance.
 *
 * Commit 56e7583's package-lock.json pins this tarball and integrity. The
 * source was verified against that tarball before transcribing its arithmetic.
 */
export const V1_PID_REFERENCE = {
  package: 'node-pid-controller@1.0.1',
  integrity:
    'sha512-36gdeRz2emhIsznLpXksJSqmR13NU3vR+rkRlfHWCGGlZu9fK+dcTPRpud0FiH6b2Nhwm0kbcVk7vXFlg8Sw1w==',
  gains: { proportional: 0.7, integral: 0.00004, derivative: 120 },
  controllerDt: 100,
  outputMinimum: 0,
  outputMaximum: 255,
  callbackOrder: 'plant-then-controller',
} as const;

/** Formula-equivalent implementation of the pinned node-pid-controller 1.0.1. */
export class V1ReferencePidController {
  sumError = 0;
  lastError = 0;
  targetC = 0;

  setTarget(targetC: number): void {
    this.targetC = targetC;
  }

  update(currentC: number): number {
    const dt = V1_PID_REFERENCE.controllerDt;
    const error = this.targetC - currentC;
    this.sumError += error * dt;
    const errorDerivative = (error - this.lastError) / dt;
    this.lastError = error;
    const gains = V1_PID_REFERENCE.gains;
    return (
      gains.proportional * error +
      gains.integral * this.sumError +
      gains.derivative * errorDerivative
    );
  }
}

function validateClosedLoopScenario(scenario: V1ReferenceClosedLoopScenario): void {
  const dt = V1_REFERENCE_CONSTANTS.fixedStepSeconds;
  if (!Number.isFinite(scenario.durationSeconds) || scenario.durationSeconds < 0) {
    throw new RangeError('v1 closed-loop duration must be a non-negative finite number');
  }
  if (!Number.isFinite(scenario.sampleEverySeconds) || scenario.sampleEverySeconds <= 0) {
    throw new RangeError('v1 closed-loop sample interval must be a positive finite number');
  }
  if (
    Math.abs(scenario.durationSeconds / dt - Math.round(scenario.durationSeconds / dt)) > 1e-9 ||
    Math.abs(scenario.sampleEverySeconds / dt - Math.round(scenario.sampleEverySeconds / dt)) > 1e-9
  ) {
    throw new RangeError('v1 closed-loop timing must align with the fixed 0.1 s step');
  }
  if (scenario.targets.length === 0 || scenario.targets[0]?.atSeconds !== 0) {
    throw new RangeError('v1 closed-loop target schedule must start at 0 s');
  }

  let previousTime = -Infinity;
  for (const target of scenario.targets) {
    if (
      !Number.isFinite(target.atSeconds) ||
      target.atSeconds < 0 ||
      target.atSeconds > scenario.durationSeconds ||
      target.atSeconds <= previousTime ||
      Math.abs(target.atSeconds / dt - Math.round(target.atSeconds / dt)) > 1e-9 ||
      !Number.isFinite(target.targetC)
    ) {
      throw new RangeError('v1 closed-loop targets must be finite, ordered, and step-aligned');
    }
    previousTime = target.atSeconds;
  }
}

function clampPowerByte(powerByte: number): number {
  return Math.min(
    V1_PID_REFERENCE.outputMaximum,
    Math.max(V1_PID_REFERENCE.outputMinimum, powerByte),
  );
}

/**
 * Executes the v1 dummy MCU without wall-clock jitter or sensor noise.
 *
 * The old initializer registered the simulation's 100 ms interval before the
 * controller's 100 ms interval. This runner therefore advances the plant with
 * the previous power, reads the sensor, then calculates power for the next
 * step. Target points model an M104 command delivered at an exact step boundary.
 */
export function simulateV1ClosedLoop(
  scenario: V1ReferenceClosedLoopScenario,
): V1ReferenceClosedLoopResult {
  validateClosedLoopScenario(scenario);
  const dt = V1_REFERENCE_CONSTANTS.fixedStepSeconds;
  const stepCount = Math.round(scenario.durationSeconds / dt);
  const sampleStepCount = Math.round(scenario.sampleEverySeconds / dt);
  const controller = new V1ReferencePidController();
  const plant = new V1ReferencePlant();
  const firstTargetC = scenario.targets[0]?.targetC ?? 0;
  controller.setTarget(firstTargetC);

  const samples: V1ReferenceClosedLoopSample[] = [
    { timeSeconds: 0, targetC: firstTargetC, sensorC: plant.sensorC, powerByte: 0 },
  ];
  let targetIndex = 0;
  let powerByte = 0;
  let minimumSensorC = plant.sensorC;
  let maximumSensorC = plant.sensorC;
  let minimumPowerByte = powerByte;
  let maximumPowerByte = powerByte;

  for (let step = 0; step < stepCount; step += 1) {
    const atSeconds = step * dt;
    while (
      targetIndex + 1 < scenario.targets.length &&
      atSeconds >= (scenario.targets[targetIndex + 1]?.atSeconds ?? Infinity) - 1e-9
    ) {
      targetIndex += 1;
      controller.setTarget(scenario.targets[targetIndex]?.targetC ?? controller.targetC);
    }

    // Registration order in dummy-mcu/main.js: simulation interval, then PID interval.
    const sensorC = plant.step(powerByte / V1_PID_REFERENCE.outputMaximum);
    powerByte = clampPowerByte(controller.update(sensorC));
    minimumSensorC = Math.min(minimumSensorC, sensorC);
    maximumSensorC = Math.max(maximumSensorC, sensorC);
    minimumPowerByte = Math.min(minimumPowerByte, powerByte);
    maximumPowerByte = Math.max(maximumPowerByte, powerByte);

    if ((step + 1) % sampleStepCount === 0 || step + 1 === stepCount) {
      samples.push({
        timeSeconds: (step + 1) * dt,
        targetC: controller.targetC,
        sensorC,
        powerByte,
      });
    }
  }

  return {
    samples,
    metrics: {
      finalSensorC: plant.sensorC,
      minimumSensorC,
      maximumSensorC,
      minimumPowerByte,
      maximumPowerByte,
    },
    execution: {
      fixedStepSeconds: dt,
      simulatedSteps: stepCount,
      callbackOrder: V1_PID_REFERENCE.callbackOrder,
    },
  };
}
