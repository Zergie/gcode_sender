import {
  FIRMWARE_ADC_BITS,
  type FirmwarePinCapability,
  type FirmwarePinDescriptor,
  type VirtualHardwareConfiguration,
  type VirtualPinBinding,
} from '../../shared/firmware-contracts';
import type { SketchSnapshot } from './source-snapshot';

const PIN_PATTERN = /\bP([A-C])(1[0-5]|[0-9])\b/g;
const PIN_DEFINE_PATTERN =
  /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(P[A-C](?:1[0-5]|[0-9]))\b/gm;
const SERIAL_PATTERN =
  /HardwareSerial\s+\w+\s*=\s*HardwareSerial\s*\(\s*(P[A-C](?:1[0-5]|[0-9]))\s*,\s*(P[A-C](?:1[0-5]|[0-9]))\s*\)/g;

export function discoverFirmwarePins(snapshot: SketchSnapshot): readonly FirmwarePinDescriptor[] {
  const pins = new Map<
    string,
    { capabilities: Set<FirmwarePinCapability>; sourceName: string | null }
  >();
  const ensure = (
    pin: string,
  ): { capabilities: Set<FirmwarePinCapability>; sourceName: string | null } => {
    const existing = pins.get(pin);
    if (existing !== undefined) return existing;
    const created = { capabilities: new Set<FirmwarePinCapability>(), sourceName: null };
    pins.set(pin, created);
    return created;
  };

  for (const file of snapshot.files) {
    for (const match of file.text.matchAll(PIN_PATTERN)) ensure(`P${match[1]}${match[2]}`);
    for (const match of file.text.matchAll(PIN_DEFINE_PATTERN)) {
      const name = match[1];
      const pin = match[2];
      if (name === undefined || pin === undefined) continue;
      const descriptor = ensure(pin);
      descriptor.sourceName ??= name;
      if (/SENSOR|THERM/i.test(name)) {
        descriptor.capabilities.add('analog-input');
      } else if (/RELAY|HEATER/i.test(name)) {
        descriptor.capabilities.add('digital-output');
        descriptor.capabilities.add('pwm-output');
      } else if (/LED/i.test(name)) {
        descriptor.capabilities.add('digital-output');
      }
    }
    for (const match of file.text.matchAll(SERIAL_PATTERN)) {
      const rx = match[1];
      const tx = match[2];
      if (rx !== undefined) ensure(rx).capabilities.add('uart-rx');
      if (tx !== undefined) ensure(tx).capabilities.add('uart-tx');
    }
  }

  return [...pins.entries()]
    .map(([pin, value]): FirmwarePinDescriptor => ({
      pin,
      capabilities: [...value.capabilities].sort(),
      sourceName: value.sourceName,
      suggestedRole: suggestedRole(value.sourceName, value.capabilities),
    }))
    .sort((left, right) => pinId(left.pin) - pinId(right.pin));
}

export function suggestVirtualHardware(
  pins: readonly FirmwarePinDescriptor[],
): VirtualHardwareConfiguration {
  const present = new Set(pins.map(({ pin }) => pin));
  const bindings: VirtualPinBinding[] = [];
  const thermistor = (pin: string, sensor: 't1' | 't2' | 't3'): void => {
    if (!present.has(pin)) return;
    bindings.push({
      kind: 'thermistor-input',
      pin,
      sensor,
      transfer: {
        kind: 'ntc-beta-divider',
        referenceResistanceOhm: 4700,
        nominalResistanceOhm: 100000,
        nominalTemperatureC: 25,
        betaK: 3950,
        adcBits: FIRMWARE_ADC_BITS,
        topology: 'reference-to-vcc-thermistor-to-ground',
      },
    });
  };
  thermistor('PA6', 't1');
  thermistor('PA0', 't2');
  thermistor('PA5', 't3');
  if (present.has('PB9')) {
    bindings.push({
      kind: 'heater-output',
      pin: 'PB9',
      actuator: 'shared-heaters',
      activeLevel: 'high',
      sampling: 'edge-integrated',
    });
  }
  if (present.has('PC13')) {
    bindings.push({
      kind: 'indicator-output',
      pin: 'PC13',
      indicatorId: 'builtin-led',
      label: 'Built-in LED',
      activeLevel: 'low',
    });
  }
  if (present.has('PA10')) bindings.push({ kind: 'uart-rx', pin: 'PA10', uartId: 'command' });
  if (present.has('PA9')) bindings.push({ kind: 'uart-tx', pin: 'PA9', uartId: 'command' });
  return {
    version: 1,
    boardProfileId: 'pid-temp-stm32-v1',
    pins: bindings,
    eeprom: { initialFill: 255, sizeBytes: 4096 },
  };
}

function suggestedRole(
  name: string | null,
  capabilities: ReadonlySet<FirmwarePinCapability>,
): VirtualPinBinding['kind'] | null {
  if (name !== null && /SENSOR|THERM/i.test(name)) return 'thermistor-input';
  if (name !== null && /RELAY|HEATER/i.test(name)) return 'heater-output';
  if (name !== null && /LED/i.test(name)) return 'indicator-output';
  if (capabilities.has('uart-rx')) return 'uart-rx';
  if (capabilities.has('uart-tx')) return 'uart-tx';
  return null;
}

function pinId(pin: string): number {
  const match = /^P([A-C])(1[0-5]|[0-9])$/.exec(pin);
  return match === null
    ? Number.MAX_SAFE_INTEGER
    : (match[1]!.charCodeAt(0) - 65) * 16 + Number(match[2]);
}
