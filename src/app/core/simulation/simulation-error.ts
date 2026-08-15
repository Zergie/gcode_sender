export type SimulationErrorCode =
  | 'INVALID_MODEL_PROFILE'
  | 'INVALID_SIMULATION_REQUEST'
  | 'SIMULATION_LIMIT_EXCEEDED'
  | 'INVALID_COMPARISON_REQUEST'
  | 'INVALID_TELEMETRY_TRACE'
  | 'MODEL_FIT_FAILED';

/** A stable, caller-facing failure raised by the simulation module. */
export class SimulationDomainError extends Error {
  readonly code: SimulationErrorCode;
  readonly path?: string;

  constructor(code: SimulationErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'SimulationDomainError';
    this.code = code;
    this.path = path;
  }
}
