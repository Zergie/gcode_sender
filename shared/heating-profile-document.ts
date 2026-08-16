import type { HeatingProfile, HeatingProfilePoint } from './contracts';
import { INITIAL_GCODE_COMMENT_STATE, normalizeGcodeLine } from './job-normalizer';

export const HEATING_PROFILE_MARKER = '; GCODE_SENDER_HEATING_PROFILE_BEGIN 1';
const HEADER_PREFIX = '; GCODE_SENDER_HEATING_PROFILE_HEADER ';
const POINT_PREFIX = '; GCODE_SENDER_HEATING_PROFILE_POINT ';
const END_MARKER = '; GCODE_SENDER_HEATING_PROFILE_END';
export const MAX_HEATING_PROFILE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_HEATING_PROFILE_PREFIX_BYTES = 64 * 1024;
const MAX_POINTS = 128;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_DWELL_MS = 5_000;

export type HeatingProfileParseResult =
  | { readonly ok: true; readonly profile: HeatingProfile }
  | { readonly ok: false; readonly warning: string };

export function validateHeatingProfile(candidate: unknown): HeatingProfile {
  if (!isRecord(candidate) || candidate['version'] !== 1) {
    throw new TypeError('Heating profile schema version must be 1');
  }
  const name = candidate['name'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120) {
    throw new TypeError('Heating profile name must contain 1 to 120 characters');
  }
  if (candidate['interpolation'] !== 'linear') {
    throw new TypeError('Heating profile interpolation must be linear');
  }
  const rawPoints = candidate['points'];
  if (!Array.isArray(rawPoints) || rawPoints.length < 2 || rawPoints.length > MAX_POINTS) {
    throw new TypeError('Heating profile must contain between 2 and 128 points');
  }
  const points = rawPoints.map(validatePoint);
  if (points[0]!.timeMs !== 0) {
    throw new TypeError('Heating profile must start at 0 ms');
  }
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.timeMs <= points[index - 1]!.timeMs) {
      throw new TypeError('Heating profile point times must be strictly increasing');
    }
  }
  if (points.at(-1)!.timeMs > MAX_DURATION_MS) {
    throw new TypeError('Heating profile duration must not exceed 24 hours');
  }
  return { version: 1, name, interpolation: 'linear', points };
}

export function compileHeatingProfileCommands(candidate: unknown): readonly string[] {
  const profile = validateHeatingProfile(candidate);
  const commands: string[] = [`M104 S${profile.points[0]!.targetC}`];
  let emittedTarget = profile.points[0]!.targetC;

  for (let pointIndex = 1; pointIndex < profile.points.length; pointIndex += 1) {
    const start = profile.points[pointIndex - 1]!;
    const end = profile.points[pointIndex]!;
    const duration = end.timeMs - start.timeMs;
    const targetDelta = end.targetC - start.targetC;
    const chunkCount = Math.max(Math.ceil(duration / MAX_DWELL_MS), Math.abs(targetDelta));
    let elapsed = 0;
    for (let chunk = 1; chunk <= chunkCount; chunk += 1) {
      const nextElapsed = Math.round((duration * chunk) / chunkCount);
      const dwell = nextElapsed - elapsed;
      if (dwell > 0) commands.push(`G4 P${dwell}`);
      elapsed = nextElapsed;
      const target = Math.round(start.targetC + (targetDelta * chunk) / chunkCount);
      if (target !== emittedTarget) {
        commands.push(`M104 S${target}`);
        emittedTarget = target;
      }
    }
  }

  commands.push('M104 S0');
  return commands;
}

export function serializeHeatingProfileDocument(candidate: unknown): string {
  const profile = validateHeatingProfile(candidate);
  const metadata = [
    HEATING_PROFILE_MARKER,
    `${HEADER_PREFIX}${JSON.stringify({
      version: profile.version,
      name: profile.name,
      interpolation: profile.interpolation,
    })}`,
    ...profile.points.map((point) => `${POINT_PREFIX}${JSON.stringify(point)}`),
    END_MARKER,
  ];
  const source = `${metadata.join('\n')}\n\n${compileHeatingProfileCommands(profile).join('\n')}\n`;
  if (new TextEncoder().encode(source).byteLength > MAX_HEATING_PROFILE_FILE_BYTES) {
    throw new TypeError('Compiled heating profile exceeds the file-size limit');
  }
  return source;
}

export function parseHeatingProfileDocument(source: string): HeatingProfileParseResult {
  try {
    const lines = source
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    if (lines[0] !== HEATING_PROFILE_MARKER) {
      return { ok: false, warning: 'Heating-profile metadata marker is missing or misplaced.' };
    }
    const headerLine = lines[1];
    if (headerLine === undefined || !headerLine.startsWith(HEADER_PREFIX)) {
      throw new TypeError('Heating-profile metadata header is missing');
    }
    const header = parseJsonRecord(headerLine.slice(HEADER_PREFIX.length), 'header');
    const rawPoints: unknown[] = [];
    let lineIndex = 2;
    while (lineIndex < lines.length && lines[lineIndex]!.startsWith(POINT_PREFIX)) {
      rawPoints.push(parseJsonRecord(lines[lineIndex]!.slice(POINT_PREFIX.length), 'point'));
      lineIndex += 1;
    }
    if (lines[lineIndex] !== END_MARKER) {
      throw new TypeError('Heating-profile metadata end marker is missing');
    }
    const profile = validateHeatingProfile({ ...header, points: rawPoints });
    const actualCommands = normalizedCommands(lines.slice(lineIndex + 1));
    const expectedCommands = compileHeatingProfileCommands(profile);
    if (
      actualCommands.length !== expectedCommands.length ||
      actualCommands.some((command, index) => command !== expectedCommands[index])
    ) {
      throw new TypeError('Executable G-code does not match the heating-profile metadata');
    }
    return { ok: true, profile };
  } catch (error) {
    return {
      ok: false,
      warning: error instanceof Error ? error.message : 'Heating-profile metadata is invalid',
    };
  }
}

export function hasHeatingProfileMarker(prefix: Uint8Array): boolean {
  const text = new TextDecoder('utf-8').decode(prefix).replace(/^\uFEFF/, '');
  return (
    text === HEATING_PROFILE_MARKER ||
    text.startsWith(`${HEATING_PROFILE_MARKER}\n`) ||
    text.startsWith(`${HEATING_PROFILE_MARKER}\r\n`)
  );
}

function validatePoint(candidate: unknown, index: number): HeatingProfilePoint {
  if (!isRecord(candidate)) throw new TypeError(`Heating profile point ${index + 1} is invalid`);
  const timeMs = candidate['timeMs'];
  const targetC = candidate['targetC'];
  if (!Number.isInteger(timeMs) || (timeMs as number) < 0) {
    throw new TypeError('Heating profile times must be non-negative integer milliseconds');
  }
  if (!Number.isInteger(targetC) || (targetC as number) < 0 || (targetC as number) > 250) {
    throw new TypeError('Heating profile targets must be whole degrees from 0 to 250 C');
  }
  return { timeMs: timeMs as number, targetC: targetC as number };
}

function normalizedCommands(lines: readonly string[]): readonly string[] {
  const commands: string[] = [];
  let state = INITIAL_GCODE_COMMENT_STATE;
  for (const line of lines) {
    const normalized = normalizeGcodeLine(line, state);
    state = normalized.state;
    if (normalized.command !== null) commands.push(normalized.command);
  }
  return commands;
}

function parseJsonRecord(source: string, label: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new TypeError(`Heating-profile ${label} must be a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
