import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HeatingProfile } from '../shared/contracts';
import { parseHeatingProfileDocument } from '../shared/heating-profile-document';
import {
  forceGcodeExtension,
  heatingProfileDefaultFileName,
  writeHeatingProfileFile,
} from './heating-profile-file';

const temporaryDirectories: string[] = [];
const PROFILE: HeatingProfile = {
  version: 1,
  name: 'Top / bottom: 180 °C',
  interpolation: 'linear',
  points: [
    { timeMs: 0, targetC: 20 },
    { timeMs: 5_000, targetC: 21 },
  ],
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('heating profile files', () => {
  it('builds a Windows-safe default G-code name', () => {
    expect(heatingProfileDefaultFileName(PROFILE.name)).toBe('Top - bottom- 180 °C.gcode');
    expect(heatingProfileDefaultFileName('CON')).toBe('profile-CON.gcode');
  });

  it('forces the canonical extension even when another one was entered', () => {
    expect(forceGcodeExtension('C:\\profiles\\soak.txt')).toBe('C:\\profiles\\soak.gcode');
    expect(forceGcodeExtension('C:\\profiles\\soak')).toBe('C:\\profiles\\soak.gcode');
    expect(forceGcodeExtension('C:\\profiles\\soak.GCODE')).toBe('C:\\profiles\\soak.gcode');
  });

  it('atomically replaces the selected destination with a parseable profile', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-profile-save-'));
    temporaryDirectories.push(directory);
    const selectedPath = path.join(directory, 'existing.txt');
    const destination = path.join(directory, 'existing.gcode');
    await writeFile(destination, 'old contents', 'utf8');

    await expect(writeHeatingProfileFile(selectedPath, PROFILE)).resolves.toBe(destination);
    expect(parseHeatingProfileDocument(await readFile(destination, 'utf8'))).toEqual({
      ok: true,
      profile: PROFILE,
    });
  });
});
