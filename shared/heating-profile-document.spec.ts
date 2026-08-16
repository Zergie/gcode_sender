import { describe, expect, it } from 'vitest';

import {
  compileHeatingProfileCommands,
  parseHeatingProfileDocument,
  serializeHeatingProfileDocument,
  validateHeatingProfile,
} from './heating-profile-document';
import type { HeatingProfile } from './contracts';
import { normalizeGcodeLine } from './job-normalizer';

const PROFILE: HeatingProfile = {
  version: 1,
  name: 'Ramp and soak',
  interpolation: 'linear',
  points: [
    { timeMs: 0, targetC: 20 },
    { timeMs: 12_001, targetC: 24 },
    { timeMs: 17_001, targetC: 24 },
  ],
};

describe('heating profile G-code documents', () => {
  it('round-trips canonical metadata and executable commands', () => {
    const source = serializeHeatingProfileDocument(PROFILE);

    expect(parseHeatingProfileDocument(source)).toEqual({ ok: true, profile: PROFILE });
    expect(source).toContain('; GCODE_SENDER_HEATING_PROFILE_BEGIN 1');
    expect(source).toContain('; GCODE_SENDER_HEATING_PROFILE_POINT {"timeMs":12001,"targetC":24}');
  });

  it('round-trips Unicode and JSON-sensitive names through BOM and CRLF input', () => {
    const profile: HeatingProfile = { ...PROFILE, name: 'Crème "top" \\ bottom 🔥' };
    const source = `\uFEFF${serializeHeatingProfileDocument(profile).replaceAll('\n', '\r\n')}`;

    expect(parseHeatingProfileDocument(source)).toEqual({ ok: true, profile });
  });

  it('emits metadata solely as G-code comments', () => {
    const metadata = serializeHeatingProfileDocument(PROFILE).split('\n').slice(0, 6);

    expect(metadata.every((line) => normalizeGcodeLine(line).command === null)).toBe(true);
  });

  it('uses exact-duration dwell chunks of at most five seconds and target steps of at most 1 C', () => {
    const commands = compileHeatingProfileCommands(PROFILE);
    const dwells = commands
      .filter((command) => command.startsWith('G4 P'))
      .map((command) => Number(command.slice(4)));
    const targets = commands
      .filter((command) => command.startsWith('M104 S'))
      .slice(0, -1)
      .map((command) => Number(command.slice(6)));

    expect(dwells.reduce((sum, dwell) => sum + dwell, 0)).toBe(17_001);
    expect(Math.max(...dwells)).toBeLessThanOrEqual(5_000);
    expect(
      targets.every((target, index) => index === 0 || Math.abs(target - targets[index - 1]!) <= 1),
    ).toBe(true);
    expect(commands.at(-1)).toBe('M104 S0');
    expect(commands.some((command) => command.startsWith('M109'))).toBe(false);
  });

  it('accepts normalized formatting but rejects executable-body changes', () => {
    const canonical = serializeHeatingProfileDocument(PROFILE);
    const formatted = canonical
      .replaceAll('\n', '\r\n')
      .replace('M104 S20', ' M104   S20 ; target');
    expect(parseHeatingProfileDocument(formatted)).toEqual({ ok: true, profile: PROFILE });

    const changed = canonical.replace('M104 S22', 'M104 S99');
    expect(parseHeatingProfileDocument(changed)).toMatchObject({ ok: false });
  });

  it('validates the bounded version-1 schema', () => {
    expect(() =>
      validateHeatingProfile({
        ...PROFILE,
        points: [{ timeMs: 1, targetC: 20 }, PROFILE.points[1]!],
      }),
    ).toThrow(/start at 0/);
    expect(() =>
      validateHeatingProfile({
        ...PROFILE,
        points: [
          { timeMs: 0, targetC: 20 },
          { timeMs: 1, targetC: 20.5 },
        ],
      }),
    ).toThrow(/whole degrees/);
    expect(() =>
      validateHeatingProfile({
        ...PROFILE,
        points: Array.from({ length: 129 }, (_, index) => ({ timeMs: index, targetC: 20 })),
      }),
    ).toThrow(/128/);
    expect(() =>
      validateHeatingProfile({
        ...PROFILE,
        points: [
          { timeMs: 0, targetC: 20 },
          { timeMs: 86_400_001, targetC: 20 },
        ],
      }),
    ).toThrow(/24 hours/);
  });

  it('reports malformed metadata without treating it as a trusted profile', () => {
    expect(
      parseHeatingProfileDocument(
        '; GCODE_SENDER_HEATING_PROFILE_BEGIN 1\n; GCODE_SENDER_HEATING_PROFILE_HEADER nope\n',
      ),
    ).toMatchObject({ ok: false });
  });
});
