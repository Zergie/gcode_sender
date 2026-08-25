export const FIRMWARE_WASM_ABI = 'arduino-fil-wasm-v1' as const;
export const FIRMWARE_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
export const FIRMWARE_SOURCE_MAX_FILES = 64;
export const FIRMWARE_SOURCE_FILE_MAX_BYTES = 1024 * 1024;
export const FIRMWARE_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
/** ABI v1 targets the STM32F1 ADC value returned after analogReadResolution(12). */
export const FIRMWARE_ADC_BITS = 12 as const;
export const FIRMWARE_ADC_BITS_MIN = FIRMWARE_ADC_BITS;
export const FIRMWARE_ADC_BITS_MAX = FIRMWARE_ADC_BITS;
export const FIRMWARE_ADC_MAX_VALUE = (1 << FIRMWARE_ADC_BITS) - 1;
/** The supported sketch addresses EEPROM bytes 0, 8, 16, 24, 28, and 32. */
export const FIRMWARE_EEPROM_MIN_BYTES = 33;
export const FIRMWARE_EEPROM_MAX_BYTES = 64 * 1024;
export const FIRMWARE_PIN_PORTS = ['A', 'B', 'C'] as const;

export type FirmwareWasmAbi = typeof FIRMWARE_WASM_ABI;

export type FirmwareDiagnosticSeverity = 'info' | 'warning' | 'error';

export type FirmwareDiagnosticPhase =
  'source' | 'toolchain' | 'compile' | 'link' | 'cache' | 'configuration' | 'runtime';

export type FirmwareDiagnosticCode =
  | 'SOURCE_UNSUPPORTED'
  | 'SOURCE_INVALID'
  | 'SOURCE_LIMIT_EXCEEDED'
  | 'SOURCE_COMPATIBILITY_REWRITE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'TOOLCHAIN_UNAVAILABLE'
  | 'COMPILE_FAILED'
  | 'COMPILER_WARNING'
  | 'LINK_FAILED'
  | 'ABI_INCOMPATIBLE'
  | 'CACHE_CORRUPT'
  | 'CONFIG_INVALID'
  | 'PIN_UNKNOWN'
  | 'PIN_CONFLICT'
  | 'INPUT_UNBOUND'
  | 'PERIPHERAL_UNSUPPORTED'
  | 'RUNTIME_TRAP';

export interface FirmwareDiagnostic {
  readonly severity: FirmwareDiagnosticSeverity;
  readonly phase: FirmwareDiagnosticPhase;
  readonly code: FirmwareDiagnosticCode;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly pin?: string;
}

export type FirmwareToolchainAdapterKind = 'local-em++' | 'docker-emscripten';

export interface FirmwareToolchainAdapterStatus {
  readonly kind: FirmwareToolchainAdapterKind;
  readonly available: boolean;
  readonly displayName: string;
  readonly version: string | null;
  readonly detail: string;
}

export interface FirmwareToolchainStatus {
  readonly available: boolean;
  readonly selected: FirmwareToolchainAdapterKind | null;
  readonly adapters: readonly FirmwareToolchainAdapterStatus[];
}

export type FirmwarePinCapability =
  'analog-input' | 'digital-input' | 'digital-output' | 'pwm-output' | 'uart-rx' | 'uart-tx';

export interface FirmwarePinDescriptor {
  readonly pin: string;
  readonly capabilities: readonly FirmwarePinCapability[];
  readonly sourceName: string | null;
  readonly suggestedRole: VirtualPinBinding['kind'] | null;
}

export interface NtcBetaDivider {
  readonly kind: 'ntc-beta-divider';
  readonly referenceResistanceOhm: number;
  readonly nominalResistanceOhm: number;
  readonly nominalTemperatureC: number;
  readonly betaK: number;
  readonly adcBits: typeof FIRMWARE_ADC_BITS;
  /** Matches NTC_Thermistor's ADC/resistance equation. */
  readonly topology: 'reference-to-vcc-thermistor-to-ground';
}

export type VirtualPinBinding =
  | {
      readonly kind: 'thermistor-input';
      readonly pin: string;
      readonly sensor: 't1' | 't2' | 't3';
      readonly transfer: NtcBetaDivider;
    }
  | {
      readonly kind: 'heater-output';
      readonly pin: string;
      readonly actuator: 'shared-heaters';
      readonly activeLevel: 'high' | 'low';
      readonly sampling: 'edge-integrated';
    }
  | {
      readonly kind: 'indicator-output';
      readonly pin: string;
      readonly indicatorId: string;
      readonly label: string;
      readonly activeLevel: 'high' | 'low';
    }
  | {
      readonly kind: 'uart-rx' | 'uart-tx';
      readonly pin: string;
      readonly uartId: string;
    }
  | {
      readonly kind: 'digital-input';
      readonly pin: string;
      readonly level: boolean;
    }
  | {
      readonly kind: 'analog-input';
      readonly pin: string;
      readonly rawValue: number;
    }
  | {
      readonly kind: 'ignored-output';
      readonly pin: string;
      readonly reason: string;
    };

export interface VirtualHardwareConfiguration {
  readonly version: 1;
  readonly boardProfileId: string;
  readonly pins: readonly VirtualPinBinding[];
  readonly eeprom: {
    readonly initialFill: 0 | 255;
    readonly sizeBytes: number;
  };
}

export interface FirmwareSourceSnapshot {
  readonly path: string;
  readonly displayName: string;
  readonly sha256: string;
  readonly files: readonly string[];
}

export interface FirmwareWasmArtifact {
  readonly abi: FirmwareWasmAbi;
  readonly buildId: string;
  readonly sourceSha256: string;
  readonly wasmBytes: Uint8Array;
}

export interface FirmwareBuildProvenance {
  readonly compiler: {
    readonly adapter: FirmwareToolchainAdapterKind;
    readonly identity: string;
    readonly version: string;
  };
  readonly shim: {
    readonly abi: FirmwareWasmAbi;
    readonly version: string;
    readonly sha256: string;
  };
  readonly libraries: Readonly<
    Record<string, { readonly version: string; readonly sha256: string }>
  >;
  readonly flags: readonly string[];
  readonly sourceTransforms: readonly string[];
}

export interface PreparedFirmware {
  readonly artifact: FirmwareWasmArtifact;
  readonly source: FirmwareSourceSnapshot;
  readonly discoveredPins: readonly FirmwarePinDescriptor[];
  readonly suggestedHardware: VirtualHardwareConfiguration;
  readonly toolchain: FirmwareToolchainStatus;
  readonly diagnostics: readonly FirmwareDiagnostic[];
  readonly provenance: FirmwareBuildProvenance;
  readonly cacheHit: boolean;
  readonly fidelity: 'source-level firmware logic with semantic peripheral emulation';
}

export type FirmwareBuildOutcome =
  | { readonly status: 'ready'; readonly firmware: PreparedFirmware }
  | {
      readonly status: 'failed';
      readonly toolchain: FirmwareToolchainStatus;
      readonly diagnostics: readonly FirmwareDiagnostic[];
    };
