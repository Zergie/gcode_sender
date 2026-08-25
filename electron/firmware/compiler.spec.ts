import { access, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FIRMWARE_WASM_ABI, type FirmwareBuildProvenance } from '../../shared/firmware-contracts';
import {
  createFirmwareBuildId,
  compileFirmware,
  getFirmwareToolchainStatus,
  prepareFirmwareToolchain,
  preprocessArduinoSketch,
  runCommand,
} from './compiler';
import { snapshotSketch } from './source-snapshot';

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const invalidFixturePath = path.join(
  repositoryRoot,
  'firmware-wasm',
  'invalid-compatibility-fixture',
  'main.ino',
);

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

  it('classifies unavailable prerequisites and failed pinned-image setup distinctly', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'firmware-toolchain-'));
    temporaryDirectories.push(directory);
    const unavailable = await prepareFirmwareToolchain(directory, async ({ command }) =>
      command === 'em++'
        ? { exitCode: null, stdout: '', stderr: '', error: 'spawn em++ ENOENT', timedOut: false }
        : {
            exitCode: null,
            stdout: '',
            stderr: 'Cannot connect to the Docker daemon',
            error: null,
            timedOut: false,
          },
    );
    expect(unavailable.status).toBe('unavailable');
    if (unavailable.status !== 'unavailable') throw new Error('expected unavailable setup');
    expect(unavailable.diagnostics[0]?.code).toBe('TOOLCHAIN_UNAVAILABLE');

    const failed = await prepareFirmwareToolchain(directory, async ({ command, args }) => {
      if (command === 'em++')
        return { exitCode: 1, stdout: '', stderr: '', error: null, timedOut: false };
      if (args[0] === 'image')
        return { exitCode: 1, stdout: '', stderr: 'No such image', error: null, timedOut: false };
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'registry unavailable',
        error: null,
        timedOut: false,
      };
    });
    expect(failed.status).toBe('setup-failed');
    if (failed.status !== 'setup-failed') throw new Error('expected setup failure');
    expect(failed.diagnostics[0]?.code).toBe('TOOLCHAIN_SETUP_FAILED');
    expect(failed.diagnostics[0]?.message).toContain('docker pull');
  });

  it('records verified pinned-toolchain reuse without invoking acquisition again', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'firmware-toolchain-warm-'));
    temporaryDirectories.push(directory);
    const calls: string[] = [];
    const runner = async ({ command, args }: { command: string; args: readonly string[] }) => {
      calls.push(`${command} ${args.join(' ')}`);
      return command === 'em++'
        ? { exitCode: 1, stdout: '', stderr: '', error: null, timedOut: false }
        : { exitCode: 0, stdout: 'sha256:pinned\n', stderr: '', error: null, timedOut: false };
    };
    const cold = await prepareFirmwareToolchain(directory, runner);
    const warm = await prepareFirmwareToolchain(directory, runner);
    expect(cold).toMatchObject({ status: 'ready', cacheHit: false });
    expect(warm).toMatchObject({ status: 'ready', cacheHit: true });
    expect(calls.filter((call) => call.startsWith('docker pull'))).toHaveLength(0);
  });

  it('reports an invalid repository fixture as a compiler failure with source diagnostics', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'firmware-invalid-fixture-'));
    temporaryDirectories.push(directory);
    const snapshot = await snapshotSketch(invalidFixturePath);
    const result = await compileFirmware(snapshot, {
      userDataPath: directory,
      assetsPath: path.join(repositoryRoot, 'firmware-wasm'),
      runner: async ({ command, args }) => {
        if (command === 'em++' && args[0] === '--version') {
          return {
            exitCode: 0,
            stdout: 'emcc (Emscripten clang-like replacement + linker) 4.0.20\n',
            stderr: '',
            error: null,
            timedOut: false,
          };
        }
        if (command === 'docker') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'Docker unavailable in this offline unit test',
            error: null,
            timedOut: false,
          };
        }
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            '/work/generated/main.ino.cpp:5:3: error: use of undeclared identifier invalid_fixture_symbol\n',
          error: null,
          timedOut: false,
        };
      },
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected compiler failure');
    expect(result.toolchain.selected).toBe('local-em++');
    expect(result.diagnostics).toEqual([
      {
        severity: 'error',
        phase: 'compile',
        code: 'COMPILE_FAILED',
        message: 'use of undeclared identifier invalid_fixture_symbol',
        file: 'main.ino.cpp',
        line: 5,
        column: 3,
      },
    ]);
    expect(result.diagnostics[0]?.code).not.toBe('TOOLCHAIN_UNAVAILABLE');
    expect(result.diagnostics[0]?.code).not.toBe('TOOLCHAIN_SETUP_FAILED');
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
