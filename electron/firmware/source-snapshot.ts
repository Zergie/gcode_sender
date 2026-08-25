import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  FIRMWARE_SOURCE_FILE_MAX_BYTES,
  FIRMWARE_SOURCE_MAX_BYTES,
  FIRMWARE_SOURCE_MAX_FILES,
  type FirmwareSourceSnapshot,
} from '../../shared/firmware-contracts';
import { AppError } from '../../shared/errors';

const SOURCE_EXTENSIONS = new Set(['.ino', '.cpp', '.h', '.hpp']);
const ALLOWED_SYSTEM_INCLUDES = new Set([
  'Arduino.h',
  'WProgram.h',
  'EEPROM.h',
  'GCodeParser.h',
  'Thermistor.h',
  'NTC_Thermistor.h',
  'AverageThermistor.h',
  'QuickPID.h',
  'stdint.h',
]);

export interface SnapshotFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface SketchSnapshot {
  readonly entryPath: string;
  readonly directoryPath: string;
  readonly public: FirmwareSourceSnapshot;
  readonly files: readonly SnapshotFile[];
}

export async function snapshotSketch(entryCandidate: string): Promise<SketchSnapshot> {
  if (typeof entryCandidate !== 'string' || path.extname(entryCandidate).toLowerCase() !== '.ino') {
    throw invalid('Select an Arduino .ino sketch. STM32 .bin files require MCU emulation.');
  }
  const selectedStat = await lstat(entryCandidate);
  if (!selectedStat.isFile() || selectedStat.isSymbolicLink()) {
    throw invalid('The selected sketch must be a regular, non-symbolic .ino file.');
  }
  const entryPath = await realpath(entryCandidate);
  const entryStat = await lstat(entryPath);
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw invalid('The selected sketch must be a regular .ino file.');
  }
  const directoryPath = path.dirname(entryPath);
  const directoryNames = await readdir(directoryPath);
  const unsupportedC = directoryNames.find((name) => path.extname(name).toLowerCase() === '.c');
  if (unsupportedC !== undefined) {
    throw invalid(
      `Firmware-in-loop v1 does not support the C translation unit ${unsupportedC}; use a C++ .cpp companion file.`,
    );
  }
  const names = directoryNames.filter((name) =>
    SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase()),
  );
  if (names.length === 0 || names.length > FIRMWARE_SOURCE_MAX_FILES) {
    throw invalid(`A sketch may contain at most ${FIRMWARE_SOURCE_MAX_FILES} source files.`);
  }
  const inoFiles = names.filter((name) => path.extname(name).toLowerCase() === '.ino');
  if (inoFiles.length !== 1 || inoFiles[0] !== path.basename(entryPath)) {
    throw invalid(
      'Firmware-in-loop v1 requires a sketch directory containing exactly one .ino file.',
    );
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files: SnapshotFile[] = [];
  let totalBytes = 0;
  for (const name of names.sort(compareText)) {
    const candidate = path.join(directoryPath, name);
    const candidateStat = await lstat(candidate);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
      throw invalid(`Sketch file ${name} must be a regular, non-symbolic source file.`);
    }
    const resolved = await realpath(candidate);
    if (path.dirname(resolved) !== directoryPath) {
      throw invalid(`Sketch file ${name} resolves outside the selected directory.`);
    }
    const stat = await lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FIRMWARE_SOURCE_FILE_MAX_BYTES) {
      throw invalid(`Sketch file ${name} is not a bounded regular source file.`);
    }
    totalBytes += stat.size;
    if (totalBytes > FIRMWARE_SOURCE_MAX_BYTES) {
      throw invalid(`The sketch exceeds the ${FIRMWARE_SOURCE_MAX_BYTES} byte source limit.`);
    }
    const bytes = await readStableBoundedFile(resolved, {
      size: stat.size,
      device: stat.dev,
      inode: stat.ino,
      modifiedMs: stat.mtimeMs,
    });
    totalBytes += bytes.byteLength - stat.size;
    if (
      bytes.byteLength > FIRMWARE_SOURCE_FILE_MAX_BYTES ||
      totalBytes > FIRMWARE_SOURCE_MAX_BYTES
    ) {
      throw invalid(`Sketch file ${name} changed beyond the supported source limits.`);
    }
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw invalid(`Sketch file ${name} is not valid UTF-8.`);
    }
    validateLocalIncludes(name, text, new Set(names));
    validateUnsupportedPeripherals(name, text);
    files.push({ relativePath: name, bytes, text });
  }

  const entryName = path.basename(entryPath);
  if (!files.some(({ relativePath }) => relativePath === entryName)) {
    throw invalid('The selected sketch was not captured in its source snapshot.');
  }
  const hash = createHash('sha256');
  hash.update('ENTRY\0', 'utf8');
  hash.update(entryName, 'utf8');
  hash.update('\0', 'utf8');
  for (const file of files) {
    hash.update(file.relativePath, 'utf8');
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return {
    entryPath,
    directoryPath,
    public: {
      path: entryPath,
      displayName: entryName,
      sha256: hash.digest('hex'),
      files: files.map(({ relativePath }) => relativePath),
    },
    files,
  };
}

function validateLocalIncludes(
  fileName: string,
  source: string,
  sketchFiles: ReadonlySet<string>,
): void {
  const masked = maskCommentsAndLiterals(source);
  for (const continued of masked.matchAll(/^[ \t]*#[^\r\n]*(?:\\\r?\n[^\r\n]*)+/gm)) {
    if (/^[ \t]*#[ \t]*include(?:_next)?\b/.test(continued[0].replace(/\\\r?\n/g, ''))) {
      throw invalid(`${fileName} contains a noncanonical include directive with continuation.`);
    }
  }
  for (const match of masked.matchAll(/^[ \t]*#[ \t]*(include_next|include)\b/gm)) {
    const matchedPrefix = match[0];
    const hashOffset = matchedPrefix.lastIndexOf('#');
    const directiveStart = (match.index ?? 0) + hashOffset;
    const lineEnd = source.slice(directiveStart).search(/[\r\n]/);
    const directiveSource = source.slice(
      directiveStart,
      lineEnd === -1 ? source.length : directiveStart + lineEnd,
    );
    const directiveMatch = /^#[ \t]*(include_next|include)\b([^\r\n]*)/.exec(directiveSource);
    if (directiveMatch === null) {
      throw invalid(`${fileName} contains a noncanonical include directive.`);
    }
    const directive = directiveMatch[1];
    const operand = directiveMatch[2]?.trim() ?? '';
    if (directive === 'include_next') {
      throw invalid(`${fileName} uses unsupported #include_next.`);
    }
    const canonical = /^([<"])([^>"]+)([>"])(?:[ \t]*\/\/.*)?$/.exec(operand);
    if (
      canonical === null ||
      (canonical[1] === '<' ? canonical[3] !== '>' : canonical[3] !== '"')
    ) {
      throw invalid(
        `${fileName} contains a noncanonical include; macro, continued, and commented include operands are unsupported.`,
      );
    }
    const delimiter = canonical[1];
    const include = canonical[2];
    if (include === undefined) continue;
    if (path.isAbsolute(include) || include.split(/[\\/]/).includes('..')) {
      throw invalid(`${fileName} contains an include outside the supported sketch snapshot.`);
    }
    if (sketchFiles.has(include) || ALLOWED_SYSTEM_INCLUDES.has(include)) continue;
    const kind = delimiter === '"' ? 'missing local include' : 'unsupported system include';
    throw invalid(`${fileName} references ${kind} ${include}.`);
  }
}

function validateUnsupportedPeripherals(fileName: string, source: string): void {
  const code = maskCommentsAndLiterals(source);
  if (/\bdelay\s*\(/.test(code)) {
    throw new AppError({
      code: 'FILE_INVALID',
      message: `${fileName} calls delay(), which firmware-in-loop ABI v1 does not emulate safely.`,
      recoverable: true,
      details: { firmwareDiagnosticCode: 'PERIPHERAL_UNSUPPORTED', peripheral: 'delay' },
    });
  }
}

function maskCommentsAndLiterals(source: string): string {
  return source.replace(
    /(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|\/\*[\s\S]*?\*\/|\/\/(?:\\\r?\n|[^\r\n])*|"(?:\\(?:\r?\n|.)|[^"\\])*"|'(?:\\(?:\r?\n|.)|[^'\\])*'/g,
    (match) => match.replace(/[^\r\n]/g, ' '),
  );
}

interface ExpectedFileIdentity {
  readonly size: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedMs: number;
}

async function readStableBoundedFile(
  filePath: string,
  expected: ExpectedFileIdentity,
): Promise<Uint8Array> {
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== expected.size ||
      before.dev !== expected.device ||
      before.ino !== expected.inode ||
      before.mtimeMs !== expected.modifiedMs ||
      before.size > FIRMWARE_SOURCE_FILE_MAX_BYTES
    ) {
      throw invalid(`${path.basename(filePath)} changed while its snapshot was being captured.`);
    }
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw invalid(`${path.basename(filePath)} changed while its snapshot was being captured.`);
      }
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
      throw invalid(`${path.basename(filePath)} changed while its snapshot was being captured.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): AppError {
  return new AppError({ code: 'FILE_INVALID', message, recoverable: true });
}
