import { describe, expect, it } from 'vitest';

import { isCompletionForCommand, parseFirmwareLine, parseM105, parseM115 } from './protocol';

describe('firmware protocol parser', () => {
  it('parses the exact M105 response shape', () => {
    expect(parseM105('T0:120.25 /180 @:255 T1:119.5 T2:121.0 T3:42.25', 'now')).toEqual({
      timestamp: 'now',
      average: 120.25,
      target: 180,
      power: 255,
      thermistors: [119.5, 121, 42.25],
      raw: 'T0:120.25 /180 @:255 T1:119.5 T2:121.0 T3:42.25',
    });
  });

  it('does not accept partial telemetry', () => {
    expect(parseM105('T0:120 /180 @:255 T1:119 T2:121')).toBeNull();
  });

  it('parses the supported M115 tagged response', () => {
    const line =
      'FIRMWARE_NAME:PID TEMP 1.0 SOURCE_CODE_URL:https://example.test/src G_CODE_URL:https://example.test/gcode.json PROTOCOL_VERSION:1 MACHINE_TYPE:OVEN UUID:abc';
    expect(parseM115(line)).toMatchObject({
      firmwareName: 'PID TEMP 1.0',
      sourceCodeUrl: 'https://example.test/src',
      gcodeCatalogUrl: 'https://example.test/gcode.json',
      protocolVersion: '1',
      machineType: 'OVEN',
      uuid: 'abc',
    });
  });

  it('uses command-specific completion responses', () => {
    expect(
      isCompletionForCommand('M105', parseFirmwareLine('T0:20 /0 @:0 T1:20 T2:20 T3:20')),
    ).toBe(true);
    expect(isCompletionForCommand('M115', parseFirmwareLine('ok'))).toBe(false);
    expect(isCompletionForCommand('M104 S100', parseFirmwareLine('ok'))).toBe(true);
    expect(
      isCompletionForCommand('M503', parseFirmwareLine('Heater Temperatur Range 2: 0 - 80')),
    ).toBe(true);
  });

  it.each([
    'Unknown G command!',
    'Unknown M command!',
    'Unknown command!',
    'Parameter H (heater) is required!',
  ])('classifies supported-firmware negative response %s as an error', (line) => {
    const parsed = parseFirmwareLine(line);
    expect(parsed).toEqual({ kind: 'error', message: line });
    expect(isCompletionForCommand('M104 S100', parsed)).toBe(true);
  });
});
