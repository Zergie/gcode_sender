import {
  FIRMWARE_ADC_MAX_VALUE,
  FIRMWARE_EEPROM_MAX_BYTES,
  FIRMWARE_EEPROM_MIN_BYTES,
  type VirtualHardwareConfiguration,
  type VirtualPinBinding,
} from '../../../../../shared/firmware-contracts';
import { validateNtcBetaDivider } from './ntc-adc';
import { FirmwareInLoopError } from './types';

export interface PreparedFirmwarePins {
  readonly heater: Extract<VirtualPinBinding, { readonly kind: 'heater-output' }>;
  readonly thermistors: Readonly<
    Record<'t1' | 't2' | 't3', Extract<VirtualPinBinding, { readonly kind: 'thermistor-input' }>>
  >;
  readonly indicators: readonly Extract<VirtualPinBinding, { readonly kind: 'indicator-output' }>[];
  readonly digitalInputs: readonly Extract<VirtualPinBinding, { readonly kind: 'digital-input' }>[];
  readonly uart: {
    readonly uartId: string;
    readonly rxPin: string;
    readonly txPin: string;
  };
  readonly outputPins: readonly string[];
}

const CANONICAL_STM32_PIN = /^P([ABC])(\d|1[0-5])$/;

export function firmwarePinId(pin: string): number {
  const match = CANONICAL_STM32_PIN.exec(pin);
  if (match === null) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      'must be a canonical Blue Pill pin from PA0 through PC15',
      `pins.${pin}`,
    );
  }
  return (match[1]!.charCodeAt(0) - 65) * 16 + Number(match[2]);
}

export function prepareFirmwarePins(hardware: VirtualHardwareConfiguration): PreparedFirmwarePins {
  if (hardware.version !== 1) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      'Only virtual hardware version 1 is supported.',
      'hardware.version',
    );
  }
  const occupied = new Set<string>();
  let heater: PreparedFirmwarePins['heater'] | undefined;
  const thermistors: Partial<
    Record<'t1' | 't2' | 't3', PreparedFirmwarePins['thermistors']['t1']>
  > = {};
  const indicators: PreparedFirmwarePins['indicators'][number][] = [];
  const digitalInputs: PreparedFirmwarePins['digitalInputs'][number][] = [];
  const outputPins = new Set<string>();
  const uartRx = new Map<string, string>();
  const uartTx = new Map<string, string>();

  hardware.pins.forEach((binding, index) => {
    firmwarePinId(binding.pin);
    if (occupied.has(binding.pin)) {
      throw new FirmwareInLoopError(
        'INVALID_GPIO_CONFIGURATION',
        'is assigned more than once',
        `hardware.pins[${index}].pin`,
      );
    }
    occupied.add(binding.pin);
    switch (binding.kind) {
      case 'heater-output':
        if (heater !== undefined) {
          throw new FirmwareInLoopError(
            'INVALID_GPIO_CONFIGURATION',
            'Exactly one shared-heater output is required.',
            `hardware.pins[${index}]`,
          );
        }
        if (binding.actuator !== 'shared-heaters' || binding.sampling !== 'edge-integrated') {
          throw new FirmwareInLoopError(
            'INVALID_GPIO_CONFIGURATION',
            'The v1 twin requires the edge-integrated shared-heater actuator.',
            `hardware.pins[${index}]`,
          );
        }
        heater = binding;
        outputPins.add(binding.pin);
        break;
      case 'thermistor-input':
        if (thermistors[binding.sensor] !== undefined) {
          throw new FirmwareInLoopError(
            'INVALID_GPIO_CONFIGURATION',
            `Thermistor ${binding.sensor.toUpperCase()} is assigned more than once.`,
            `hardware.pins[${index}]`,
          );
        }
        validateNtcBetaDivider(binding.transfer, `hardware.pins[${index}].transfer`);
        thermistors[binding.sensor] = binding;
        break;
      case 'indicator-output':
        if (indicators.some(({ indicatorId }) => indicatorId === binding.indicatorId)) {
          throw new FirmwareInLoopError(
            'INVALID_GPIO_CONFIGURATION',
            'Indicator identifiers must be unique.',
            `hardware.pins[${index}].indicatorId`,
          );
        }
        indicators.push(binding);
        outputPins.add(binding.pin);
        break;
      case 'digital-input':
        digitalInputs.push(binding);
        break;
      case 'ignored-output':
        break;
      case 'uart-rx':
        if (uartRx.has(binding.uartId)) {
          throw new FirmwareInLoopError(
            'INVALID_GPIO_CONFIGURATION',
            `UART '${binding.uartId}' has more than one RX pin.`,
            `hardware.pins[${index}]`,
          );
        }
        uartRx.set(binding.uartId, binding.pin);
        break;
      case 'uart-tx':
        if (uartTx.has(binding.uartId)) {
          throw new FirmwareInLoopError(
            'INVALID_GPIO_CONFIGURATION',
            `UART '${binding.uartId}' has more than one TX pin.`,
            `hardware.pins[${index}]`,
          );
        }
        uartTx.set(binding.uartId, binding.pin);
        break;
      case 'analog-input':
        if (
          !Number.isInteger(binding.rawValue) ||
          binding.rawValue < 0 ||
          binding.rawValue > FIRMWARE_ADC_MAX_VALUE
        ) {
          throw new FirmwareInLoopError(
            'INVALID_GPIO_CONFIGURATION',
            `must be an integer from 0 through ${FIRMWARE_ADC_MAX_VALUE}`,
            `hardware.pins[${index}].rawValue`,
          );
        }
        break;
      default:
        binding satisfies never;
    }
  });

  if (heater === undefined) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      'Exactly one shared-heater output is required.',
      'hardware.pins',
    );
  }
  for (const sensor of ['t1', 't2', 't3'] as const) {
    if (thermistors[sensor] === undefined) {
      throw new FirmwareInLoopError(
        'INVALID_GPIO_CONFIGURATION',
        `Thermistor ${sensor.toUpperCase()} must be assigned exactly once.`,
        'hardware.pins',
      );
    }
  }
  const uartIds = new Set([...uartRx.keys(), ...uartTx.keys()]);
  if (uartIds.size !== 1) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      'Exactly one virtual UART RX/TX pair is required.',
      'hardware.pins',
    );
  }
  const uartId = [...uartIds][0]!;
  if (!uartRx.has(uartId) || !uartTx.has(uartId)) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      `UART '${uartId}' requires one RX and one TX pin.`,
      'hardware.pins',
    );
  }
  if (
    !Number.isInteger(hardware.eeprom.sizeBytes) ||
    hardware.eeprom.sizeBytes < FIRMWARE_EEPROM_MIN_BYTES ||
    hardware.eeprom.sizeBytes > FIRMWARE_EEPROM_MAX_BYTES
  ) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      `must be an integer from ${FIRMWARE_EEPROM_MIN_BYTES} through ${FIRMWARE_EEPROM_MAX_BYTES}`,
      'hardware.eeprom.sizeBytes',
    );
  }
  if (hardware.eeprom.initialFill !== 0 && hardware.eeprom.initialFill !== 255) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      'initialFill must be 0 or 255',
      'hardware.eeprom.initialFill',
    );
  }
  return {
    heater,
    thermistors: thermistors as PreparedFirmwarePins['thermistors'],
    indicators,
    digitalInputs,
    uart: {
      uartId,
      rxPin: uartRx.get(uartId)!,
      txPin: uartTx.get(uartId)!,
    },
    outputPins: [...outputPins],
  };
}
