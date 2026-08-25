import { describe, expect, it } from 'vitest';

import {
  FIRMWARE_WASM_ABI,
  type FirmwareWasmArtifact,
} from '../../../../../shared/firmware-contracts';
import { TEST_HARDWARE } from './firmware-in-loop.fixture';
import { FirmwareInLoopError, loadFirmwareInLoop } from './index';
import { DEFAULT_OVEN_PROFILE, DEFAULT_SIMULATION_CONTROLLER } from '../default-profile';
import { simulate } from '../engine';

const text = (value: string): number[] => [...new TextEncoder().encode(value)];

function eepromImage(firstByte: number): Uint8Array {
  const image = new Uint8Array(TEST_HARDWARE.eeprom.sizeBytes).fill(0xff);
  image[0] = firstByte;
  return image;
}

function uleb(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function sleb(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value | 0;
  let more = true;
  while (more) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    const sign = (byte & 0x40) !== 0;
    more = !((remaining === 0 && !sign) || (remaining === -1 && sign));
    if (more) byte |= 0x80;
    bytes.push(byte);
  }
  return bytes;
}

function vector(items: readonly number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

function name(value: string): number[] {
  const bytes = text(value);
  return [...uleb(bytes.length), ...bytes];
}

const I32 = 0x7f;
const END = 0x0b;
const LOCAL_GET = (index: number): number[] => [0x20, ...uleb(index)];
const I32_CONST = (value: number): number[] => [0x41, ...sleb(value)];
const LOAD = (offset = 0): number[] => [0x28, 0x02, ...uleb(offset)];
const LOAD8 = (offset = 0): number[] => [0x2d, 0x00, ...uleb(offset)];
const STORE = (offset = 0): number[] => [0x36, 0x02, ...uleb(offset)];
const STORE8 = (offset = 0): number[] => [0x3a, 0x00, ...uleb(offset)];

function body(instructions: number[]): number[] {
  const code = [0x00, ...instructions, END];
  return [...uleb(code.length), ...code];
}

function pinLevelBody(undrivenPin?: number): number[] {
  const drivenLevel = [
    ...LOCAL_GET(0),
    ...I32_CONST(25),
    0x46,
    0x04,
    I32,
    ...I32_CONST(8),
    ...LOAD(),
    0x05,
    ...I32_CONST(0),
    END,
  ];
  if (undrivenPin === undefined) return body(drivenLevel);
  return body([
    ...LOCAL_GET(0),
    ...I32_CONST(undrivenPin),
    0x46,
    0x04,
    I32,
    ...I32_CONST(-2),
    0x05,
    ...drivenLevel,
    END,
  ]);
}

/** A real, import-free Wasm module implementing the frozen ABI with deterministic state. */
function tinyFirmwareWasm(
  serialRxPin = 10,
  serialTxPin = 9,
  advanceStatus?: number,
  undrivenPin?: number,
  setupReset: 'none' | 'once' | 'always' = 'none',
): Uint8Array {
  const types = [
    [0x60, 0x00, 0x01, I32],
    [0x60, 0x01, I32, 0x01, I32],
    [0x60, 0x01, I32, 0x00],
    [0x60, 0x02, I32, I32, 0x01, I32],
    [0x60, 0x00, 0x00],
  ];
  const functionTypes = [0, 1, 2, 3, 3, 3, 0, 1, 3, 3, 1, 1, 0, 3, 0, 4, 0, 0];
  const exportNames = [
    'fil_abi_version',
    'fil_alloc',
    'fil_free',
    'fil_set_analog_input',
    'fil_set_digital_input',
    'fil_load_eeprom',
    'fil_boot',
    'fil_advance',
    'fil_enqueue_serial',
    'fil_drain_serial',
    'fil_get_pin_level',
    'fil_take_active_micros',
    'fil_get_reset_count',
    'fil_dump_eeprom',
    'fil_take_elapsed_micros',
    '_initialize',
    'fil_get_serial_rx_pin',
    'fil_get_serial_tx_pin',
  ];
  const exports = [
    [...name('memory'), 0x02, ...uleb(0)],
    ...exportNames.map((entry, index) => [...name(entry), 0x00, ...uleb(index)]),
  ];

  // Memory layout: ADC=4, digital input=8, EEPROM=12, TX byte=16,
  // TX pending=20, elapsed=24, heater HIGH micros=28, boot-observed inputs=32,
  // digital-input setter observed=36.
  const functions = [
    body(I32_CONST(1)),
    body(I32_CONST(1_024)),
    body([]),
    body([...I32_CONST(4), ...LOCAL_GET(1), ...STORE(), ...I32_CONST(0)]),
    body([
      ...I32_CONST(8),
      ...LOCAL_GET(1),
      ...STORE(),
      ...I32_CONST(36),
      ...I32_CONST(1),
      ...STORE(),
      ...I32_CONST(0),
    ]),
    body([...I32_CONST(12), ...LOCAL_GET(0), ...LOAD8(), ...STORE8(), ...LOCAL_GET(1)]),
    body([
      ...I32_CONST(32),
      ...I32_CONST(20),
      ...LOAD(),
      ...I32_CONST(4),
      ...LOAD(),
      ...I32_CONST(1_234),
      0x46,
      0x71,
      ...I32_CONST(36),
      ...LOAD(),
      0x71,
      ...STORE(),
      ...(setupReset === 'always'
        ? I32_CONST(1)
        : setupReset === 'once'
          ? [
              ...I32_CONST(12),
              ...LOAD8(),
              ...I32_CONST(42),
              0x46,
              0x04,
              I32,
              ...I32_CONST(12),
              ...I32_CONST(43),
              ...STORE8(),
              ...I32_CONST(1),
              0x05,
              ...I32_CONST(0),
              END,
            ]
          : I32_CONST(0)),
    ]),
    body([
      ...I32_CONST(24),
      ...LOCAL_GET(0),
      ...STORE(),
      ...I32_CONST(32),
      ...LOAD(),
      0x45,
      0x04,
      0x40,
      ...I32_CONST(20),
      ...LOAD(),
      0x04,
      0x40,
      ...I32_CONST(16),
      ...I32_CONST(63),
      ...STORE8(),
      END,
      END,
      ...I32_CONST(28),
      ...I32_CONST(8),
      ...LOAD(),
      0x04,
      I32,
      ...LOCAL_GET(0),
      ...I32_CONST(2),
      0x6e,
      0x05,
      ...I32_CONST(0),
      END,
      ...STORE(),
      ...I32_CONST(20),
      ...LOAD(),
      0x45,
      0x04,
      0x40,
      ...I32_CONST(16),
      ...I32_CONST(90),
      ...STORE8(),
      ...I32_CONST(20),
      ...I32_CONST(1),
      ...STORE(),
      END,
      ...I32_CONST(12),
      ...LOAD8(),
      ...I32_CONST(42),
      0x46,
      0x04,
      I32,
      ...I32_CONST(12),
      ...I32_CONST(43),
      ...STORE8(),
      ...I32_CONST(1),
      0x05,
      ...I32_CONST(0),
      END,
      ...(advanceStatus === undefined ? [] : [0x1a, ...I32_CONST(advanceStatus)]),
    ]),
    body([
      ...I32_CONST(16),
      ...LOCAL_GET(0),
      ...LOAD8(),
      ...STORE8(),
      ...I32_CONST(20),
      ...I32_CONST(1),
      ...STORE(),
      ...LOCAL_GET(1),
    ]),
    body([
      ...I32_CONST(20),
      ...LOAD(),
      0x04,
      I32,
      ...LOCAL_GET(0),
      ...I32_CONST(16),
      ...LOAD8(),
      ...STORE8(),
      ...I32_CONST(20),
      ...I32_CONST(0),
      ...STORE(),
      ...I32_CONST(1),
      0x05,
      ...I32_CONST(0),
      END,
    ]),
    pinLevelBody(undrivenPin),
    body([
      ...LOCAL_GET(0),
      ...I32_CONST(25),
      0x46,
      0x04,
      I32,
      ...I32_CONST(28),
      ...LOAD(),
      0x05,
      ...I32_CONST(0),
      END,
    ]),
    body(I32_CONST(0)),
    body([...LOCAL_GET(0), ...I32_CONST(12), ...LOAD8(), ...STORE8(), ...LOCAL_GET(1)]),
    body([...I32_CONST(24), ...LOAD()]),
    body([]),
    body(I32_CONST(serialRxPin)),
    body(I32_CONST(serialTxPin)),
  ];

  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, vector(types)),
    ...section(3, vector(functionTypes.map((type) => uleb(type)))),
    ...section(5, [0x01, 0x01, ...uleb(2), ...uleb(256)]),
    ...section(7, vector(exports)),
    ...section(10, vector(functions)),
  ]);
}

const ARTIFACT: FirmwareWasmArtifact = {
  abi: FIRMWARE_WASM_ABI,
  buildId: 'tiny-real-wasm-fixture',
  sourceSha256: 'fixture',
  wasmBytes: tinyFirmwareWasm(),
};

describe('WebAssembly firmware-in-the-loop runtime', () => {
  it('applies setup-time ADC/digital inputs and queues startup RX only after setup succeeds', () => {
    const runtime = loadFirmwareInLoop({
      artifact: ARTIFACT,
      hardware: TEST_HARDWARE,
      initialSensorsC: { t1: 25, t2: 25, t3: 25 },
      startupSerial: new TextEncoder().encode('S'),
      initialEeprom: eepromImage(41),
    });
    const off = runtime.advance({
      elapsedUs: 50_000,
      sensorsC: { t1: 25, t2: 25, t3: 25 },
    });
    expect(off.heaterDuty).toBe(0);
    expect(new TextDecoder().decode(off.serialTx)).toBe('?');
    expect(off.indicators['status-led']).toMatchObject({
      pin: 'PC13',
      level: 'low',
      active: true,
      activeFraction: 1,
    });

    const pwm = runtime.advance({
      elapsedUs: 50_000,
      sensorsC: { t1: 100, t2: 80, t3: 30 },
      digitalInputs: { PA1: true },
      serialRx: new TextEncoder().encode('X'),
    });
    expect(pwm.heaterDuty).toBe(0.5);
    expect(new TextDecoder().decode(pwm.serialTx)).toBe('?');
    runtime.dispose();
    expect(() => runtime.advance({ elapsedUs: 1, sensorsC: { t1: 25, t2: 25, t3: 25 } })).toThrow(
      FirmwareInLoopError,
    );
  });

  it('recreates the Wasm instance on reset, preserves EEPROM, and continues deterministically', () => {
    const runtime = loadFirmwareInLoop({
      artifact: ARTIFACT,
      hardware: TEST_HARDWARE,
      initialSensorsC: { t1: 25, t2: 25, t3: 25 },
      initialEeprom: eepromImage(42),
    });
    const reset = runtime.advance({
      elapsedUs: 50_000,
      sensorsC: { t1: 25, t2: 25, t3: 25 },
      digitalInputs: { PA1: true },
    });
    expect(reset.resetCount).toBe(1);
    expect(reset.heaterDuty).toBe(0.5);
    expect(
      runtime.advance({ elapsedUs: 50_000, sensorsC: { t1: 25, t2: 25, t3: 25 } }).resetCount,
    ).toBe(0);
  });

  it('honors a one-time setup reset, preserves EEPROM, and reports it on the first step', () => {
    const runtime = loadFirmwareInLoop({
      artifact: {
        ...ARTIFACT,
        wasmBytes: tinyFirmwareWasm(10, 9, undefined, undefined, 'once'),
      },
      hardware: TEST_HARDWARE,
      initialSensorsC: { t1: 25, t2: 25, t3: 25 },
      startupSerial: new TextEncoder().encode('S'),
      initialEeprom: eepromImage(42),
    });

    const first = runtime.advance({
      elapsedUs: 50_000,
      sensorsC: { t1: 25, t2: 25, t3: 25 },
    });
    expect(first.resetCount).toBe(1);
    expect(new TextDecoder().decode(first.serialTx)).toBe('?');
    expect(
      runtime.advance({ elapsedUs: 50_000, sensorsC: { t1: 25, t2: 25, t3: 25 } }).resetCount,
    ).toBe(0);
  });

  it('refuses firmware that repeatedly requests reset from setup', () => {
    expect(() =>
      loadFirmwareInLoop({
        artifact: {
          ...ARTIFACT,
          wasmBytes: tinyFirmwareWasm(10, 9, undefined, undefined, 'always'),
        },
        hardware: TEST_HARDWARE,
        initialSensorsC: { t1: 25, t2: 25, t3: 25 },
      }),
    ).toThrowError(/more than 8 resets.*setup/i);
  });

  it('rejects a configured UART pair that does not match the firmware command UART', () => {
    const mismatchedHardware = {
      ...TEST_HARDWARE,
      pins: TEST_HARDWARE.pins.map((binding) => {
        if (binding.kind === 'uart-rx') return { ...binding, pin: 'PA3' };
        if (binding.kind === 'uart-tx') return { ...binding, pin: 'PA2' };
        return binding;
      }),
    };
    expect(() =>
      loadFirmwareInLoop({
        artifact: ARTIFACT,
        hardware: mismatchedHardware,
        initialSensorsC: { t1: 25, t2: 25, t3: 25 },
      }),
    ).toThrowError(/does not match the firmware command UART/);
  });

  it('surfaces an explicit serial overflow when the shim reports TX saturation', () => {
    const runtime = loadFirmwareInLoop({
      artifact: { ...ARTIFACT, wasmBytes: tinyFirmwareWasm(10, 9, 2) },
      hardware: TEST_HARDWARE,
      initialSensorsC: { t1: 25, t2: 25, t3: 25 },
    });

    expect(() =>
      runtime.advance({ elapsedUs: 1_000, sensorsC: { t1: 25, t2: 25, t3: 25 } }),
    ).toThrowError(/serial TX buffer overflow/i);
  });

  it('accepts the full 65,536-byte serial ABI payload and rejects the next byte', () => {
    const runtime = loadFirmwareInLoop({
      artifact: ARTIFACT,
      hardware: TEST_HARDWARE,
      initialSensorsC: { t1: 25, t2: 25, t3: 25 },
    });

    expect(() =>
      runtime.advance({
        elapsedUs: 1_000,
        sensorsC: { t1: 25, t2: 25, t3: 25 },
        serialRx: new Uint8Array(65_536),
      }),
    ).not.toThrow();
    expect(() =>
      runtime.advance({
        elapsedUs: 1_000,
        sensorsC: { t1: 25, t2: 25, t3: 25 },
        serialRx: new Uint8Array(65_537),
      }),
    ).toThrowError(/exceeds 65536 bytes/);
  });

  it('rejects a configured heater pin that firmware never drives as OUTPUT', () => {
    const runtime = loadFirmwareInLoop({
      artifact: { ...ARTIFACT, wasmBytes: tinyFirmwareWasm(10, 9, undefined, 25) },
      hardware: TEST_HARDWARE,
      initialSensorsC: { t1: 25, t2: 25, t3: 25 },
    });

    expect(() =>
      runtime.advance({ elapsedUs: 1_000, sensorsC: { t1: 25, t2: 25, t3: 25 } }),
    ).toThrowError(/PB9.*pinMode.*OUTPUT/i);
  });

  it.each([
    [-1, /exactly one HardwareSerial command UART; none was found/],
    [-2, /exactly one HardwareSerial command UART; multiple instances were found/],
  ] as const)('rejects unsupported command-UART cardinality status %i', (status, message) => {
    expect(() =>
      loadFirmwareInLoop({
        artifact: { ...ARTIFACT, wasmBytes: tinyFirmwareWasm(status, status) },
        hardware: TEST_HARDWARE,
        initialSensorsC: { t1: 25, t2: 25, t3: 25 },
      }),
    ).toThrowError(message);
  });

  it('couples only edge-integrated firmware duty into the physical twin and records protocol I/O', () => {
    const firmware = simulate({
      profile: DEFAULT_OVEN_PROFILE,
      controller: DEFAULT_SIMULATION_CONTROLLER,
      controllerRuntime: {
        kind: 'wasm-firmware',
        artifact: ARTIFACT,
        hardware: TEST_HARDWARE,
        initialEeprom: eepromImage(41),
      },
      scenario: {
        durationSeconds: 1,
        targets: [{ atSeconds: 0, targetC: 100 }],
        serialCommands: [{ atSeconds: 0.2, command: 'M105' }],
        sampleEverySeconds: 0.1,
      },
    });

    expect(firmware.metrics.energyWh).toBe(0);
    expect(firmware.firmware?.buildId).toBe('tiny-real-wasm-fixture');
    expect(firmware.firmware?.serialTranscript.map(({ text: value }) => value).join('')).toContain(
      'M502\nM301',
    );
    expect(firmware.firmware?.serialTranscript.map(({ text: value }) => value).join('')).toContain(
      'M104 S100',
    );
    expect(firmware.firmware?.serialTranscript).toContainEqual(
      expect.objectContaining({ timeSeconds: 0.2, direction: 'rx', text: 'M105\n' }),
    );
    const indicatorSamples = firmware.firmware?.indicatorSamples ?? [];
    expect(indicatorSamples).toHaveLength(10);
    for (const [index, indicatorSample] of indicatorSamples.entries()) {
      expect(indicatorSample.intervalStartSeconds).toBeCloseTo(index * 0.1, 10);
      expect(indicatorSample.timeSeconds).toBeCloseTo((index + 1) * 0.1, 10);
      expect(indicatorSample.timeSeconds - indicatorSample.intervalStartSeconds).toBeCloseTo(
        0.1,
        10,
      );
      expect(indicatorSample.indicators['status-led']?.activeFraction).toBe(1);
    }
  });

  it('bounds large noisy firmware diagnostics without changing control execution', () => {
    const firmware = simulate({
      profile: DEFAULT_OVEN_PROFILE,
      controller: DEFAULT_SIMULATION_CONTROLLER,
      controllerRuntime: {
        kind: 'wasm-firmware',
        artifact: ARTIFACT,
        hardware: TEST_HARDWARE,
        initialEeprom: eepromImage(41),
      },
      scenario: {
        durationSeconds: 1_001,
        targets: [{ atSeconds: 0, targetC: 100 }],
        sampleEverySeconds: DEFAULT_OVEN_PROFILE.solverStepSeconds,
      },
    });
    expect(firmware.firmware?.serialTranscript.length).toBeLessThanOrEqual(2_000);
    expect(firmware.firmware?.truncation?.droppedSerialEvents).toBeGreaterThan(0);
    expect(firmware.firmware?.indicatorSamples.length).toBeLessThanOrEqual(10_000);
    expect(firmware.firmware?.truncation?.droppedIndicatorSamples).toBeGreaterThan(0);
    expect(firmware.firmware?.serialTranscript.at(-1)?.timeSeconds).toBeGreaterThan(990);
    expect(firmware.firmware?.indicatorSamples.at(-1)?.timeSeconds).toBeGreaterThan(990);
    expect(firmware.metrics.energyWh).toBe(0);
  }, 10_000);
});
