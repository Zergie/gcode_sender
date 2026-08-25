import {
  FIRMWARE_ARTIFACT_MAX_BYTES,
  FIRMWARE_WASM_ABI,
} from '../../../../../shared/firmware-contracts';
import { temperatureToNtcAdc } from './ntc-adc';
import { firmwarePinId, prepareFirmwarePins, type PreparedFirmwarePins } from './pins';
import {
  FirmwareInLoopError,
  type FirmwareAdvanceInput,
  type FirmwareAdvanceResult,
  type FirmwareInLoop,
  type FirmwareInLoopLoad,
  type FirmwareOutputObservation,
  type FirmwareSensorTemperatures,
} from './types';

const ABI_VERSION = 1;
const MAXIMUM_MEMORY_BYTES = 16 * 1024 * 1024;
const MAXIMUM_SERIAL_BYTES_PER_STEP = 64 * 1024;
const FIRMWARE_STATUS_RESET_REQUESTED = 1;
const FIRMWARE_STATUS_TX_OVERFLOW = 2;
const MAXIMUM_RESETS_PER_STEP = 8;
const SERIAL_DRAIN_CHUNK_BYTES = 4 * 1024;

type WasmFunction = (...args: number[]) => number | void;

interface FirmwareWasmExports {
  readonly memory: WebAssembly.Memory;
  readonly initialize?: () => void;
  readonly abiVersion: () => number;
  readonly alloc: (length: number) => number;
  readonly free: (pointer: number) => void;
  readonly setAnalogInput: (pinId: number, value: number) => number;
  readonly setDigitalInput: (pinId: number, level: number) => number;
  readonly loadEeprom: (pointer: number, length: number) => number;
  readonly boot: () => number;
  readonly advance: (elapsedUs: number) => number;
  readonly enqueueSerial: (pointer: number, length: number) => number;
  readonly drainSerial: (pointer: number, capacity: number) => number;
  readonly getPinLevel: (pinId: number) => number;
  readonly getSerialRxPin: () => number;
  readonly getSerialTxPin: () => number;
  /** Despite the ABI name, v1 returns GPIO HIGH occupancy; the host applies polarity. */
  readonly takeHighMicros: (pinId: number) => number;
  readonly takeElapsedMicros: () => number;
  readonly getResetCount: () => number;
  readonly dumpEeprom: (pointer: number, capacity: number) => number;
}

interface AdvanceAccumulator {
  elapsedUs: number;
  resetCount: number;
  readonly highMicrosByPin: Map<string, number>;
  readonly serialChunks: Uint8Array[];
  serialBytes: number;
}

interface FirmwareInstantiation {
  readonly exports: FirmwareWasmExports;
  /** Setup-triggered resets performed while reaching this successful boot. */
  readonly resetCount: number;
}

const REQUIRED_FUNCTION_EXPORTS = [
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
  'fil_get_serial_rx_pin',
  'fil_get_serial_tx_pin',
  'fil_take_active_micros',
  'fil_take_elapsed_micros',
  'fil_get_reset_count',
  'fil_dump_eeprom',
] as const;

function wrapTrap<T>(operation: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof FirmwareInLoopError) throw error;
    throw new FirmwareInLoopError(
      'WASM_TRAP',
      `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireStatus(status: number, operation: string): void {
  if (!Number.isInteger(status) || status !== 0) {
    throw new FirmwareInLoopError(
      'WASM_TRAP',
      `${operation} returned firmware status ${String(status)}.`,
    );
  }
}

function assertMemoryLimit(exports: FirmwareWasmExports): void {
  if (exports.memory.buffer.byteLength > MAXIMUM_MEMORY_BYTES) {
    throw new FirmwareInLoopError(
      'INVALID_ARTIFACT',
      `WASM linear memory exceeds ${MAXIMUM_MEMORY_BYTES} bytes.`,
      'artifact.wasmBytes',
    );
  }
}

function requireFunction(
  exports: WebAssembly.Exports,
  name: (typeof REQUIRED_FUNCTION_EXPORTS)[number],
): WasmFunction {
  const candidate = exports[name];
  if (typeof candidate !== 'function') {
    throw new FirmwareInLoopError(
      'ABI_MISMATCH',
      `Required WASM function export '${name}' is missing.`,
      'artifact.wasmBytes',
    );
  }
  return candidate as WasmFunction;
}

function bindExports(instance: WebAssembly.Instance): FirmwareWasmExports {
  const raw = instance.exports;
  if (!(raw['memory'] instanceof WebAssembly.Memory)) {
    throw new FirmwareInLoopError(
      'ABI_MISMATCH',
      "Required WASM memory export 'memory' is missing.",
      'artifact.wasmBytes',
    );
  }
  const optionalInitialize = raw['_initialize'];
  if (optionalInitialize !== undefined && typeof optionalInitialize !== 'function') {
    throw new FirmwareInLoopError(
      'ABI_MISMATCH',
      "Optional WASM export '_initialize' must be a function.",
      'artifact.wasmBytes',
    );
  }
  return {
    memory: raw['memory'],
    initialize: optionalInitialize as (() => void) | undefined,
    abiVersion: requireFunction(raw, 'fil_abi_version') as () => number,
    alloc: requireFunction(raw, 'fil_alloc') as (length: number) => number,
    free: requireFunction(raw, 'fil_free') as (pointer: number) => void,
    setAnalogInput: requireFunction(raw, 'fil_set_analog_input') as (
      pinId: number,
      value: number,
    ) => number,
    setDigitalInput: requireFunction(raw, 'fil_set_digital_input') as (
      pinId: number,
      level: number,
    ) => number,
    loadEeprom: requireFunction(raw, 'fil_load_eeprom') as (
      pointer: number,
      length: number,
    ) => number,
    boot: requireFunction(raw, 'fil_boot') as () => number,
    advance: requireFunction(raw, 'fil_advance') as (elapsedUs: number) => number,
    enqueueSerial: requireFunction(raw, 'fil_enqueue_serial') as (
      pointer: number,
      length: number,
    ) => number,
    drainSerial: requireFunction(raw, 'fil_drain_serial') as (
      pointer: number,
      capacity: number,
    ) => number,
    getPinLevel: requireFunction(raw, 'fil_get_pin_level') as (pinId: number) => number,
    getSerialRxPin: requireFunction(raw, 'fil_get_serial_rx_pin') as () => number,
    getSerialTxPin: requireFunction(raw, 'fil_get_serial_tx_pin') as () => number,
    takeHighMicros: requireFunction(raw, 'fil_take_active_micros') as (pinId: number) => number,
    takeElapsedMicros: requireFunction(raw, 'fil_take_elapsed_micros') as () => number,
    getResetCount: requireFunction(raw, 'fil_get_reset_count') as () => number,
    dumpEeprom: requireFunction(raw, 'fil_dump_eeprom') as (
      pointer: number,
      capacity: number,
    ) => number,
  };
}

function validateModule(bytes: Uint8Array): WebAssembly.Module {
  if (bytes.byteLength === 0 || bytes.byteLength > FIRMWARE_ARTIFACT_MAX_BYTES) {
    throw new FirmwareInLoopError(
      'INVALID_ARTIFACT',
      `WASM artifact must contain 1 through ${FIRMWARE_ARTIFACT_MAX_BYTES} bytes.`,
      'artifact.wasmBytes',
    );
  }
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const module = wrapTrap('WASM compilation', () => new WebAssembly.Module(ownedBytes.buffer));
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    const names = imports.map(({ module: namespace, name }) => `${namespace}.${name}`).join(', ');
    throw new FirmwareInLoopError(
      'FORBIDDEN_WASM_IMPORT',
      `ABI v1 firmware must be self-contained; found imports: ${names}.`,
      'artifact.wasmBytes',
    );
  }
  const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
  for (const name of ['memory', ...REQUIRED_FUNCTION_EXPORTS]) {
    if (!exports.has(name)) {
      throw new FirmwareInLoopError(
        'ABI_MISMATCH',
        `Required WASM export '${name}' is missing.`,
        'artifact.wasmBytes',
      );
    }
  }
  return module;
}

function validateSensors(sensors: FirmwareSensorTemperatures): void {
  for (const [sensor, value] of Object.entries(sensors)) {
    if (!Number.isFinite(value) || value <= -273.15) {
      throw new FirmwareInLoopError(
        'INVALID_STEP',
        'must be finite and above absolute zero',
        `sensorsC.${sensor}`,
      );
    }
  }
}

function concatBytes(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

class WasmFirmwareInLoop implements FirmwareInLoop {
  private readonly module: WebAssembly.Module;
  private readonly pins: PreparedFirmwarePins;
  private exports: FirmwareWasmExports;
  private timeUs = 0;
  private disposed = false;
  private sensorsC: FirmwareSensorTemperatures;
  private readonly digitalLevels = new Map<string, boolean>();
  /** Setup resets are surfaced with the first observable execution interval. */
  private pendingResetCount = 0;

  constructor(private readonly load: FirmwareInLoopLoad) {
    if (load.artifact.abi !== FIRMWARE_WASM_ABI) {
      throw new FirmwareInLoopError(
        'ABI_MISMATCH',
        `Expected '${FIRMWARE_WASM_ABI}', received '${String(load.artifact.abi)}'.`,
        'artifact.abi',
      );
    }
    this.pins = prepareFirmwarePins(load.hardware);
    this.module = validateModule(load.artifact.wasmBytes);
    this.sensorsC = { ...load.initialSensorsC };
    validateSensors(this.sensorsC);
    for (const input of this.pins.digitalInputs) this.digitalLevels.set(input.pin, input.level);
    const eeprom = this.initialEepromImage(load);
    const instantiation = this.instantiate(eeprom, load.startupSerial);
    this.exports = instantiation.exports;
    this.pendingResetCount = instantiation.resetCount;
  }

  advance(input: FirmwareAdvanceInput): FirmwareAdvanceResult {
    if (this.disposed) {
      throw new FirmwareInLoopError('DISPOSED', 'The firmware session has been disposed.');
    }
    if (
      !Number.isSafeInteger(input.elapsedUs) ||
      input.elapsedUs <= 0 ||
      input.elapsedUs > 0x7fffffff
    ) {
      throw new FirmwareInLoopError(
        'INVALID_STEP',
        'elapsedUs must be a positive signed 32-bit integer.',
        'elapsedUs',
      );
    }
    validateSensors(input.sensorsC);
    this.sensorsC = { ...input.sensorsC };
    if (input.digitalInputs !== undefined) {
      for (const [pin, level] of Object.entries(input.digitalInputs)) {
        if (!this.digitalLevels.has(pin) || typeof level !== 'boolean') {
          throw new FirmwareInLoopError(
            'INVALID_STEP',
            'must identify a configured digital input and contain a boolean level',
            `digitalInputs.${pin}`,
          );
        }
        this.digitalLevels.set(pin, level);
      }
    }
    this.applyInputs();
    if (input.serialRx !== undefined) this.enqueueSerial(input.serialRx);

    const startTimeUs = this.timeUs;
    const accumulator: AdvanceAccumulator = {
      elapsedUs: 0,
      resetCount: this.pendingResetCount,
      highMicrosByPin: new Map(),
      serialChunks: [],
      serialBytes: 0,
    };
    this.pendingResetCount = 0;
    let remainingUs = input.elapsedUs;
    while (remainingUs > 0) {
      const status = wrapTrap('fil_advance', () => this.exports.advance(remainingUs));
      const consumedUs = wrapTrap('fil_take_elapsed_micros', () =>
        this.exports.takeElapsedMicros(),
      );
      if (!Number.isInteger(consumedUs) || consumedUs < 0 || consumedUs > remainingUs) {
        throw new FirmwareInLoopError(
          'WASM_TRAP',
          `fil_take_elapsed_micros returned invalid value ${String(consumedUs)}.`,
        );
      }
      this.collectOutputs(consumedUs, accumulator);
      this.drainSerial(accumulator);
      accumulator.elapsedUs += consumedUs;
      remainingUs -= consumedUs;
      assertMemoryLimit(this.exports);

      if (status === 0) {
        if (consumedUs !== 0 && remainingUs !== 0) {
          throw new FirmwareInLoopError(
            'WASM_TRAP',
            'fil_advance completed without consuming the requested virtual interval.',
          );
        }
        if (remainingUs === 0) break;
        throw new FirmwareInLoopError(
          'EVENT_BUDGET_EXCEEDED',
          'Firmware made no progress on the deterministic virtual clock.',
        );
      }
      if (status === FIRMWARE_STATUS_TX_OVERFLOW) {
        throw new FirmwareInLoopError(
          'SERIAL_OVERFLOW',
          'Virtual firmware serial TX buffer overflowed; output was not silently discarded.',
        );
      }
      if (status !== FIRMWARE_STATUS_RESET_REQUESTED) {
        throw new FirmwareInLoopError(
          'WASM_TRAP',
          `fil_advance returned firmware status ${String(status)}.`,
        );
      }
      accumulator.resetCount += 1;
      if (accumulator.resetCount > MAXIMUM_RESETS_PER_STEP) {
        throw new FirmwareInLoopError(
          'EVENT_BUDGET_EXCEEDED',
          `Firmware requested more than ${MAXIMUM_RESETS_PER_STEP} resets in one step.`,
        );
      }
      const eeprom = this.dumpEeprom();
      const instantiation = this.instantiate(eeprom, undefined, accumulator.resetCount);
      this.exports = instantiation.exports;
      accumulator.resetCount += instantiation.resetCount;
    }

    this.timeUs += input.elapsedUs;
    // A LOW reset/default level must never masquerade as a valid active-low or
    // inactive actuator. The shim reports whether firmware configured outputs.
    this.getPinLevel(this.pins.heater.pin);
    const heaterHighUs = accumulator.highMicrosByPin.get(this.pins.heater.pin) ?? 0;
    const heaterActiveUs =
      this.pins.heater.activeLevel === 'high' ? heaterHighUs : input.elapsedUs - heaterHighUs;
    const indicators = Object.fromEntries(
      this.pins.indicators.map((indicator) => {
        const highUs = accumulator.highMicrosByPin.get(indicator.pin) ?? 0;
        const activeUs = indicator.activeLevel === 'high' ? highUs : input.elapsedUs - highUs;
        const level = this.getPinLevel(indicator.pin);
        const observation: FirmwareOutputObservation = {
          pin: indicator.pin,
          level: level === 1 ? 'high' : 'low',
          active: (indicator.activeLevel === 'high' ? 1 : 0) === level,
          activeFraction: activeUs / input.elapsedUs,
        };
        return [indicator.indicatorId, observation] as const;
      }),
    );
    return {
      startTimeUs,
      endTimeUs: this.timeUs,
      heaterDuty: Math.max(0, Math.min(1, heaterActiveUs / input.elapsedUs)),
      serialTx: concatBytes(accumulator.serialChunks, accumulator.serialBytes),
      indicators,
      resetCount: accumulator.resetCount,
    };
  }

  dispose(): void {
    this.disposed = true;
  }

  private initialEepromImage(load: FirmwareInLoopLoad): Uint8Array {
    const size = load.hardware.eeprom.sizeBytes;
    if (load.initialEeprom !== undefined) {
      if (load.initialEeprom.byteLength !== size) {
        throw new FirmwareInLoopError(
          'INVALID_GPIO_CONFIGURATION',
          `must contain exactly ${size} bytes`,
          'initialEeprom',
        );
      }
      return load.initialEeprom.slice();
    }
    return new Uint8Array(size).fill(load.hardware.eeprom.initialFill);
  }

  private instantiate(
    eeprom: Uint8Array,
    startupSerial?: Uint8Array,
    priorResetCount = 0,
  ): FirmwareInstantiation {
    let currentEeprom = eeprom;
    let setupResetCount = 0;
    while (true) {
      const instance = wrapTrap(
        'WASM instantiation',
        () => new WebAssembly.Instance(this.module, {}),
      );
      const exports = bindExports(instance);
      assertMemoryLimit(exports);
      if (exports.abiVersion() !== ABI_VERSION) {
        throw new FirmwareInLoopError(
          'ABI_MISMATCH',
          `WASM reports ABI version ${String(exports.abiVersion())}; expected ${ABI_VERSION}.`,
        );
      }
      wrapTrap('_initialize', () => exports.initialize?.());
      this.assertUartMapping(exports);
      this.withBytes(exports, currentEeprom, (pointer, length) => {
        const loaded = exports.loadEeprom(pointer, length);
        if (loaded !== length) {
          throw new FirmwareInLoopError(
            'WASM_TRAP',
            `fil_load_eeprom returned ${String(loaded)}; expected ${length}.`,
          );
        }
      });
      this.applyInputsTo(exports);
      const bootStatus = wrapTrap('fil_boot', () => exports.boot());
      if (bootStatus === FIRMWARE_STATUS_RESET_REQUESTED) {
        setupResetCount += 1;
        if (priorResetCount + setupResetCount > MAXIMUM_RESETS_PER_STEP) {
          throw new FirmwareInLoopError(
            'EVENT_BUDGET_EXCEEDED',
            `Firmware requested more than ${MAXIMUM_RESETS_PER_STEP} resets before setup could finish.`,
          );
        }
        currentEeprom = this.dumpEepromFrom(exports);
        continue;
      }
      if (bootStatus === FIRMWARE_STATUS_TX_OVERFLOW) {
        throw new FirmwareInLoopError(
          'SERIAL_OVERFLOW',
          'Virtual firmware serial TX buffer overflowed during setup.',
        );
      }
      requireStatus(bootStatus, 'fil_boot');
      // Commands belong to the successfully booted command UART. A discarded setup instance
      // must neither consume them nor cause them to be replayed on every reset attempt.
      if (startupSerial !== undefined) this.enqueueSerialTo(exports, startupSerial);
      return { exports, resetCount: setupResetCount };
    }
  }

  private assertUartMapping(exports: FirmwareWasmExports): void {
    const actualRx = wrapTrap('fil_get_serial_rx_pin', () => exports.getSerialRxPin());
    const actualTx = wrapTrap('fil_get_serial_tx_pin', () => exports.getSerialTxPin());
    const expectedRx = firmwarePinId(this.pins.uart.rxPin);
    const expectedTx = firmwarePinId(this.pins.uart.txPin);
    if (actualRx === -1 || actualTx === -1) {
      throw new FirmwareInLoopError(
        'ABI_MISMATCH',
        'ABI v1 firmware must construct exactly one HardwareSerial command UART; none was found.',
        'artifact.wasmBytes',
      );
    }
    if (actualRx === -2 || actualTx === -2) {
      throw new FirmwareInLoopError(
        'ABI_MISMATCH',
        'ABI v1 firmware supports exactly one HardwareSerial command UART; multiple instances were found.',
        'artifact.wasmBytes',
      );
    }
    if (
      !Number.isInteger(actualRx) ||
      !Number.isInteger(actualTx) ||
      actualRx < 0 ||
      actualRx >= 48 ||
      actualTx < 0 ||
      actualTx >= 48
    ) {
      throw new FirmwareInLoopError(
        'ABI_MISMATCH',
        `Firmware reported invalid command-UART pin ids RX=${String(actualRx)}, TX=${String(actualTx)}.`,
        'artifact.wasmBytes',
      );
    }
    if (actualRx !== expectedRx || actualTx !== expectedTx) {
      throw new FirmwareInLoopError(
        'INVALID_GPIO_CONFIGURATION',
        `Configured UART '${this.pins.uart.uartId}' (${this.pins.uart.rxPin}/${this.pins.uart.txPin}) does not match the firmware command UART (pin ids ${actualRx}/${actualTx}).`,
        'hardware.pins',
      );
    }
  }

  private applyInputs(): void {
    this.applyInputsTo(this.exports);
  }

  private applyInputsTo(exports: FirmwareWasmExports): void {
    for (const sensor of ['t1', 't2', 't3'] as const) {
      const binding = this.pins.thermistors[sensor];
      const adc = temperatureToNtcAdc(this.sensorsC[sensor], binding.transfer);
      requireStatus(
        wrapTrap('fil_set_analog_input', () =>
          exports.setAnalogInput(firmwarePinId(binding.pin), adc),
        ),
        'fil_set_analog_input',
      );
    }
    for (const binding of this.load.hardware.pins) {
      if (binding.kind === 'analog-input') {
        requireStatus(
          wrapTrap('fil_set_analog_input', () =>
            exports.setAnalogInput(firmwarePinId(binding.pin), binding.rawValue),
          ),
          'fil_set_analog_input',
        );
      }
    }
    for (const [pin, level] of this.digitalLevels) {
      requireStatus(
        wrapTrap('fil_set_digital_input', () =>
          exports.setDigitalInput(firmwarePinId(pin), level ? 1 : 0),
        ),
        'fil_set_digital_input',
      );
    }
  }

  private enqueueSerial(bytes: Uint8Array): void {
    this.enqueueSerialTo(this.exports, bytes);
  }

  private enqueueSerialTo(exports: FirmwareWasmExports, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > MAXIMUM_SERIAL_BYTES_PER_STEP) {
      throw new FirmwareInLoopError(
        'SERIAL_OVERFLOW',
        `Virtual serial input exceeds ${MAXIMUM_SERIAL_BYTES_PER_STEP} bytes.`,
      );
    }
    this.withBytes(exports, bytes, (pointer, length) => {
      const accepted = wrapTrap('fil_enqueue_serial', () => exports.enqueueSerial(pointer, length));
      if (accepted !== length) {
        throw new FirmwareInLoopError(
          'SERIAL_OVERFLOW',
          `Firmware accepted ${String(accepted)} of ${length} serial bytes.`,
        );
      }
    });
  }

  private drainSerial(accumulator: AdvanceAccumulator): void {
    while (true) {
      const chunk = this.withCapacity(
        this.exports,
        SERIAL_DRAIN_CHUNK_BYTES,
        (pointer, capacity) => {
          const length = wrapTrap('fil_drain_serial', () =>
            this.exports.drainSerial(pointer, capacity),
          );
          if (!Number.isInteger(length) || length < 0 || length > capacity) {
            throw new FirmwareInLoopError(
              'WASM_TRAP',
              `fil_drain_serial returned invalid length ${String(length)}.`,
            );
          }
          return new Uint8Array(this.exports.memory.buffer, pointer, length).slice();
        },
      );
      if (chunk.byteLength === 0) return;
      accumulator.serialBytes += chunk.byteLength;
      if (accumulator.serialBytes > MAXIMUM_SERIAL_BYTES_PER_STEP) {
        throw new FirmwareInLoopError(
          'SERIAL_OVERFLOW',
          `Virtual serial output exceeds ${MAXIMUM_SERIAL_BYTES_PER_STEP} bytes in one step.`,
        );
      }
      accumulator.serialChunks.push(chunk);
    }
  }

  private collectOutputs(consumedUs: number, accumulator: AdvanceAccumulator): void {
    for (const pin of this.pins.outputPins) {
      const highUs = wrapTrap('fil_take_active_micros', () =>
        this.exports.takeHighMicros(firmwarePinId(pin)),
      );
      if (!Number.isInteger(highUs) || highUs < 0 || highUs > consumedUs) {
        throw new FirmwareInLoopError(
          'WASM_TRAP',
          `fil_take_active_micros returned invalid value ${String(highUs)} for ${pin}.`,
        );
      }
      accumulator.highMicrosByPin.set(pin, (accumulator.highMicrosByPin.get(pin) ?? 0) + highUs);
    }
  }

  private getPinLevel(pin: string): 0 | 1 {
    const value = wrapTrap('fil_get_pin_level', () => this.exports.getPinLevel(firmwarePinId(pin)));
    if (value === -2) {
      throw new FirmwareInLoopError(
        'INVALID_GPIO_CONFIGURATION',
        `Configured output ${pin} was never configured with pinMode(..., OUTPUT) by firmware; check the virtual GPIO mapping.`,
        'hardware.pins',
      );
    }
    if (value !== 0 && value !== 1) {
      throw new FirmwareInLoopError(
        'WASM_TRAP',
        `fil_get_pin_level returned ${String(value)} for ${pin}.`,
      );
    }
    return value;
  }

  private dumpEeprom(): Uint8Array {
    return this.dumpEepromFrom(this.exports);
  }

  private dumpEepromFrom(exports: FirmwareWasmExports): Uint8Array {
    return this.withCapacity(exports, this.load.hardware.eeprom.sizeBytes, (pointer, capacity) => {
      const length = wrapTrap('fil_dump_eeprom', () => exports.dumpEeprom(pointer, capacity));
      if (length !== capacity) {
        throw new FirmwareInLoopError(
          'WASM_TRAP',
          `fil_dump_eeprom returned ${String(length)} bytes; expected ${capacity}.`,
        );
      }
      return new Uint8Array(exports.memory.buffer, pointer, length).slice();
    });
  }

  private withBytes(
    exports: FirmwareWasmExports,
    bytes: Uint8Array,
    action: (pointer: number, length: number) => void,
  ): void {
    const pointer = this.allocate(exports, bytes.byteLength);
    try {
      new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
      action(pointer, bytes.byteLength);
    } finally {
      wrapTrap('fil_free', () => exports.free(pointer));
    }
  }

  private withCapacity<T>(
    exports: FirmwareWasmExports,
    capacity: number,
    action: (pointer: number, capacity: number) => T,
  ): T {
    const pointer = this.allocate(exports, capacity);
    try {
      return action(pointer, capacity);
    } finally {
      wrapTrap('fil_free', () => exports.free(pointer));
    }
  }

  private allocate(exports: FirmwareWasmExports, length: number): number {
    const pointer = wrapTrap('fil_alloc', () => exports.alloc(length));
    if (
      !Number.isInteger(pointer) ||
      pointer <= 0 ||
      pointer + length > exports.memory.buffer.byteLength
    ) {
      throw new FirmwareInLoopError(
        'WASM_TRAP',
        `fil_alloc returned invalid pointer ${String(pointer)} for ${length} bytes.`,
      );
    }
    return pointer;
  }
}

export function validateFirmwareInLoopLoad(load: FirmwareInLoopLoad): void {
  prepareFirmwarePins(load.hardware);
  validateSensors(load.initialSensorsC);
  if (load.artifact.abi !== FIRMWARE_WASM_ABI) {
    throw new FirmwareInLoopError(
      'ABI_MISMATCH',
      `Expected artifact ABI '${FIRMWARE_WASM_ABI}'.`,
      'artifact.abi',
    );
  }
  if (
    load.startupSerial !== undefined &&
    load.startupSerial.byteLength > MAXIMUM_SERIAL_BYTES_PER_STEP
  ) {
    throw new FirmwareInLoopError('SERIAL_OVERFLOW', 'Startup serial input exceeds 65536 bytes.');
  }
  validateModule(load.artifact.wasmBytes);
}

/** Loads one isolated, deterministic firmware instance for a simulation variant. */
export function loadFirmwareInLoop(load: FirmwareInLoopLoad): FirmwareInLoop {
  return new WasmFirmwareInLoop(load);
}
