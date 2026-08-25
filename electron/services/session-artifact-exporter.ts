import { createReadStream } from 'node:fs';
import readline from 'node:readline';

import type { JsonValue, SessionMetadata } from '../../shared/contracts';
import { AppError } from '../../shared/errors';

export interface ExportedSession extends SessionMetadata {
  readonly data: JsonValue;
}

interface ArtifactMetadata {
  readonly path?: string | null;
  readonly complete?: boolean;
  readonly limits?: JsonValue;
  readonly retainedBytes?: number;
  readonly retainedRecords?: number;
  readonly omittedBytes?: number;
  readonly omittedRecords?: number;
  readonly records?: readonly JsonValue[];
}

export async function assembleSessionExports(
  sessions: readonly SessionMetadata[],
): Promise<readonly ExportedSession[]> {
  return Promise.all(sessions.map((session) => assembleSessionExport(session)));
}

async function assembleSessionExport(session: SessionMetadata): Promise<ExportedSession> {
  if (session.kind !== 'job' && session.kind !== 'tuning') {
    return session;
  }
  const data = asRecord(session.data);
  const artifact = asRecord(data['artifact']) as ArtifactMetadata;
  const artifactPath = typeof artifact.path === 'string' ? artifact.path : null;
  if (artifactPath === null) {
    throw artifactReadError(session, 'The retained diagnostic artifact path is missing');
  }
  const records = await readArtifactRecords(artifactPath, session);
  return {
    ...session,
    data: {
      ...data,
      artifact: {
        ...artifact,
        records,
      },
    } as unknown as JsonValue,
  } as ExportedSession;
}

async function readArtifactRecords(
  artifactPath: string,
  session: SessionMetadata,
): Promise<readonly JsonValue[]> {
  const records: JsonValue[] = [];
  try {
    const input = createReadStream(artifactPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.length === 0) continue;
        records.push(JSON.parse(line) as JsonValue);
      }
    } finally {
      lines.close();
      input.destroy();
    }
  } catch (error) {
    throw artifactReadError(session, 'Unable to read the retained diagnostic artifact', error);
  }
  return records;
}

function artifactReadError(session: SessionMetadata, message: string, cause?: unknown): AppError {
  return new AppError(
    {
      code: 'STORAGE_FAILED',
      message: `${message} for session '${session.id}'`,
      recoverable: true,
      details: { sessionId: session.id, sessionKind: session.kind },
    },
    cause === undefined ? undefined : { cause },
  );
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

export function sessionsToCsvWithArtifacts(sessions: readonly ExportedSession[]): string {
  const rows = [
    [
      'id',
      'kind',
      'title',
      'startedAt',
      'endedAt',
      'pinned',
      'artifactComplete',
      'artifactLimits',
      'artifactRetainedBytes',
      'artifactRetainedRecords',
      'artifactOmittedBytes',
      'artifactOmittedRecords',
      'artifactRecords',
      'data',
    ],
    ...sessions.map((session) => {
      const artifact = asRecord(asRecord(session.data)['artifact']);
      return [
        session.id,
        session.kind,
        session.title,
        session.startedAt,
        session.endedAt,
        String(session.pinned),
        artifact['complete'] === undefined ? '' : String(artifact['complete']),
        JSON.stringify(artifact['limits'] ?? null),
        String(artifact['retainedBytes'] ?? ''),
        String(artifact['retainedRecords'] ?? ''),
        String(artifact['omittedBytes'] ?? ''),
        String(artifact['omittedRecords'] ?? ''),
        JSON.stringify(artifact['records'] ?? []),
        JSON.stringify(session.data),
      ];
    }),
  ];
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
