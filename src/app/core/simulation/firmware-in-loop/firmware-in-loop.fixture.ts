import {
  FIRMWARE_WASM_ABI,
  FIRMWARE_ADC_BITS,
  type FirmwareWasmArtifact,
  type NtcBetaDivider,
  type VirtualHardwareConfiguration,
} from '../../../../../shared/firmware-contracts';
import type { SimulationControllerRuntime } from '../types';

export const TEST_NTC: NtcBetaDivider = {
  kind: 'ntc-beta-divider',
  referenceResistanceOhm: 4_700,
  nominalResistanceOhm: 100_000,
  nominalTemperatureC: 25,
  betaK: 3_950,
  adcBits: FIRMWARE_ADC_BITS,
  topology: 'reference-to-vcc-thermistor-to-ground',
};

export const TEST_HARDWARE: VirtualHardwareConfiguration = {
  version: 1,
  boardProfileId: 'blue-pill-fil-v1',
  pins: [
    { kind: 'thermistor-input', pin: 'PA6', sensor: 't1', transfer: TEST_NTC },
    { kind: 'thermistor-input', pin: 'PA0', sensor: 't2', transfer: TEST_NTC },
    { kind: 'thermistor-input', pin: 'PA5', sensor: 't3', transfer: TEST_NTC },
    {
      kind: 'heater-output',
      pin: 'PB9',
      actuator: 'shared-heaters',
      activeLevel: 'high',
      sampling: 'edge-integrated',
    },
    {
      kind: 'indicator-output',
      pin: 'PC13',
      indicatorId: 'status-led',
      label: 'Status LED',
      activeLevel: 'low',
    },
    { kind: 'digital-input', pin: 'PA1', level: false },
    { kind: 'analog-input', pin: 'PA4', rawValue: 1_234 },
    { kind: 'uart-rx', pin: 'PA10', uartId: 'serial' },
    { kind: 'uart-tx', pin: 'PA9', uartId: 'serial' },
  ],
  eeprom: { initialFill: 255, sizeBytes: 33 },
};

const TINY_FIRMWARE_WASM_BASE64 =
  'AGFzbQEAAAABFwVgAAF/YAF/AX9gAX8AYAJ/fwF/YAAAAxMSAAECAwMDAAEDAwEBAAMABAAABQUBAQKAAgfiAhMGbWVtb3J5AgAPZmlsX2FiaV92ZXJzaW9uAAAJZmlsX2FsbG9jAAEIZmlsX2ZyZWUAAhRmaWxfc2V0X2FuYWxvZ19pbnB1dAADFWZpbF9zZXRfZGlnaXRhbF9pbnB1dAAED2ZpbF9sb2FkX2VlcHJvbQAFCGZpbF9ib290AAYLZmlsX2FkdmFuY2UABxJmaWxfZW5xdWV1ZV9zZXJpYWwACBBmaWxfZHJhaW5fc2VyaWFsAAkRZmlsX2dldF9waW5fbGV2ZWwAChZmaWxfdGFrZV9hY3RpdmVfbWljcm9zAAsTZmlsX2dldF9yZXNldF9jb3VudAAMD2ZpbF9kdW1wX2VlcHJvbQANF2ZpbF90YWtlX2VsYXBzZWRfbWljcm9zAA4LX2luaXRpYWxpemUADxVmaWxfZ2V0X3NlcmlhbF9yeF9waW4AEBVmaWxfZ2V0X3NlcmlhbF90eF9waW4AEQrIAhIEAEEBCwUAQYAICwIACwsAQQQgATYCAEEACxIAQQggATYCAEEkQQE2AgBBAAsOAEEMIAAtAAA6AAAgAQseAEEgQRQoAgBBBCgCAEHSCUZxQSQoAgBxNgIAQQALZQBBGCAANgIAQSAoAgBFBEBBFCgCAARAQRBBPzoAAAsLQRxBCCgCAAR/IABBAm4FQQALNgIAQRQoAgBFBEBBEEHaADoAAEEUQQE2AgALQQwtAABBKkYEf0EMQSs6AABBAQVBAAsLFQBBECAALQAAOgAAQRRBATYCACABCyAAQRQoAgAEfyAAQRAtAAA6AABBFEEANgIAQQEFQQALCxIAIABBGUYEf0EIKAIABUEACwsSACAAQRlGBH9BHCgCAAVBAAsLBABBAAsOACAAQQwtAAA6AAAgAQsHAEEYKAIACwIACwQAQQoLBABBCQs=';

function decodeBase64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** Minimal deterministic ABI implementation for orchestration tests; it is not a PID model. */
export const TEST_FIRMWARE_ARTIFACT: FirmwareWasmArtifact = {
  abi: FIRMWARE_WASM_ABI,
  buildId: 'tiny-real-wasm-fixture',
  sourceSha256: 'fixture',
  wasmBytes: decodeBase64Bytes(TINY_FIRMWARE_WASM_BASE64),
};

export const TEST_SIMULATION_HARDWARE: VirtualHardwareConfiguration = {
  ...TEST_HARDWARE,
  pins: TEST_HARDWARE.pins.map((pin) =>
    pin.kind === 'digital-input' && pin.pin === 'PA1' ? { ...pin, level: true } : pin,
  ),
};

export const TEST_FIRMWARE_RUNTIME: SimulationControllerRuntime = {
  kind: 'wasm-firmware',
  artifact: TEST_FIRMWARE_ARTIFACT,
  hardware: TEST_SIMULATION_HARDWARE,
};
