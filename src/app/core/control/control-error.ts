export type ControlErrorCode =
  'INVALID_PID_SCHEDULE' | 'INVALID_PID_CONFIGURATION' | 'INVALID_TARGET_SHAPER_CONFIGURATION';

/** A caller-facing validation error raised at the control-domain seam. */
export class ControlDomainError extends Error {
  readonly code: ControlErrorCode;
  readonly path?: string;

  constructor(code: ControlErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'ControlDomainError';
    this.code = code;
    this.path = path;
  }
}
