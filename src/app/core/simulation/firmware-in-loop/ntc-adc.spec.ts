import { describe, expect, it } from 'vitest';

import { TEST_HARDWARE, TEST_NTC } from './firmware-in-loop.fixture';
import { firmwarePinId, prepareFirmwarePins } from './pins';
import { temperatureToNtcAdc } from './ntc-adc';

describe('firmware virtual hardware conversion', () => {
  it('inverts the supported NTC_Thermistor divider exactly and only quantizes the ADC', () => {
    expect(temperatureToNtcAdc(25, TEST_NTC)).toBe(3_911);
    expect(temperatureToNtcAdc(25, TEST_NTC)).toBe(temperatureToNtcAdc(25, TEST_NTC));
    expect(temperatureToNtcAdc(100, TEST_NTC)).toBeLessThan(temperatureToNtcAdc(25, TEST_NTC));
  });

  it('uses the frozen PA/PB/PC pin numbering and validates the complete hardware seam', () => {
    expect(firmwarePinId('PA6')).toBe(6);
    expect(firmwarePinId('PB9')).toBe(25);
    expect(firmwarePinId('PC13')).toBe(45);
    expect(() => firmwarePinId('PD0')).toThrow(/PA0 through PC15/);
    expect(prepareFirmwarePins(TEST_HARDWARE).heater.pin).toBe('PB9');
  });

  it.each([8, 10, 11, 13, 16])(
    'rejects %s-bit thermistor conversion because ABI v1 is fixed to the native 12-bit output',
    (adcBits) => {
      expect(() =>
        prepareFirmwarePins({
          ...TEST_HARDWARE,
          pins: TEST_HARDWARE.pins.map((binding) =>
            binding.kind === 'thermistor-input'
              ? {
                  ...binding,
                  transfer: { ...binding.transfer, adcBits } as typeof binding.transfer,
                }
              : binding,
          ),
        }),
      ).toThrow(/must be 12 for the supported STM32F1 firmware/);
    },
  );

  it.each([-1, 1.5, 4_096])(
    'rejects analog input value %s outside the fixed 12-bit ADC seam',
    (rawValue) => {
      expect(() =>
        prepareFirmwarePins({
          ...TEST_HARDWARE,
          pins: TEST_HARDWARE.pins.map((binding) =>
            binding.kind === 'analog-input' ? { ...binding, rawValue } : binding,
          ),
        }),
      ).toThrow(/integer from 0 through 4095/);
    },
  );

  it.each([0, 1, 32, 65_537])(
    'rejects virtual EEPROM size %s outside the supported firmware capacity',
    (sizeBytes) => {
      expect(() =>
        prepareFirmwarePins({
          ...TEST_HARDWARE,
          eeprom: { ...TEST_HARDWARE.eeprom, sizeBytes },
        }),
      ).toThrow(/integer from 33 through 65536/);
    },
  );

  it('rejects an NTC nominal temperature at absolute zero', () => {
    expect(() =>
      prepareFirmwarePins({
        ...TEST_HARDWARE,
        pins: TEST_HARDWARE.pins.map((binding) =>
          binding.kind === 'thermistor-input'
            ? {
                ...binding,
                transfer: { ...binding.transfer, nominalTemperatureC: -273.15 },
              }
            : binding,
        ),
      }),
    ).toThrow(/above absolute zero/);
  });

  it('rejects a virtual EEPROM fill other than erased or zeroed bytes', () => {
    expect(() =>
      prepareFirmwarePins({
        ...TEST_HARDWARE,
        eeprom: { ...TEST_HARDWARE.eeprom, initialFill: 1 as 0 },
      }),
    ).toThrow(/initialFill.*0 or 255/);
  });

  it('does not poll GPIO declared as an ignored output', () => {
    const hardware = {
      ...TEST_HARDWARE,
      pins: TEST_HARDWARE.pins.map((binding) =>
        binding.kind === 'indicator-output'
          ? { kind: 'ignored-output' as const, pin: binding.pin, reason: 'Not observed' }
          : binding,
      ),
    };

    expect(prepareFirmwarePins(hardware).outputPins).toEqual(['PB9']);
  });
});
