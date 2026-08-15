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
  readonly outputMinimum: number;
  readonly outputMaximum: number;
  readonly integralMinimum: number;
  readonly integralMaximum: number;
  readonly derivativeFilterSeconds: number;
}

export interface PidControllerState {
  readonly integralTerm: number;
  readonly previousMeasurementC: number;
  readonly filteredDerivativeCPerSecond: number;
  readonly activeGains: PidGains;
}

export interface PidStepInput {
  readonly setpointC: number;
  readonly measurementC: number;
  readonly stepSeconds: number;
}

export interface PidTerms {
  readonly proportional: number;
  readonly integral: number;
  readonly derivative: number;
}

export interface PidStepResult {
  readonly output: number;
  readonly terms: PidTerms;
  readonly gains: PidGains;
  readonly state: PidControllerState;
}

export type ControlMode = 'pid' | 'model-assisted-pid';

export interface ModelAssistedTargetConfiguration {
  readonly heatingRampCPerMinute: number;
  readonly coolingRampCPerMinute: number;
  readonly predictionHorizonSeconds: number;
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
