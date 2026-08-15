import type { AppErrorInfo } from './errors';

export interface PidGains {
  readonly kp: number;
  readonly ki: number;
  readonly kd: number;
}

export interface LiveTuningRequest {
  readonly targets: readonly number[];
  readonly hysteresis?: number;
  readonly peakCount?: number;
  readonly sampleIntervalMs?: number;
  readonly stageTimeoutMs?: number;
  readonly relayKp?: number;
  readonly maximumTarget?: number;
  readonly maximumSensorDifference?: number;
}

export interface TuningPeak {
  readonly temperature: number;
  readonly elapsedSeconds: number;
  readonly phase: 'heating' | 'cooling';
}

export interface TuningCandidate {
  readonly method: 'klipper-ziegler-nichols' | 'conservative';
  readonly gains: PidGains;
  readonly ku: number;
  readonly tuSeconds: number;
}

export interface TuningBreakpointResult {
  readonly target: number;
  readonly peaks: readonly TuningPeak[];
  readonly candidates: readonly TuningCandidate[];
}

export type LiveTuningStatus =
  | 'idle'
  | 'snapshotting'
  | 'heating'
  | 'cooling'
  | 'rolling-back'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface LiveTuningState {
  readonly id: string | null;
  readonly status: LiveTuningStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly currentTarget: number | null;
  readonly currentBreakpointIndex: number;
  readonly peaksCollected: number;
  readonly peakGoal: number;
  readonly rollbackGains: PidGains | null;
  readonly results: readonly TuningBreakpointResult[];
  readonly error: AppErrorInfo | null;
}
