/**
 * Inputs for the deterministic characterization of the legacy v1 dummy MCU.
 *
 * This is reference data, not a supported oven model. In particular, the duty
 * transfer function and heater-cell energy calculation intentionally retain
 * known physical errors from commit 56e7583.
 */
export interface V1ReferenceDutyPoint {
  readonly atSeconds: number;
  readonly dutyFraction: number;
}

export interface V1ReferenceScenario {
  readonly durationSeconds: number;
  readonly sampleEverySeconds: number;
  readonly duty: readonly V1ReferenceDutyPoint[];
}

export interface V1ReferenceSample {
  readonly timeSeconds: number;
  readonly dutyFraction: number;
  readonly sensorC: number;
}

export interface V1ReferenceResult {
  readonly samples: readonly V1ReferenceSample[];
  readonly metrics: {
    readonly finalSensorC: number;
    readonly minimumSensorC: number;
    readonly maximumSensorC: number;
  };
  readonly execution: {
    readonly fixedStepSeconds: number;
    readonly simulatedSteps: number;
    readonly gridCells: number;
  };
}

export interface V1ReferenceTargetPoint {
  readonly atSeconds: number;
  readonly targetC: number;
}

export interface V1ReferenceClosedLoopScenario {
  readonly durationSeconds: number;
  readonly sampleEverySeconds: number;
  readonly targets: readonly V1ReferenceTargetPoint[];
}

export interface V1ReferenceClosedLoopSample {
  readonly timeSeconds: number;
  readonly targetC: number;
  readonly sensorC: number;
  /** Controller output calculated at this timestamp for the following plant step. */
  readonly powerByte: number;
}

export interface V1ReferenceClosedLoopResult {
  readonly samples: readonly V1ReferenceClosedLoopSample[];
  readonly metrics: {
    readonly finalSensorC: number;
    readonly minimumSensorC: number;
    readonly maximumSensorC: number;
    readonly minimumPowerByte: number;
    readonly maximumPowerByte: number;
  };
  readonly execution: {
    readonly fixedStepSeconds: number;
    readonly simulatedSteps: number;
    readonly callbackOrder: 'plant-then-controller';
  };
}
