import type {
  FirmwareBuildOutcome,
  FirmwareToolchainStatus,
} from '../../shared/firmware-contracts';
import { compileFirmware, getFirmwareToolchainStatus, type CommandRunner } from './compiler';
import { discoverFirmwarePins, suggestVirtualHardware } from './pin-discovery';
import { snapshotSketch } from './source-snapshot';

export interface FirmwareBuildServiceOptions {
  readonly userDataPath: string;
  readonly assetsPath: string;
  readonly commandRunner?: CommandRunner;
}

/**
 * Deep Electron-owned module for safe source capture, deterministic compilation,
 * toolchain selection, ABI verification and content-addressed caching.
 */
export class FirmwareBuildService {
  constructor(private readonly options: FirmwareBuildServiceOptions) {}

  getToolchainStatus(): Promise<FirmwareToolchainStatus> {
    return getFirmwareToolchainStatus(this.options.commandRunner);
  }

  async build(entryPath: string): Promise<FirmwareBuildOutcome> {
    const snapshot = await snapshotSketch(entryPath);
    const pins = discoverFirmwarePins(snapshot);
    const compiled = await compileFirmware(snapshot, {
      userDataPath: this.options.userDataPath,
      assetsPath: this.options.assetsPath,
      ...(this.options.commandRunner === undefined ? {} : { runner: this.options.commandRunner }),
    });
    if (compiled.status === 'failed') return compiled;
    return {
      status: 'ready',
      firmware: {
        artifact: {
          abi: 'arduino-fil-wasm-v1',
          buildId: compiled.buildId,
          sourceSha256: snapshot.public.sha256,
          wasmBytes: compiled.wasmBytes,
        },
        source: snapshot.public,
        discoveredPins: pins,
        suggestedHardware: suggestVirtualHardware(pins),
        toolchain: compiled.toolchain,
        diagnostics: compiled.diagnostics,
        provenance: compiled.provenance,
        cacheHit: compiled.cacheHit,
        toolchainCacheHit: compiled.toolchainCacheHit,
        fidelity: 'source-level firmware logic with semantic peripheral emulation',
      },
    };
  }
}
