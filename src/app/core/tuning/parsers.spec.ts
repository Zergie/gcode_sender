import { describe, expect, it } from 'vitest';

import { parseM105Telemetry, parseM503Snapshot } from './parsers';
import { TuningDomainError } from './tuning-error';

describe('firmware tuning parsers', () => {
  it('parses the supported firmware M105 shape with all three thermistors', () => {
    expect(parseM105Telemetry('T0:149.75 /150 @:255 T1:150.5 T2:149 T3:31.25', 12_345)).toEqual({
      atMs: 12_345,
      t0C: 149.75,
      t1C: 150.5,
      t2C: 149,
      t3C: 31.25,
      reportedTargetC: 150,
      output: 255,
      raw: 'T0:149.75 /150 @:255 T1:150.5 T2:149 T3:31.25',
    });
  });

  it('returns undefined for unrelated lines and rejects out-of-range output', () => {
    expect(parseM105Telemetry('ok', 1)).toBeUndefined();
    expect(() => parseM105Telemetry('T0:20 /0 @:256 T1:20 T2:20 T3:20', 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TELEMETRY' }),
    );
  });

  it('parses case-insensitive M503 rollback gains among other settings', () => {
    expect(parseM503Snapshot(['Heater Check Time: 20', 'kp: 25.0', 'KI: 1.25', 'Kd: 110'])).toEqual(
      { kp: 25, ki: 1.25, kd: 110 },
    );
  });

  it('refuses an incomplete or conflicting M503 snapshot', () => {
    expect(() => parseM503Snapshot(['kp: 25', 'ki: 1'])).toThrow(TuningDomainError);
    expect(() => parseM503Snapshot(['kp: 25', 'kp: 26', 'ki: 1', 'kd: 2'])).toThrowError(
      expect.objectContaining({ code: 'PID_SNAPSHOT_UNAVAILABLE' }),
    );
  });
});
