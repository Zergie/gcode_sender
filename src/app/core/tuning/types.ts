import type { PidGains } from '../control/types';

export type { PidGains };

export interface M105Telemetry {
  readonly atMs: number;
  readonly t0C: number;
  readonly t1C: number;
  readonly t2C: number;
  readonly t3C: number;
  readonly reportedTargetC: number;
  readonly output: number;
  readonly raw?: string;
}

export type RelayDirection = 'heating' | 'cooling';
export type RelayPeakKind = 'high' | 'low';

export interface RelayPeak {
  readonly kind: RelayPeakKind;
  readonly temperatureC: number;
  readonly atMs: number;
}

export interface RelayCycleEstimate {
  readonly peakIndex: number;
  readonly amplitudeC: number;
  readonly periodSeconds: number;
}

export interface DerivedPidGains {
  /** Firmware-ready gains for QuickPID's 0..255 output range. */
  readonly quickPid: PidGains;
  /** A lower-aggression Tyreus-Luyben alternative, also QuickPID-ready. */
  readonly conservative: PidGains;
  readonly ultimateGain: number;
  readonly ultimatePeriodSeconds: number;
  readonly temperatureAmplitudeC: number;
  readonly selectedCycle: RelayCycleEstimate;
}

export interface CalibrationDraft {
  readonly status: 'draft';
  readonly source: 'klipper-style-relay-autotune';
  readonly createdAtMs: number;
  readonly targetC: number;
  readonly originalGains: PidGains;
  readonly suggested: DerivedPidGains;
  readonly peaks: readonly RelayPeak[];
  readonly sampleCount: number;
  readonly notes: readonly string[];
}

export interface CalibrationLimits {
  readonly maximumTemperatureC: number;
  readonly maximumDurationMs: number;
  readonly telemetryTimeoutMs: number;
  readonly maximumSensorSpreadC: number;
  readonly t3MinimumC: number;
  readonly t3MaximumC: number;
  readonly actuatorGraceMs: number;
  readonly maximumActuatorViolations: number;
  readonly highOutputMinimum: number;
  readonly lowOutputMaximum: number;
  readonly minimumPeakSwingC: number;
  readonly maximumSamples: number;
}

export interface CalibrationOptions {
  readonly targetC: number;
  readonly relayKp?: number;
  readonly telemetryPollMs?: number;
  readonly limits?: Partial<CalibrationLimits>;
}

export interface ResolvedCalibrationOptions {
  readonly targetC: number;
  readonly lowTargetC: number;
  readonly relayKp: number;
  readonly telemetryPollMs: number;
  readonly requiredPeakCount: 12;
  readonly limits: CalibrationLimits;
}

export type CalibrationPhase =
  | 'idle'
  | 'snapshotting'
  | 'configuring-relay'
  | 'setting-initial-target'
  | 'running'
  | 'disarming-relay'
  | 'setting-zero-target'
  | 'confirming-zero'
  | 'restoring-gains'
  | 'completed'
  | 'cancelled'
  | 'faulted';

export type CalibrationFaultCode =
  | 'PID_SNAPSHOT_UNAVAILABLE'
  | 'COMMAND_REJECTED'
  | 'COMMAND_TIMEOUT'
  | 'DURATION_LIMIT'
  | 'TELEMETRY_TIMEOUT'
  | 'INVALID_TELEMETRY'
  | 'NON_MONOTONIC_TELEMETRY'
  | 'MAXIMUM_TEMPERATURE'
  | 'SENSOR_SPREAD'
  | 'T3_OUT_OF_BOUNDS'
  | 'ACTUATOR_MISMATCH'
  | 'INSUFFICIENT_OSCILLATION'
  | 'ZERO_CONFIRMATION_TIMEOUT'
  | 'RESTORE_FAILED'
  | 'DISCONNECTED';

export interface CalibrationFault {
  readonly code: CalibrationFaultCode;
  readonly message: string;
  /** These faults describe host-side experiment integrity, not firmware safety. */
  readonly scope: 'experiment-integrity';
  readonly atMs: number;
}

export type CalibrationOutcome = 'completed' | 'cancelled' | 'faulted';

export interface TerminalIntent {
  readonly outcome: CalibrationOutcome;
  readonly reason?: string;
  readonly fault?: CalibrationFault;
}

export type CalibrationCommandPurpose =
  | 'snapshot'
  | 'configure-relay'
  | 'set-initial-target'
  | 'switch-high'
  | 'switch-low'
  | 'poll-telemetry'
  | 'disarm-relay'
  | 'set-zero-target'
  | 'confirm-zero'
  | 'restore-gains';

export interface OutstandingCommand {
  readonly id: number;
  readonly command: string;
  readonly purpose: Exclude<
    CalibrationCommandPurpose,
    'snapshot' | 'poll-telemetry' | 'confirm-zero'
  >;
  readonly sentAtMs: number;
}

export interface PeakTracker {
  readonly direction: RelayDirection;
  readonly directionChangedAtMs: number;
  readonly extremeTemperatureC?: number;
  readonly extremeAtMs?: number;
  readonly completedCoolingSegment: boolean;
}

export interface CalibrationState {
  readonly phase: CalibrationPhase;
  readonly options: ResolvedCalibrationOptions;
  readonly startedAtMs?: number;
  readonly lastTelemetryAtMs?: number;
  readonly nextPollAtMs?: number;
  readonly actionStartedAtMs?: number;
  readonly snapshot: Partial<PidGains>;
  readonly originalGains?: PidGains;
  readonly relayMayBeConfigured: boolean;
  readonly tracker?: PeakTracker;
  readonly peaks: readonly RelayPeak[];
  readonly samples: readonly M105Telemetry[];
  readonly consecutiveActuatorViolations: number;
  readonly commandSequence: number;
  readonly outstandingCommands: readonly OutstandingCommand[];
  readonly terminalIntent?: TerminalIntent;
  readonly draft?: CalibrationDraft;
  readonly fault?: CalibrationFault;
}

export type CalibrationEvent =
  | { readonly type: 'start'; readonly atMs: number }
  | { readonly type: 'protocol-line'; readonly atMs: number; readonly line: string }
  | { readonly type: 'telemetry'; readonly sample: M105Telemetry }
  | { readonly type: 'command-accepted'; readonly atMs: number; readonly commandId: number }
  | {
      readonly type: 'command-rejected';
      readonly atMs: number;
      readonly commandId: number;
      readonly message: string;
    }
  | { readonly type: 'snapshot-complete'; readonly atMs: number }
  | { readonly type: 'tick'; readonly atMs: number }
  | { readonly type: 'cancel'; readonly atMs: number; readonly reason?: string }
  | { readonly type: 'disconnected'; readonly atMs: number };

export type CalibrationEffect =
  | {
      readonly type: 'send-gcode';
      readonly commandId: number;
      readonly command: string;
      readonly purpose: CalibrationCommandPurpose;
      readonly expectsAcknowledgement: boolean;
    }
  | {
      readonly type: 'notice';
      readonly level: 'info' | 'warning' | 'error';
      readonly code: string;
      readonly message: string;
    }
  | { readonly type: 'draft-ready'; readonly draft: CalibrationDraft };

export interface CalibrationTransition {
  readonly state: CalibrationState;
  readonly effects: readonly CalibrationEffect[];
}

export interface ValidationLimits {
  readonly settlingBandC: number;
  readonly settlingHoldMs: number;
  readonly steadyStateWindowMs: number;
  readonly maximumOvershootC: number;
  readonly maximumSteadyStateErrorC: number;
  readonly maximumSensorSpreadC: number;
}

export interface ValidationMetrics {
  readonly targetC: number;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly riseTimeMs?: number;
  readonly settlingTimeMs?: number;
  readonly overshootC: number;
  readonly undershootC: number;
  readonly steadyStateErrorC: number;
  readonly integralAbsoluteErrorCSeconds: number;
  readonly maximumSensorSpreadC: number;
  readonly t3RangeC: readonly [number, number];
  readonly meanOutputPercent: number;
  readonly passed: boolean;
}
