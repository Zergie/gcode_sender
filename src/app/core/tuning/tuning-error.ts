export type TuningErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'PID_SNAPSHOT_UNAVAILABLE'
  | 'INVALID_TELEMETRY'
  | 'INVALID_PEAKS'
  | 'INVALID_VALIDATION_TRACE';

export class TuningDomainError extends Error {
  constructor(
    readonly code: TuningErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'TuningDomainError';
  }
}
