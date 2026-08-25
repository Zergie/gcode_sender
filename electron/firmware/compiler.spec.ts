import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FIRMWARE_WASM_ABI, type FirmwareBuildProvenance } from '../../shared/firmware-contracts';
import {
  createFirmwareBuildId,
  getFirmwareToolchainStatus,
  preprocessArduinoSketch,
  runCommand,
} from './compiler';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PROVENANCE: FirmwareBuildProvenance = {
  compiler: { adapter: 'docker-emscripten', identity: 'image@sha256:one', version: '4.0.20' },
  shim: { abi: FIRMWARE_WASM_ABI, version: '1.0.0', sha256: 'shim-one' },
  libraries: {
    QuickPID: { version: '3.1.9', sha256: 'quickpid-one' },
    GCodeParser: { version: '1.3.0', sha256: 'gcode-one' },
    NTC_Thermistor: { version: '2.1.0', sha256: 'ntc-one' },
  },
  flags: ['-O2'],
  sourceTransforms: [],
};

describe('firmware compiler adapter', () => {
  it('generates Arduino prototypes and applies only the supported QuickPID Clang rewrite', () => {
    const processed = preprocessArduinoSketch(`
QuickPID pid;
void setup() { pid.SetMode(pid.Control::automatic); }
void helper(uint32_t value) { (void)value; }
void loop() {}
`);
    expect(processed).toContain('void helper(uint32_t value);');
    expect(processed).toContain('pid.SetMode(QuickPID::Control::automatic)');
    expect(processed).toContain('void setup();');
    expect(processed).toContain('void loop();');
  });

  it('invalidates content-addressed build IDs for compiler, shim, library, and entry changes', () => {
    const baseline = createFirmwareBuildId('source', 'main.ino', PROVENANCE);
    expect(createFirmwareBuildId('source', 'other.ino', PROVENANCE)).not.toBe(baseline);
    expect(
      createFirmwareBuildId('source', 'main.ino', {
        ...PROVENANCE,
        compiler: { ...PROVENANCE.compiler, version: '4.0.21' },
      }),
    ).not.toBe(baseline);
    expect(
      createFirmwareBuildId('source', 'main.ino', {
        ...PROVENANCE,
        shim: { ...PROVENANCE.shim, sha256: 'shim-two' },
      }),
    ).not.toBe(baseline);
    expect(
      createFirmwareBuildId('source', 'main.ino', {
        ...PROVENANCE,
        libraries: { ...PROVENANCE.libraries, QuickPID: { version: '3.1.9', sha256: 'two' } },
      }),
    ).not.toBe(baseline);
  });

  it('prefers the pinned Docker image and accepts only local Emscripten 4.0.20', async () => {
    const invocations: string[] = [];
    const status = await getFirmwareToolchainStatus(async ({ command }) => {
      invocations.push(command);
      return command === 'em++'
        ? { exitCode: 0, stdout: 'emcc 4.0.20\n', stderr: '', error: null, timedOut: false }
        : { exitCode: 0, stdout: 'sha256:image\n', stderr: '', error: null, timedOut: false };
    });
    expect(invocations).toEqual(['em++', 'docker']);
    expect(status.selected).toBe('docker-emscripten');

    const unsupported = await getFirmwareToolchainStatus(async ({ command }) =>
      command === 'em++'
        ? { exitCode: 0, stdout: 'emcc 4.0.21\n', stderr: '', error: null, timedOut: false }
        : {
            exitCode: 1,
            stdout: '',
            stderr: 'Cannot connect to the Docker daemon',
            error: null,
            timedOut: false,
          },
    );
    expect(unsupported.available).toBe(false);
    expect(unsupported.adapters[0]?.detail).toContain('Unsupported local Emscripten');
    expect(unsupported.adapters[1]?.detail).toContain('Cannot connect to the Docker daemon');
    expect(unsupported.adapters[1]?.detail).toContain('docker pull');

    const prerelease = await getFirmwareToolchainStatus(async ({ command }) =>
      command === 'em++'
        ? { exitCode: 0, stdout: 'emcc 4.0.20-git\n', stderr: '', error: null, timedOut: false }
        : { exitCode: 1, stdout: '', stderr: '', error: null, timedOut: false },
    );
    expect(prerelease.adapters[0]?.available).toBe(false);
  });

  it('terminates a timed-out compiler process tree', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'firmware-timeout-'));
    temporaryDirectories.push(directory);
    const marker = path.join(directory, 'descendant-survived.txt');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 350); setInterval(() => {}, 1000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}]); setInterval(() => {}, 1000);`;
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', parent],
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(access(marker)).rejects.toThrow();
  }, 15_000);
});
