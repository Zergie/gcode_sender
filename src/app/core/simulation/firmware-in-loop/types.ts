import type {
  FirmwareWasmArtifact,
  VirtualHardwareConfiguration,
} from '../../../../../shared/firmware-contracts';

export type FirmwareThermistorId = 't1' | 't2' | 't3';

export interface FirmwareSensorTemperatures {
  readonly t1: number;
  readonly t2: number;
  readonly t3: number;
}

export interface FirmwareInLoopLoad {
  readonly artifact: FirmwareWasmArtifact;
  readonly hardware: VirtualHardwareConfiguration;
  readonly initialSensorsC: FirmwareSensorTemperatures;
  /** Commands are placed in the virtual UART after setup succeeds and before the first loop. */
  readonly startupSerial?: Uint8Array;
  /** Overrides hardware.eeprom.initialFill while retaining its configured size. */
  readonly initialEeprom?: Uint8Array;
}

export interface FirmwareAdvanceInput {
  /** Positive integral microseconds on the deterministic virtual clock. */
  readonly elapsedUs: number;
  /** Physical twin temperatures held during this co-simulation interval. */
  readonly sensorsC: FirmwareSensorTemperatures;
  readonly serialRx?: Uint8Array;
  /** Values address configured digital-input pins by canonical pin name. */
  readonly digitalInputs?: Readonly<Record<string, boolean>>;
}

export interface FirmwareOutputObservation {
  readonly pin: string;
  readonly level: 'high' | 'low';
  readonly active: boolean;
  /** Fraction of this interval for which the configured logical output was active. */
  readonly activeFraction: number;
}

export interface FirmwareAdvanceResult {
  readonly startTimeUs: number;
  readonly endTimeUs: number;
  /** Edge-integrated active fraction of the shared heater GPIO. */
  readonly heaterDuty: number;
  readonly serialTx: Uint8Array;
  readonly indicators: Readonly<Record<string, FirmwareOutputObservation>>;
  readonly resetCount: number;
}

export interface FirmwareInLoop {
  advance(input: FirmwareAdvanceInput): FirmwareAdvanceResult;
  /** Idempotent. Calls to advance after disposal fail deterministically. */
  dispose(): void;
}

export type FirmwareInLoopErrorCode =
  | 'INVALID_ARTIFACT'
  | 'ABI_MISMATCH'
  | 'FORBIDDEN_WASM_IMPORT'
  | 'INVALID_GPIO_CONFIGURATION'
  | 'INVALID_STEP'
  | 'SERIAL_OVERFLOW'
  | 'EVENT_BUDGET_EXCEEDED'
  | 'WASM_TRAP'
  | 'DISPOSED';

export class FirmwareInLoopError extends Error {
  constructor(
    readonly code: FirmwareInLoopErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(path === undefined ? message : `${path}: ${message}`);
    this.name = 'FirmwareInLoopError';
  }
}
