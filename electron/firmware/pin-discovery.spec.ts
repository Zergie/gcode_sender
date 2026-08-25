import { describe, expect, it } from 'vitest';

import { discoverFirmwarePins, suggestVirtualHardware } from './pin-discovery';
import type { SketchSnapshot } from './source-snapshot';

describe('firmware pin discovery', () => {
  it('prefills the supported STM32 oven wiring without hiding generic pins', () => {
    const text = `
#define SENSOR_PIN1 PA6
#define SENSOR_PIN2 PA0
#define SENSOR_PIN3 PA5
#define RELAY_PIN PB9
#define LED_BUILTIN PC13
HardwareSerial Serial = HardwareSerial(PA10, PA9);
void setup() { pinMode(PB3, INPUT); }
`;
    const snapshot = {
      entryPath: 'C:\\sketch\\main.ino',
      directoryPath: 'C:\\sketch',
      public: {
        path: 'C:\\sketch\\main.ino',
        displayName: 'main.ino',
        sha256: 'x',
        files: ['main.ino'],
      },
      files: [{ relativePath: 'main.ino', bytes: new TextEncoder().encode(text), text }],
    } satisfies SketchSnapshot;

    const pins = discoverFirmwarePins(snapshot);
    expect(pins.map(({ pin }) => pin)).toEqual([
      'PA0',
      'PA5',
      'PA6',
      'PA9',
      'PA10',
      'PB3',
      'PB9',
      'PC13',
    ]);
    expect(suggestVirtualHardware(pins).pins).toMatchObject([
      { kind: 'thermistor-input', pin: 'PA6', sensor: 't1' },
      { kind: 'thermistor-input', pin: 'PA0', sensor: 't2' },
      { kind: 'thermistor-input', pin: 'PA5', sensor: 't3' },
      { kind: 'heater-output', pin: 'PB9', activeLevel: 'high' },
      { kind: 'indicator-output', pin: 'PC13', activeLevel: 'low' },
      { kind: 'uart-rx', pin: 'PA10' },
      { kind: 'uart-tx', pin: 'PA9' },
    ]);
  });
});
