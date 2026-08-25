export type AppErrorCode =
  | 'BUSY'
  | 'CATALOG_APPROVAL_REQUIRED'
  | 'CATALOG_FETCH_FAILED'
  | 'CATALOG_INVALID'
  | 'FILE_INVALID'
  | 'FILE_LINE_TOO_LONG'
  | 'FILE_NOT_FOUND'
  | 'INTERNAL'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'IPC_FAILED'
  | 'NOT_CONNECTED'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'SERIAL_CONNECTION_FAILED'
  | 'SERIAL_DISCONNECTED'
  | 'SERIAL_HANDSHAKE_FAILED'
  | 'SERIAL_WRITE_FAILED'
  | 'STORAGE_FAILED'
  | 'TIMEOUT';

export interface AppErrorInfo {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ApiResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppErrorInfo };

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly recoverable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(info: AppErrorInfo, options?: ErrorOptions) {
    super(info.message, options);
    this.name = 'AppError';
    this.code = info.code;
    this.recoverable = info.recoverable;
    this.details = info.details;
  }

  toInfo(): AppErrorInfo {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function asAppError(error: unknown, fallbackCode: AppErrorCode = 'INTERNAL'): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(
      {
        code: fallbackCode,
        message: error.message,
        recoverable: fallbackCode !== 'INTERNAL',
      },
      { cause: error },
    );
  }

  return new AppError({
    code: fallbackCode,
    message: String(error),
    recoverable: fallbackCode !== 'INTERNAL',
  });
}

export function success<T>(value: T): ApiResult<T> {
  return { ok: true, value };
}

export function failure(error: unknown, fallbackCode: AppErrorCode = 'INTERNAL'): ApiResult<never> {
  return { ok: false, error: asAppError(error, fallbackCode).toInfo() };
}
