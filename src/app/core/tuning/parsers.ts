import { TuningDomainError } from './tuning-error';
import type { M105Telemetry, PidGains } from './types';

const NUMBER_PATTERN = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
const M105_PATTERN = new RegExp(
  `T0:\\s*(${NUMBER_PATTERN})\\s*\\/\\s*(${NUMBER_PATTERN})\\s*@:\\s*(${NUMBER_PATTERN})` +
    `\\s+T1:\\s*(${NUMBER_PATTERN})\\s+T2:\\s*(${NUMBER_PATTERN})\\s+T3:\\s*(${NUMBER_PATTERN})`,
  'i',
);
const SNAPSHOT_PATTERN = new RegExp(`^\\s*(k[pid])\\s*:\\s*(${NUMBER_PATTERN})\\s*$`, 'i');

function finite(value: string, path: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TuningDomainError('INVALID_TELEMETRY', `${path} must be finite.`, path);
  }
  return parsed;
}

export function parseM105Telemetry(line: string, atMs: number): M105Telemetry | undefined {
  if (!Number.isFinite(atMs) || atMs < 0) {
    throw new TuningDomainError(
      'INVALID_TELEMETRY',
      'Telemetry timestamp must be a finite, non-negative number.',
      'atMs',
    );
  }

  const match = M105_PATTERN.exec(line);
  if (match === null) {
    return undefined;
  }

  const [, t0, target, output, t1, t2, t3] = match;
  if (
    t0 === undefined ||
    target === undefined ||
    output === undefined ||
    t1 === undefined ||
    t2 === undefined ||
    t3 === undefined
  ) {
    return undefined;
  }

  const sample: M105Telemetry = {
    atMs,
    t0C: finite(t0, 't0C'),
    t1C: finite(t1, 't1C'),
    t2C: finite(t2, 't2C'),
    t3C: finite(t3, 't3C'),
    reportedTargetC: finite(target, 'reportedTargetC'),
    output: finite(output, 'output'),
    raw: line,
  };
  if (sample.output < 0 || sample.output > 255) {
    throw new TuningDomainError(
      'INVALID_TELEMETRY',
      'Reported heater output must be between 0 and 255.',
      'output',
    );
  }
  return sample;
}

export type SnapshotGain = { readonly key: keyof PidGains; readonly value: number };

export function parseM503SnapshotLine(line: string): SnapshotGain | undefined {
  const match = SNAPSHOT_PATTERN.exec(line);
  if (match === null) {
    return undefined;
  }
  const [, rawKey, rawValue] = match;
  if (rawKey === undefined || rawValue === undefined) {
    return undefined;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new TuningDomainError(
      'PID_SNAPSHOT_UNAVAILABLE',
      `${rawKey} from M503 must be finite and non-negative.`,
      rawKey.toLowerCase(),
    );
  }
  return { key: rawKey.toLowerCase() as keyof PidGains, value };
}

export function isCompletePidSnapshot(snapshot: Partial<PidGains>): snapshot is PidGains {
  return (
    Number.isFinite(snapshot.kp) &&
    Number.isFinite(snapshot.ki) &&
    Number.isFinite(snapshot.kd) &&
    (snapshot.kp ?? -1) >= 0 &&
    (snapshot.ki ?? -1) >= 0 &&
    (snapshot.kd ?? -1) >= 0
  );
}

export function parseM503Snapshot(lines: readonly string[]): PidGains {
  let snapshot: Partial<PidGains> = {};
  for (const line of lines) {
    const parsed = parseM503SnapshotLine(line);
    if (parsed === undefined) {
      continue;
    }
    const existing = snapshot[parsed.key];
    if (existing !== undefined && existing !== parsed.value) {
      throw new TuningDomainError(
        'PID_SNAPSHOT_UNAVAILABLE',
        `M503 returned conflicting ${parsed.key} values.`,
        parsed.key,
      );
    }
    snapshot = { ...snapshot, [parsed.key]: parsed.value };
  }
  if (!isCompletePidSnapshot(snapshot)) {
    const missing = (['kp', 'ki', 'kd'] as const).filter((key) => snapshot[key] === undefined);
    throw new TuningDomainError(
      'PID_SNAPSHOT_UNAVAILABLE',
      `M503 did not provide rollback gains: ${missing.join(', ')}.`,
      'snapshot',
    );
  }
  return { ...snapshot };
}
