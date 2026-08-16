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

  it('parses the exact legacy M115 response emitted by the connected STM32 firmware', () => {
    const line =
      'FIRMWARE_NAME: Arduino Gcode Interpreter v0.3 SOURCE_CODE_URL: https://github.com/Zergie PROTOCOL_VERSION: 1.0 MACHINE_TYPE: DIY Toaster UUID: 554d5e22-d685-4c68-973a-b57ff1e82f6f';

    const parsed = parseFirmwareLine(line);

    expect(parsed).toMatchObject({
      kind: 'firmware',
      value: {
        firmwareName: 'Arduino Gcode Interpreter v0.3',
        sourceCodeUrl: 'https://github.com/Zergie',
        protocolVersion: '1.0',
        machineType: 'DIY Toaster',
        uuid: '554d5e22-d685-4c68-973a-b57ff1e82f6f',
      },
    });
    expect(isCompletionForCommand('M115', parsed)).toBe(true);
  });

  it('does not treat an isolated firmware-name message as an M115 handshake', () => {
    expect(parseM115('FIRMWARE_NAME: unrelated terminal output')).toBeNull();
  });

  it.each([
    'FIRMWARE_NAME:x SOURCE_CODE_URL: PROTOCOL_VERSION:1 MACHINE_TYPE:OVEN UUID:abc',
    'FIRMWARE_NAME:x SOURCE_CODE_URL:https://example.test PROTOCOL_VERSION: MACHINE_TYPE:OVEN UUID:abc',
    'FIRMWARE_NAME:x SOURCE_CODE_URL:https://example.test PROTOCOL_VERSION:1 MACHINE_TYPE: UUID:abc',
    'FIRMWARE_NAME:x SOURCE_CODE_URL:https://example.test PROTOCOL_VERSION:1 MACHINE_TYPE:OVEN UUID:',
    'FIRMWARE_NAME:x SOURCE_CODE_URL:https://example.test PROTOCOL_VERSION:1 MACHINE_TYPE:OVEN UUID:a UUID:b',
  ])('rejects malformed M115 identity fields: %s', (line) => {
    expect(parseM115(line)).toBeNull();
    expect(isCompletionForCommand('M115', parseFirmwareLine(line))).toBe(false);
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
