import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { FirmwareBuildService } from './firmware-build-service';

const runIntegration = process.env['RUN_FIRMWARE_WASM_INTEGRATION'] === '1';
const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = path.join(repositoryRoot, 'firmware-wasm', 'compatibility-fixture', 'main.ino');
const assetsPath = path.join(repositoryRoot, 'firmware-wasm');

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.runIf(runIntegration)('firmware build integration', () => {
  it('compiles the supported sketch to an import-free, cached Wasm artifact', async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), 'firmware build integration-'));
    temporaryDirectories.push(userDataPath);
    const service = new FirmwareBuildService({
      userDataPath,
      assetsPath,
    });
    const sketch = fixturePath;

    const cold = await service.build(sketch);
    if (cold.status !== 'ready') {
      throw new Error(JSON.stringify(cold.diagnostics));
    }
    expect(cold.firmware.artifact.wasmBytes.byteLength).toBeGreaterThan(0);
    expect(cold.firmware.cacheHit).toBe(false);
    expect(cold.firmware.toolchainCacheHit).toBe(false);
    expect(cold.firmware.provenance.compiler.identity).toContain('emscripten/emsdk:4.0.20');
    expect(cold.firmware.provenance.libraries).toMatchObject({
      GCodeParser: { version: '1.3.0' },
      NTC_Thermistor: { version: '2.1.0' },
      QuickPID: { version: '3.1.9' },
    });
    expect(cold.firmware.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SOURCE_COMPATIBILITY_REWRITE' }),
        expect.objectContaining({ code: 'COMPILER_WARNING' }),
      ]),
    );

    const module = new WebAssembly.Module(cold.firmware.artifact.wasmBytes);
    const exportedNames = WebAssembly.Module.exports(module).map(({ name }) => name);
    expect(exportedNames).toEqual(
      expect.arrayContaining([
        'fil_abi_version',
        'fil_alloc',
        'fil_free',
        'fil_set_analog_input',
        'fil_set_digital_input',
        'fil_load_eeprom',
        'fil_boot',
        'fil_advance',
        'fil_enqueue_serial',
        'fil_drain_serial',
        'fil_get_pin_level',
        'fil_get_serial_rx_pin',
        'fil_get_serial_tx_pin',
        'fil_take_active_micros',
        'fil_take_elapsed_micros',
        'fil_get_reset_count',
        'fil_dump_eeprom',
      ]),
    );

    const warm = await service.build(sketch);
    expect(warm.status).toBe('ready');
    if (warm.status === 'ready') {
      expect(warm.firmware.cacheHit).toBe(true);
      expect(warm.firmware.toolchainCacheHit).toBe(true);
      expect(warm.firmware.diagnostics).toEqual(cold.firmware.diagnostics);
    }
    const cachePath = path.join(
      userDataPath,
      'firmware-cache',
      'v1',
      `${cold.firmware.artifact.buildId}.wasm`,
    );
    await writeFile(cachePath, new Uint8Array([0, 1, 2, 3]));
    const recovered = await service.build(sketch);
    expect(recovered.status).toBe('ready');
    if (recovered.status === 'ready') {
      expect(recovered.firmware.cacheHit).toBe(false);
      expect(recovered.firmware.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'CACHE_CORRUPT' })]),
      );
    }
    process.stdout.write(
      `FIL_BUILD_REPORT ${JSON.stringify({
        artifactBytes: cold.firmware.artifact.wasmBytes.byteLength,
        imports: WebAssembly.Module.imports(module),
        exports: exportedNames,
        coldCacheHit: cold.firmware.cacheHit,
        warmCacheHit: warm.status === 'ready' && warm.firmware.cacheHit,
        coldToolchainCacheHit: cold.status === 'ready' && cold.firmware.toolchainCacheHit,
        warmToolchainCacheHit: warm.status === 'ready' && warm.firmware.toolchainCacheHit,
        corruptCacheRecovered: recovered.status === 'ready' && !recovered.firmware.cacheHit,
        diagnostics: cold.firmware.diagnostics,
        buildId: cold.firmware.artifact.buildId,
        provenance: cold.firmware.provenance,
      })}\n`,
    );
  }, 180_000);
});
