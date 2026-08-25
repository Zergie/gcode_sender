import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  FIRMWARE_ARTIFACT_MAX_BYTES,
  FIRMWARE_WASM_ABI,
  type FirmwareBuildProvenance,
  type FirmwareDiagnostic,
  type FirmwareToolchainAdapterKind,
  type FirmwareToolchainAdapterStatus,
  type FirmwareToolchainStatus,
} from '../../shared/firmware-contracts';
import type { SketchSnapshot } from './source-snapshot';

export const EMSCRIPTEN_DOCKER_IMAGE =
  'emscripten/emsdk:4.0.20@sha256:460fff8f8ac87e11b16447fbd66538a686eafa0e4fb977aa0989ed19fe2079f7';
export const FIRMWARE_SHIM_VERSION = '1.2.0';

const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_TERMINATION_GRACE_MS = 5_000;
const COMMAND_OUTPUT_LIMIT = 256 * 1024;
const DEPENDENCY_FILE_MAX_BYTES = 1024 * 1024;
const DEPENDENCY_TOTAL_MAX_BYTES = 5 * 1024 * 1024;
const CACHE_MANIFEST_MAX_BYTES = 256 * 1024;
const SUPPORTED_EMSCRIPTEN_VERSION = '4.0.20';
const CACHE_MANIFEST_VERSION = 1;
const LIBRARIES = {
  GCodeParser: {
    version: '1.3.0',
    files: ['library.properties', 'LICENSE', 'GCodeParser.h', 'GCodeParser.cpp'],
  },
  NTC_Thermistor: {
    version: '2.1.0',
    files: [
      'library.properties',
      'LICENSE',
      'Thermistor.h',
      'NTC_Thermistor.h',
      'NTC_Thermistor.cpp',
      'AverageThermistor.h',
      'AverageThermistor.cpp',
      'SmoothThermistor.h',
      'SmoothThermistor.cpp',
    ],
  },
  QuickPID: {
    version: '3.1.9',
    files: ['library.properties', 'LICENSE', 'QuickPID.h', 'QuickPID.cpp'],
  },
} as const;
const REQUIRED_EXPORTS = [
  'memory',
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
] as const;
const EXPORTED_FUNCTIONS = REQUIRED_EXPORTS.filter((name) => name !== 'memory').map(
  (name) => `_${name}`,
);
const STABLE_FLAGS = [
  '-std=gnu++17',
  '-O2',
  '-fno-exceptions',
  '-fno-rtti',
  '-Werror=date-time',
  '-sSTANDALONE_WASM=1',
  '-sPURE_WASI=1',
  '-sFILESYSTEM=0',
  '-sALLOW_MEMORY_GROWTH=0',
  '-sINITIAL_MEMORY=16777216',
  '-sMALLOC=emmalloc',
  '--no-entry',
] as const;
const CLANG_QUICKPID_ENUM_REWRITE = 'clang-instance-qualified-quickpid-control-v1';

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly dockerCleanup?: {
    readonly containerName: string;
    readonly cidFile: string;
  };
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
  readonly timedOut: boolean;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;

interface Toolchain {
  readonly kind: FirmwareToolchainAdapterKind;
  readonly displayName: string;
  readonly identity: string;
  readonly version: string;
  invoke(stagePath: string, arguments_: readonly string[]): CommandInvocation;
}

export interface CompileContext {
  readonly userDataPath: string;
  readonly assetsPath: string;
  readonly runner?: CommandRunner;
}

export type FirmwareToolchainSetupResult =
  | {
      readonly status: 'ready';
      readonly toolchain: FirmwareToolchainStatus;
      readonly cacheHit: boolean;
    }
  | {
      readonly status: 'unavailable' | 'setup-failed';
      readonly toolchain: FirmwareToolchainStatus;
      readonly diagnostics: readonly FirmwareDiagnostic[];
    };

export type FirmwareCompileResult =
  | {
      readonly status: 'ready';
      readonly buildId: string;
      readonly wasmBytes: Uint8Array;
      readonly cacheHit: boolean;
      readonly toolchainCacheHit: boolean;
      readonly toolchain: FirmwareToolchainStatus;
      readonly provenance: FirmwareBuildProvenance;
      readonly diagnostics: readonly FirmwareDiagnostic[];
    }
  | {
      readonly status: 'failed';
      readonly toolchain: FirmwareToolchainStatus;
      readonly diagnostics: readonly FirmwareDiagnostic[];
    };

export async function getFirmwareToolchainStatus(
  runner: CommandRunner = runCommand,
): Promise<FirmwareToolchainStatus> {
  const [local, docker] = await Promise.all([inspectLocalEmpp(runner), inspectDocker(runner)]);
  const selected = docker.available ? docker.kind : local.available ? local.kind : null;
  return { available: selected !== null, selected, adapters: [local, docker] };
}

/** Verify or acquire the one supported toolchain without allowing arbitrary images or compilers. */
export async function prepareFirmwareToolchain(
  userDataPath: string,
  runner: CommandRunner = runCommand,
): Promise<FirmwareToolchainSetupResult> {
  const initial = await getFirmwareToolchainStatus(runner);
  const selected = initial.adapters.find(({ kind }) => kind === initial.selected);
  if (selected?.available === true) {
    const cachePath = toolchainCachePath(userDataPath, selected);
    const cached = await readVerifiedToolchain(cachePath, selected);
    if (!cached) {
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(
        cachePath,
        JSON.stringify({
          kind: selected.kind,
          identity: selected.detail,
          version: selected.version,
        }),
      );
    }
    return { status: 'ready', toolchain: initial, cacheHit: cached };
  }

  const docker = initial.adapters.find(({ kind }) => kind === 'docker-emscripten');
  const dockerFailure = docker?.detail ?? '';
  if (docker === undefined || /not found|cannot connect|daemon/i.test(dockerFailure)) {
    return {
      status: 'unavailable',
      toolchain: initial,
      diagnostics: [
        diagnostic(
          'error',
          'toolchain',
          'TOOLCHAIN_UNAVAILABLE',
          `Pinned Emscripten prerequisites are unavailable. ${dockerFailure || 'Install Docker or Emscripten 4.0.20.'}`,
        ),
      ],
    };
  }

  const pull = await runner({
    command: 'docker',
    args: ['pull', EMSCRIPTEN_DOCKER_IMAGE],
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (pull.exitCode !== 0 || pull.timedOut) {
    return {
      status: 'setup-failed',
      toolchain: initial,
      diagnostics: [
        diagnostic(
          'error',
          'toolchain',
          'TOOLCHAIN_SETUP_FAILED',
          `Unable to acquire pinned Emscripten image ${EMSCRIPTEN_DOCKER_IMAGE} with docker pull: ${commandFailureDetail(pull, 'command failed')}`,
        ),
      ],
    };
  }
  const verified = await getFirmwareToolchainStatus(runner);
  const verifiedDocker = verified.adapters.find(({ kind }) => kind === 'docker-emscripten');
  if (verifiedDocker?.available !== true) {
    return {
      status: 'setup-failed',
      toolchain: verified,
      diagnostics: [
        diagnostic(
          'error',
          'toolchain',
          'TOOLCHAIN_SETUP_FAILED',
          `Pinned Emscripten image acquisition completed but identity verification failed: ${verifiedDocker?.detail ?? 'adapter missing'}`,
        ),
      ],
    };
  }
  const cachePath = toolchainCachePath(userDataPath, verifiedDocker);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify({
      kind: verifiedDocker.kind,
      identity: verifiedDocker.detail,
      version: verifiedDocker.version,
    }),
  );
  return { status: 'ready', toolchain: verified, cacheHit: false };
}

async function readVerifiedToolchain(
  cachePath: string,
  adapter: FirmwareToolchainAdapterStatus,
): Promise<boolean> {
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>;
    return (
      cached['kind'] === adapter.kind &&
      cached['identity'] === adapter.detail &&
      cached['version'] === adapter.version
    );
  } catch {
    return false;
  }
}

function toolchainCachePath(userDataPath: string, adapter: FirmwareToolchainAdapterStatus): string {
  const identity = JSON.stringify({
    kind: adapter.kind,
    identity: adapter.detail,
    version: adapter.version,
  });
  return containedPath(
    userDataPath,
    'firmware-toolchain',
    'v1',
    sha256(new TextEncoder().encode(identity)),
    'verified.json',
  );
}

export async function compileFirmware(
  snapshot: SketchSnapshot,
  context: CompileContext,
): Promise<FirmwareCompileResult> {
  const runner = context.runner ?? runCommand;
  const setup = await prepareFirmwareToolchain(context.userDataPath, runner);
  if (setup.status !== 'ready') {
    return { status: 'failed', toolchain: setup.toolchain, diagnostics: setup.diagnostics };
  }
  const status = setup.toolchain;
  const adapterStatus = status.adapters.find(({ kind }) => kind === status.selected);
  if (adapterStatus === undefined || !adapterStatus.available || adapterStatus.version === null) {
    return {
      status: 'failed',
      toolchain: status,
      diagnostics: [
        diagnostic(
          'error',
          'toolchain',
          'TOOLCHAIN_UNAVAILABLE',
          `No supported WebAssembly C++ compiler is available. Start Docker and run "docker pull ${EMSCRIPTEN_DOCKER_IMAGE}", or activate local Emscripten ${SUPPORTED_EMSCRIPTEN_VERSION}.`,
        ),
      ],
    };
  }
  const toolchain = createToolchain(adapterStatus);
  const cacheRoot = containedPath(context.userDataPath, 'firmware-cache', 'v1');
  const buildRoot = containedPath(context.userDataPath, 'firmware-builds');
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(buildRoot, { recursive: true });

  let dependencySet: Awaited<ReturnType<typeof resolveDependencies>>;
  try {
    dependencySet = await resolveDependencies(context.assetsPath);
  } catch (error) {
    return {
      status: 'failed',
      toolchain: status,
      diagnostics: [
        diagnostic(
          'error',
          'source',
          'DEPENDENCY_UNAVAILABLE',
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }

  const shimSha256 = hashSnapshotFiles(dependencySet.shimFiles);
  const entrySource = snapshot.files.find(
    ({ relativePath }) => relativePath === path.basename(snapshot.entryPath),
  )?.text;
  const sourceTransforms =
    entrySource !== undefined && needsQuickPidEnumRewrite(entrySource)
      ? [CLANG_QUICKPID_ENUM_REWRITE]
      : [];
  const libraryHashes = Object.fromEntries(
    Object.entries(dependencySet.libraries).map(([name, library]) => [
      name,
      { version: library.version, sha256: hashSnapshotFiles(library.files) },
    ]),
  );
  const provenance: FirmwareBuildProvenance = {
    compiler: { adapter: toolchain.kind, identity: toolchain.identity, version: toolchain.version },
    shim: { abi: FIRMWARE_WASM_ABI, version: FIRMWARE_SHIM_VERSION, sha256: shimSha256 },
    libraries: libraryHashes,
    flags: STABLE_FLAGS,
    sourceTransforms,
  };
  const buildId = createFirmwareBuildId(
    snapshot.public.sha256,
    path.basename(snapshot.entryPath),
    provenance,
  );
  const cachePath = containedPath(cacheRoot, `${buildId}.wasm`);
  const cacheManifestPath = containedPath(cacheRoot, `${buildId}.json`);
  await removeStaleCacheTemps(cacheRoot, buildId);
  const cached = await readFirmwareCache(cachePath, cacheManifestPath, buildId);
  if (cached.status === 'valid') {
    return {
      status: 'ready',
      buildId,
      wasmBytes: cached.bytes,
      cacheHit: true,
      toolchainCacheHit: setup.cacheHit,
      toolchain: status,
      provenance,
      diagnostics: cached.diagnostics,
    };
  }
  const cacheDiagnostics =
    cached.status === 'corrupt'
      ? [
          diagnostic(
            'warning',
            'cache',
            'CACHE_CORRUPT',
            `Ignored and rebuilt an invalid firmware cache entry: ${cached.reason}`,
          ),
        ]
      : [];
  await Promise.all([rm(cachePath, { force: true }), rm(cacheManifestPath, { force: true })]);

  const stagePath = containedPath(buildRoot, `${buildId}-${randomUUID()}`);
  await mkdir(stagePath, { recursive: true });
  try {
    await stageBuild(snapshot, dependencySet, stagePath);
    const compileArgs = compilerArguments(toolchain.kind === 'docker-emscripten', snapshot);
    const result = await runner(toolchain.invoke(stagePath, compileArgs));
    if (result.timedOut || result.exitCode !== 0) {
      return {
        status: 'failed',
        toolchain: status,
        diagnostics: [...cacheDiagnostics, ...parseCompilerDiagnostics(result, result.timedOut)],
      };
    }
    const outputPath = containedPath(stagePath, 'firmware.wasm');
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedRegularFile(outputPath, FIRMWARE_ARTIFACT_MAX_BYTES);
    } catch (error) {
      return {
        status: 'failed',
        toolchain: status,
        diagnostics: [
          ...cacheDiagnostics,
          diagnostic(
            'error',
            'link',
            'ABI_INCOMPATIBLE',
            `Compiler produced an unreadable or oversized Wasm artifact: ${errorMessage(error)}`,
          ),
        ],
      };
    }
    const abiError = validateWasmAbi(bytes);
    if (abiError !== null) {
      return {
        status: 'failed',
        toolchain: status,
        diagnostics: [
          ...cacheDiagnostics,
          diagnostic('error', 'link', 'ABI_INCOMPATIBLE', abiError),
        ],
      };
    }
    const buildDiagnostics = [
      ...compatibilityDiagnostics(sourceTransforms),
      ...parseCompilerWarnings(`${result.stderr}\n${result.stdout}`),
    ];
    await writeFirmwareCache(
      cacheRoot,
      cachePath,
      cacheManifestPath,
      buildId,
      bytes,
      buildDiagnostics,
    );
    return {
      status: 'ready',
      buildId,
      wasmBytes: bytes,
      cacheHit: false,
      toolchainCacheHit: setup.cacheHit,
      toolchain: status,
      provenance,
      diagnostics: [...cacheDiagnostics, ...buildDiagnostics],
    };
  } finally {
    // A cleanup failure must never replace the structured compiler/link result.
    await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeStaleCacheTemps(cacheRoot: string, buildId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cacheRoot);
  } catch {
    return;
  }
  const prefix = `${buildId}.`;
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'))
      .map((entry) => rm(containedPath(cacheRoot, entry), { force: true })),
  );
}

export function createFirmwareBuildId(
  sourceSha256: string,
  entryFileName: string,
  provenance: FirmwareBuildProvenance,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ source: sourceSha256, entry: entryFileName, provenance }))
    .digest('hex');
}

function createToolchain(status: FirmwareToolchainAdapterStatus): Toolchain {
  if (status.version === null) throw new Error('Toolchain version is unavailable');
  if (status.kind === 'local-em++') {
    return {
      kind: status.kind,
      displayName: status.displayName,
      identity: 'em++',
      version: status.version,
      invoke: (stagePath, arguments_) => ({
        command: 'em++',
        args: arguments_,
        cwd: stagePath,
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    };
  }
  return {
    kind: status.kind,
    displayName: status.displayName,
    identity: EMSCRIPTEN_DOCKER_IMAGE,
    version: status.version,
    invoke: (stagePath, arguments_) => {
      const token = path
        .basename(stagePath)
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(-63);
      const containerName = `gcode-fil-${token}`;
      const cidFile = containedPath(stagePath, '.docker.cid');
      return {
        command: 'docker',
        args: [
          'run',
          '--rm',
          '--name',
          containerName,
          '--cidfile',
          cidFile,
          '--network',
          'none',
          '--memory',
          '1g',
          '--memory-swap',
          '1g',
          '--cpus',
          '2',
          '--pids-limit',
          '256',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--mount',
          `type=bind,source=${stagePath},target=/work`,
          '--workdir',
          '/work',
          EMSCRIPTEN_DOCKER_IMAGE,
          'em++',
          ...arguments_,
        ],
        timeoutMs: COMMAND_TIMEOUT_MS,
        dockerCleanup: { containerName, cidFile },
      };
    },
  };
}

async function inspectLocalEmpp(runner: CommandRunner): Promise<FirmwareToolchainAdapterStatus> {
  const result = await runner({ command: 'em++', args: ['--version'], timeoutMs: 5000 });
  const version = firstLine(result.stdout || result.stderr);
  const reportedVersion = /\b(\d+\.\d+\.\d+)(?=\s|$)/.exec(version)?.[1] ?? null;
  const exactVersion = reportedVersion === SUPPORTED_EMSCRIPTEN_VERSION;
  const available = result.exitCode === 0 && exactVersion;
  return {
    kind: 'local-em++',
    available,
    displayName: 'Local Emscripten em++',
    version: available ? version : null,
    detail:
      result.exitCode === 0 && !exactVersion
        ? `Unsupported local Emscripten (${version || 'unknown version'}); activate ${SUPPORTED_EMSCRIPTEN_VERSION}.`
        : available
          ? version
          : commandFailureDetail(result, 'em++ was not found on PATH.'),
  };
}

async function inspectDocker(runner: CommandRunner): Promise<FirmwareToolchainAdapterStatus> {
  const result = await runner({
    command: 'docker',
    args: ['image', 'inspect', '--format', '{{.Id}}', EMSCRIPTEN_DOCKER_IMAGE],
    timeoutMs: 5000,
  });
  const imageId = firstLine(result.stdout);
  return {
    kind: 'docker-emscripten',
    available: result.exitCode === 0,
    displayName: 'Docker Emscripten 4.0.20',
    version: result.exitCode === 0 ? `4.0.20 (${imageId})` : null,
    detail:
      result.exitCode === 0
        ? EMSCRIPTEN_DOCKER_IMAGE
        : `${commandFailureDetail(result, 'Docker or the pinned image is unavailable.')} Start Docker, then run "docker pull ${EMSCRIPTEN_DOCKER_IMAGE}".`,
  };
}

function compilerArguments(docker: boolean, snapshot: SketchSnapshot): readonly string[] {
  const root = docker ? '/work' : '.';
  const includes = [
    `${root}/shim/include`,
    `${root}/sketch`,
    `${root}/vendor/GCodeParser`,
    `${root}/vendor/NTC_Thermistor`,
    `${root}/vendor/QuickPID`,
  ].flatMap((directory) => ['-I', directory]);
  const sketchTranslationUnits = snapshot.files
    .filter(({ relativePath }) => path.extname(relativePath).toLowerCase() === '.cpp')
    .map(({ relativePath }) => `${root}/sketch/${relativePath}`);
  return [
    ...STABLE_FLAGS,
    `-sEXPORTED_FUNCTIONS=${JSON.stringify(EXPORTED_FUNCTIONS)}`,
    ...includes,
    `${root}/generated/main.ino.cpp`,
    ...sketchTranslationUnits,
    `${root}/vendor/GCodeParser/GCodeParser.cpp`,
    `${root}/vendor/NTC_Thermistor/NTC_Thermistor.cpp`,
    `${root}/vendor/NTC_Thermistor/AverageThermistor.cpp`,
    `${root}/vendor/NTC_Thermistor/SmoothThermistor.cpp`,
    `${root}/vendor/QuickPID/QuickPID.cpp`,
    `${root}/shim/src/arduino-fil.cpp`,
    '-o',
    `${root}/firmware.wasm`,
  ];
}

interface DependencyFileSnapshot {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

interface LibraryDependencySnapshot {
  readonly name: string;
  readonly version: string;
  readonly files: readonly DependencyFileSnapshot[];
}

interface DependencySet {
  readonly shimFiles: readonly DependencyFileSnapshot[];
  readonly libraries: Readonly<Record<string, LibraryDependencySnapshot>>;
}

async function resolveDependencies(assetsPath: string): Promise<DependencySet> {
  const resolvedAssetsPath = await realpath(assetsPath);
  let totalBytes = 0;
  const capture = async (relativePath: string): Promise<DependencyFileSnapshot> => {
    const filePath = containedPath(resolvedAssetsPath, ...relativePath.split('/'));
    let bytes: Uint8Array;
    try {
      const directStat = await lstat(filePath);
      if (!directStat.isFile() || directStat.isSymbolicLink()) {
        throw new Error('dependency is not a regular, non-symbolic file');
      }
      const resolvedFilePath = await realpath(filePath);
      assertContained(resolvedAssetsPath, resolvedFilePath);
      bytes = await readBoundedRegularFile(filePath, DEPENDENCY_FILE_MAX_BYTES, {
        size: directStat.size,
        device: directStat.dev,
        inode: directStat.ino,
        modifiedMs: directStat.mtimeMs,
      });
    } catch (error) {
      throw new Error(
        `Required bundled firmware dependency ${relativePath} is unavailable or invalid: ${errorMessage(error)}`,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > DEPENDENCY_TOTAL_MAX_BYTES) {
      throw new Error(
        `Bundled firmware dependencies exceed ${DEPENDENCY_TOTAL_MAX_BYTES} bytes in total.`,
      );
    }
    return { relativePath, bytes };
  };

  const shimFiles = await Promise.all(
    ['include/Arduino.h', 'include/WProgram.h', 'include/EEPROM.h', 'src/arduino-fil.cpp'].map(
      capture,
    ),
  );
  const libraries: Record<string, LibraryDependencySnapshot> = {};
  for (const [libraryName, specification] of Object.entries(LIBRARIES)) {
    const files = await Promise.all(
      specification.files.map((fileName) => capture(`vendor/${libraryName}/${fileName}`)),
    );
    const properties = files.find(({ relativePath }) =>
      relativePath.endsWith('/library.properties'),
    );
    if (properties === undefined) throw new Error(`${libraryName} library.properties is missing.`);
    const identity = parseLibraryIdentity(properties.bytes);
    if (identity.name !== libraryName || identity.version !== specification.version) {
      throw new Error(
        `Bundled ${libraryName} identity is ${identity.name} ${identity.version}; expected ${libraryName} ${specification.version}.`,
      );
    }
    libraries[libraryName] = {
      name: identity.name,
      version: identity.version,
      files,
    };
  }
  return { shimFiles, libraries };
}

async function stageBuild(
  snapshot: SketchSnapshot,
  dependencies: DependencySet,
  stagePath: string,
): Promise<void> {
  const sketchPath = containedPath(stagePath, 'sketch');
  const generatedPath = containedPath(stagePath, 'generated');
  const shimPath = containedPath(stagePath, 'shim');
  const vendorPath = containedPath(stagePath, 'vendor');
  await Promise.all([mkdir(sketchPath), mkdir(generatedPath), mkdir(shimPath), mkdir(vendorPath)]);
  for (const file of snapshot.files) {
    await writeFile(containedPath(sketchPath, file.relativePath), file.bytes, { mode: 0o600 });
  }
  const entry = snapshot.files.find(
    ({ relativePath }) => relativePath === path.basename(snapshot.entryPath),
  );
  if (entry === undefined) throw new Error('Snapshot entry source is missing');
  await writeFile(
    containedPath(generatedPath, 'main.ino.cpp'),
    preprocessArduinoSketch(entry.text),
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  for (const source of dependencies.shimFiles) {
    const target = containedPath(shimPath, ...source.relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source.bytes, { mode: 0o600 });
  }
  for (const [library, dependency] of Object.entries(dependencies.libraries)) {
    const targetDirectory = containedPath(vendorPath, library);
    await mkdir(targetDirectory, { recursive: true });
    for (const source of dependency.files) {
      const fileName = path.posix.basename(source.relativePath);
      await writeFile(containedPath(targetDirectory, fileName), source.bytes, { mode: 0o600 });
    }
  }
}

export function preprocessArduinoSketch(source: string): string {
  const normalizedSource = source.replace(
    /\b([A-Za-z_]\w*)\.SetMode\(\s*\1\.Control::/g,
    '$1.SetMode(QuickPID::Control::',
  );
  const prototypePattern =
    /^([A-Za-z_][\w:\s<>,*&]*?\s+[A-Za-z_]\w*\s*\([^;{}]*\))(?:\s*\r?\n?\s*)\{/gm;
  const prototypes = new Set<string>();
  for (const match of normalizedSource.matchAll(prototypePattern)) {
    const declaration = match[1]?.replace(/\s+/g, ' ').trim();
    if (declaration !== undefined && !/^(if|for|while|switch)\b/.test(declaration)) {
      prototypes.add(`${declaration};`);
    }
  }
  return `#include <Arduino.h>\n${[...prototypes].join('\n')}\n#line 1 "main.ino"\n${normalizedSource}\n`;
}

function needsQuickPidEnumRewrite(source: string): boolean {
  return /\b([A-Za-z_]\w*)\.SetMode\(\s*\1\.Control::/.test(source);
}

function compatibilityDiagnostics(transforms: readonly string[]): readonly FirmwareDiagnostic[] {
  return transforms.includes(CLANG_QUICKPID_ENUM_REWRITE)
    ? [
        diagnostic(
          'warning',
          'source',
          'SOURCE_COMPATIBILITY_REWRITE',
          'Applied the supported Clang compatibility rewrite for instance-qualified QuickPID::Control.',
        ),
      ]
    : [];
}

function validateWasmAbi(bytes: Uint8Array): string | null {
  try {
    const wasm = (
      globalThis as unknown as {
        readonly WebAssembly: {
          readonly Module: {
            new (bytes: Uint8Array): unknown;
            imports(module: unknown): readonly { readonly module: string; readonly name: string }[];
            exports(module: unknown): readonly { readonly name: string }[];
          };
        };
      }
    ).WebAssembly;
    const module = new wasm.Module(bytes);
    const imports = wasm.Module.imports(module);
    if (imports.length > 0) {
      return `Firmware Wasm must be self-contained; unexpected imports: ${imports.map(({ module: owner, name }) => `${owner}.${name}`).join(', ')}.`;
    }
    const exports = new Set(wasm.Module.exports(module).map(({ name }) => name));
    const missing = REQUIRED_EXPORTS.filter((name) => !exports.has(name));
    return missing.length === 0
      ? null
      : `Firmware Wasm is missing required exports: ${missing.join(', ')}.`;
  } catch (error) {
    return error instanceof Error ? error.message : 'Firmware Wasm is invalid.';
  }
}

interface FirmwareCacheManifest {
  readonly version: 1;
  readonly buildId: string;
  readonly artifactSha256: string;
  readonly diagnostics: readonly FirmwareDiagnostic[];
}

type FirmwareCacheRead =
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt'; readonly reason: string }
  | {
      readonly status: 'valid';
      readonly bytes: Uint8Array;
      readonly diagnostics: readonly FirmwareDiagnostic[];
    };

async function readFirmwareCache(
  artifactPath: string,
  manifestPath: string,
  buildId: string,
): Promise<FirmwareCacheRead> {
  let artifact: Uint8Array;
  let manifestBytes: Uint8Array;
  try {
    [artifact, manifestBytes] = await Promise.all([
      readBoundedRegularFile(artifactPath, FIRMWARE_ARTIFACT_MAX_BYTES),
      readBoundedRegularFile(manifestPath, CACHE_MANIFEST_MAX_BYTES),
    ]);
  } catch (error) {
    const artifactMissing = await pathIsMissing(artifactPath);
    const manifestMissing = await pathIsMissing(manifestPath);
    if (artifactMissing && manifestMissing) return { status: 'missing' };
    return { status: 'corrupt', reason: errorMessage(error) };
  }
  if (artifact.byteLength === 0) return { status: 'corrupt', reason: 'artifact is empty' };
  const abiError = validateWasmAbi(artifact);
  if (abiError !== null) return { status: 'corrupt', reason: abiError };
  let manifest: FirmwareCacheManifest;
  try {
    manifest = parseCacheManifest(manifestBytes);
  } catch (error) {
    return { status: 'corrupt', reason: errorMessage(error) };
  }
  if (manifest.buildId !== buildId) {
    return { status: 'corrupt', reason: 'manifest build ID does not match its cache key' };
  }
  if (manifest.artifactSha256 !== sha256(artifact)) {
    return { status: 'corrupt', reason: 'artifact digest does not match its manifest' };
  }
  return { status: 'valid', bytes: artifact, diagnostics: manifest.diagnostics };
}

async function writeFirmwareCache(
  cacheRoot: string,
  artifactPath: string,
  manifestPath: string,
  buildId: string,
  bytes: Uint8Array,
  diagnostics: readonly FirmwareDiagnostic[],
): Promise<void> {
  const token = randomUUID();
  const temporaryArtifact = containedPath(cacheRoot, `${buildId}.${token}.wasm.tmp`);
  const temporaryManifest = containedPath(cacheRoot, `${buildId}.${token}.json.tmp`);
  const manifest: FirmwareCacheManifest = {
    version: CACHE_MANIFEST_VERSION,
    buildId,
    artifactSha256: sha256(bytes),
    diagnostics,
  };
  try {
    await Promise.all([
      writeFile(temporaryArtifact, bytes, { mode: 0o600, flag: 'wx' }),
      writeFile(temporaryManifest, `${JSON.stringify(manifest)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      }),
    ]);
    await rename(temporaryArtifact, artifactPath);
    await rename(temporaryManifest, manifestPath);
  } catch (error) {
    const existing = await readFirmwareCache(artifactPath, manifestPath, buildId);
    if (existing.status !== 'valid') throw error;
  } finally {
    await Promise.all([
      rm(temporaryArtifact, { force: true }).catch(() => undefined),
      rm(temporaryManifest, { force: true }).catch(() => undefined),
    ]);
  }
}

function parseCacheManifest(bytes: Uint8Array): FirmwareCacheManifest {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (typeof value !== 'object' || value === null)
    throw new Error('cache manifest is not an object');
  const candidate = value as Partial<FirmwareCacheManifest>;
  if (
    candidate.version !== CACHE_MANIFEST_VERSION ||
    typeof candidate.buildId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.buildId) ||
    typeof candidate.artifactSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.artifactSha256) ||
    !Array.isArray(candidate.diagnostics) ||
    !candidate.diagnostics.every(isFirmwareDiagnostic)
  ) {
    throw new Error('cache manifest has an invalid schema');
  }
  return candidate as FirmwareCacheManifest;
}

function isFirmwareDiagnostic(value: unknown): value is FirmwareDiagnostic {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FirmwareDiagnostic>;
  return (
    ['info', 'warning', 'error'].includes(String(candidate.severity)) &&
    ['source', 'toolchain', 'compile', 'link', 'cache', 'configuration', 'runtime'].includes(
      String(candidate.phase),
    ) &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    candidate.message.length <= COMMAND_OUTPUT_LIMIT &&
    (candidate.file === undefined || typeof candidate.file === 'string') &&
    (candidate.line === undefined || Number.isInteger(candidate.line)) &&
    (candidate.column === undefined || Number.isInteger(candidate.column)) &&
    (candidate.pin === undefined || typeof candidate.pin === 'string')
  );
}

function parseCompilerDiagnostics(
  result: CommandResult,
  timedOut: boolean,
): readonly FirmwareDiagnostic[] {
  if (timedOut) {
    return [diagnostic('error', 'compile', 'COMPILE_FAILED', 'Firmware compilation timed out.')];
  }
  const parsed = parseCompilerOutput(`${result.stderr}\n${result.stdout}`, true);
  return parsed.length > 0
    ? parsed
    : [
        diagnostic(
          'error',
          'compile',
          'COMPILE_FAILED',
          result.error ?? (firstLine(result.stderr) || 'Firmware compilation failed.'),
        ),
      ];
}

function parseCompilerWarnings(output: string): readonly FirmwareDiagnostic[] {
  return parseCompilerOutput(output, false).filter(({ severity }) => severity === 'warning');
}

function parseCompilerOutput(
  output: string,
  includeErrors: boolean,
): readonly FirmwareDiagnostic[] {
  const diagnostics: FirmwareDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(\d+):\s+(warning|error):\s+(.+)$/.exec(line.trim());
    if (match === null || (!includeErrors && match[4] !== 'warning')) continue;
    diagnostics.push({
      severity: match[4] as 'warning' | 'error',
      phase: 'compile',
      code: match[4] === 'warning' ? 'COMPILER_WARNING' : 'COMPILE_FAILED',
      message: match[5]!,
      file: path.basename(match[1]!),
      line: Number(match[2]),
      column: Number(match[3]),
    });
  }
  return diagnostics;
}

function diagnostic(
  severity: FirmwareDiagnostic['severity'],
  phase: FirmwareDiagnostic['phase'],
  code: FirmwareDiagnostic['code'],
  message: string,
): FirmwareDiagnostic {
  return { severity, phase, code, message };
}

function containedPath(root: string, ...segments: readonly string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  assertContained(resolvedRoot, resolved);
  return resolved;
}

function assertContained(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Firmware build path escaped its managed root');
  }
}

function hashSnapshotFiles(files: readonly DependencyFileSnapshot[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) =>
    compareText(left.relativePath, right.relativePath),
  )) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseLibraryIdentity(bytes: Uint8Array): {
  readonly name: string;
  readonly version: string;
} {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('library.properties is not valid UTF-8');
  }
  const properties = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    properties.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = properties.get('name');
  const version = properties.get('version');
  if (name === undefined || version === undefined) {
    throw new Error('library.properties must define name and version');
  }
  return { name, version };
}

interface ExpectedRegularFileIdentity {
  readonly size: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedMs: number;
}

async function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
  expected?: ExpectedRegularFileIdentity,
): Promise<Uint8Array> {
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${path.basename(filePath)} is not a regular file`);
    if (
      expected !== undefined &&
      (before.size !== expected.size ||
        before.dev !== expected.device ||
        before.ino !== expected.inode ||
        before.mtimeMs !== expected.modifiedMs)
    ) {
      throw new Error(`${path.basename(filePath)} changed before reading`);
    }
    if (before.size < 0 || before.size > maximumBytes) {
      throw new Error(`${path.basename(filePath)} exceeds the ${maximumBytes} byte limit`);
    }
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0)
        throw new Error(`${path.basename(filePath)} changed while reading`);
      offset += result.bytesRead;
    }
    const extra = new Uint8Array(1);
    const afterEnd = await handle.read(extra, 0, 1, bytes.byteLength);
    const after = await handle.stat();
    if (
      afterEnd.bytesRead !== 0 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`${path.basename(filePath)} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function pathIsMissing(filePath: string): Promise<boolean> {
  try {
    const handle = await open(filePath, 'r');
    await handle.close();
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === 'ENOENT';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandFailureDetail(result: CommandResult, fallback: string): string {
  return result.error ?? (firstLine(result.stderr) || firstLine(result.stdout) || fallback);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

export const runCommand: CommandRunner = (invocation) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timingOut = false;
    let child: ChildProcess;
    try {
      child = spawn(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout,
        stderr,
        error: errorMessage(error),
        timedOut: false,
      });
      return;
    }
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(-COMMAND_OUTPUT_LIMIT);
    child.stdout?.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr?.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timingOut = true;
      void terminateInvocation(child, invocation).then((cleanupError) =>
        settle({
          exitCode: null,
          stdout,
          stderr,
          error:
            cleanupError === null
              ? 'Command timed out'
              : `Command timed out; cleanup warning: ${cleanupError}`,
          timedOut: true,
        }),
      );
    }, invocation.timeoutMs);
    child.once('error', (error) => {
      if (timingOut) return;
      settle({ exitCode: null, stdout, stderr, error: error.message, timedOut: false });
    });
    child.once('close', (exitCode) => {
      if (timingOut) return;
      settle({ exitCode, stdout, stderr, error: null, timedOut: false });
    });
  });

async function terminateInvocation(
  child: ChildProcess,
  invocation: CommandInvocation,
): Promise<string | null> {
  const errors: string[] = [];
  if (invocation.dockerCleanup !== undefined) {
    const identifier = await readDockerIdentifier(invocation.dockerCleanup);
    const cleanup = await runTerminationCommand('docker', ['rm', '--force', identifier]);
    if (cleanup !== null && !/No such container/i.test(cleanup)) errors.push(cleanup);
  }
  if (child.pid !== undefined) {
    if (process.platform === 'win32') {
      const cleanup = await runTerminationCommand('taskkill.exe', [
        '/PID',
        String(child.pid),
        '/T',
        '/F',
      ]);
      if (cleanup !== null && !/not found|not running/i.test(cleanup)) errors.push(cleanup);
      // taskkill is the tree operation; this direct fallback also closes the tracked handle
      // when taskkill is unavailable or reports success before Node observes process exit.
      child.kill('SIGKILL');
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } else {
    child.kill('SIGKILL');
  }
  await waitForProcessClose(child, COMMAND_TERMINATION_GRACE_MS);
  return errors.length === 0 ? null : errors.join('; ');
}

async function readDockerIdentifier(
  cleanup: NonNullable<CommandInvocation['dockerCleanup']>,
): Promise<string> {
  try {
    const cid = new TextDecoder().decode(await readBoundedRegularFile(cleanup.cidFile, 128)).trim();
    if (/^[a-f0-9]{12,64}$/i.test(cid)) return cid;
  } catch {
    // The deterministic container name still permits cleanup before the CID file appears.
  }
  return cleanup.containerName;
}

function runTerminationCommand(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(errorMessage(error));
      return;
    }
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-4096);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const finish = (error: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(`${command} cleanup timed out`);
    }, COMMAND_TERMINATION_GRACE_MS);
    child.once('error', (error) => finish(error.message));
    child.once('close', (code) =>
      finish(code === 0 ? null : output.trim() || `${command} exited ${code}`),
    );
  });
}

function waitForProcessClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
