import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { snapshotSketch } from './source-snapshot';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('firmware sketch snapshot', () => {
  it('captures a bounded single-entry sketch and includes the selected entry in its hash', async () => {
    const first = await sketchDirectory('void setup() {}\nvoid loop() {}\n');
    const second = await sketchDirectory(
      'void setup() {}\nvoid loop() { digitalWrite(PB9, HIGH); }\n',
    );

    const left = await snapshotSketch(path.join(first, 'main.ino'));
    const right = await snapshotSketch(path.join(second, 'main.ino'));

    expect(left.public.files).toEqual(['main.ino']);
    expect(left.public.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(left.public.sha256).not.toBe(right.public.sha256);
  });

  it('rejects bin files, ambiguous ino directories, and host header includes', async () => {
    const directory = await sketchDirectory(
      '#include <windows.h>\nvoid setup() {}\nvoid loop() {}\n',
    );
    await expect(snapshotSketch(path.join(directory, 'main.ino'))).rejects.toThrow(
      'unsupported system include windows.h',
    );
    await writeFile(path.join(directory, 'second.ino'), 'void other() {}', 'utf8');
    await expect(snapshotSketch(path.join(directory, 'main.ino'))).rejects.toThrow(
      'exactly one .ino',
    );
    await expect(snapshotSketch(path.join(directory, 'firmware.bin'))).rejects.toThrow(
      'Select an Arduino .ino sketch',
    );
  });

  it('rejects macro includes, include_next, line continuations, and C translation units', async () => {
    const macro = await sketchDirectory(
      '#define HOST_HEADER <windows.h>\n#include HOST_HEADER\nvoid setup() {}\nvoid loop() {}\n',
    );
    await expect(snapshotSketch(path.join(macro, 'main.ino'))).rejects.toThrow(
      'noncanonical include',
    );

    const includeNext = await sketchDirectory(
      '#include_next <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n',
    );
    await expect(snapshotSketch(path.join(includeNext, 'main.ino'))).rejects.toThrow(
      'unsupported #include_next',
    );

    const continued = await sketchDirectory(
      '#include \\\n<Arduino.h>\nvoid setup() {}\nvoid loop() {}\n',
    );
    await expect(snapshotSketch(path.join(continued, 'main.ino'))).rejects.toThrow(
      'noncanonical include',
    );

    const splitKeyword = await sketchDirectory(
      '#inclu\\\nde <windows.h>\nvoid setup() {}\nvoid loop() {}\n',
    );
    await expect(snapshotSketch(path.join(splitKeyword, 'main.ino'))).rejects.toThrow(
      'noncanonical include directive with continuation',
    );

    const cUnit = await sketchDirectory('void setup() {}\nvoid loop() {}\n');
    await writeFile(path.join(cUnit, 'helper.c'), 'void helper(void) {}\n', 'utf8');
    await expect(snapshotSketch(path.join(cUnit, 'main.ino'))).rejects.toThrow(
      'does not support the C translation unit helper.c',
    );
  });

  it('rejects blocking delay calls without matching comments or string literals', async () => {
    const unsupported = await sketchDirectory('void setup() {}\nvoid loop() { delay(10); }\n');
    await expect(snapshotSketch(path.join(unsupported, 'main.ino'))).rejects.toMatchObject({
      code: 'FILE_INVALID',
      details: {
        firmwareDiagnosticCode: 'PERIPHERAL_UNSUPPORTED',
        peripheral: 'delay',
      },
    });

    const harmless = await sketchDirectory(
      [
        '// delay(10) is deliberately not called.',
        'const char *description = "delay(10)";',
        'const char *raw = R"tag("quoted" delay(10))tag";',
        '// A continued comment is spliced before tokenization. \\',
        'delay(20);',
        'void setup() {}',
        'void loop() {}',
        '',
      ].join('\n'),
    );
    await expect(snapshotSketch(path.join(harmless, 'main.ino'))).resolves.toBeDefined();

    const commentedInclude = await sketchDirectory(
      '/*\n#include <windows.h>\n*/\nvoid setup() {}\nvoid loop() {}\n',
    );
    await expect(snapshotSketch(path.join(commentedInclude, 'main.ino'))).resolves.toBeDefined();
  });
});

async function sketchDirectory(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'firmware-sketch-'));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'main.ino'), source, 'utf8');
  return directory;
}
