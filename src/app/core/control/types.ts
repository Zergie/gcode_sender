export interface PidGains {
  readonly kp: number;
  readonly ki: number;
  readonly kd: number;
}

export interface PidBreakpoint {
  readonly temperatureC: number;
  readonly gains: PidGains;
}

/** Breakpoints are ordered by strictly increasing temperature. */
export type PidSchedule = readonly PidBreakpoint[];

export interface PidControllerConfiguration {
  readonly schedule: PidSchedule;
  readonly gainTransitionSeconds: number;
}

export interface PidTerms {
  readonly proportional: number;
  readonly integral: number;
  readonly derivative: number;
}

export type ControlMode = 'pid' | 'model-assisted-pid';

export interface ModelAssistedTargetConfiguration {
  /** Length of each forked physical-twin/firmware forecast. */
  readonly predictionHorizonSeconds: number;
  /** Whole-degree candidate commands are searched within this distance of the requested target. */
  readonly maximumTargetLeadC: number;
  readonly minimumCommandC: number;
  readonly maximumCommandC: number;
}

export interface TargetShaperState {
  readonly trajectoryTargetC: number;
  readonly firmwareTargetC: number;
}

export interface TargetShaperStepResult {
  readonly requestedTargetC: number;
  readonly trajectoryTargetC: number;
  readonly firmwareTargetC: number;
  readonly trajectoryRateCPerSecond: number;
  readonly targetLeadC: number;
  readonly state: TargetShaperState;
}
