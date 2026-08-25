import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionMetadata } from '../../shared/contracts';
import { assembleSessionExports, sessionsToCsvWithArtifacts } from './session-artifact-exporter';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('session artifact export', () => {
  it('embeds retained job and tuning records with completeness metadata', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-export-'));
    directories.push(directory);
    const jobPath = path.join(directory, 'job.jsonl');
    const tuningPath = path.join(directory, 'tuning.jsonl');
    await writeFile(jobPath, '{"line":1}\n{"line":2}\n', 'utf8');
    await writeFile(tuningPath, '{"sample":1}\n', 'utf8');
    const sessions = [
      session('job-1', 'job', jobPath, true, 2, 0),
      session('tuning-1', 'tuning', tuningPath, false, 1, 3),
    ];

    const exported = await assembleSessionExports(sessions);

    expect((exported[0]!.data as { artifact: Record<string, unknown> }).artifact).toMatchObject({
      complete: true,
      retainedRecords: 2,
      omittedRecords: 0,
      records: [{ line: 1 }, { line: 2 }],
    });
    expect((exported[1]!.data as { artifact: Record<string, unknown> }).artifact).toMatchObject({
      complete: false,
      retainedRecords: 1,
      omittedRecords: 3,
      records: [{ sample: 1 }],
    });
    const csv = sessionsToCsvWithArtifacts(exported);
    expect(csv).toContain('artifactComplete');
    expect(csv).toContain('"false"');
    expect(csv).toContain('"[{""sample"":1}]"');
  });

  it('reports missing artifacts as recoverable storage failures', async () => {
    await expect(
      assembleSessionExports([session('missing', 'job', 'missing.jsonl', true, 0, 0)]),
    ).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
      recoverable: true,
    });
  });
});

function session(
  id: string,
  kind: 'job' | 'tuning',
  artifactPath: string,
  complete: boolean,
  retainedRecords: number,
  omittedRecords: number,
): SessionMetadata {
  return {
    id,
    version: 1,
    kind,
    title: id,
    startedAt: '2026-08-25T00:00:00.000Z',
    endedAt: '2026-08-25T00:01:00.000Z',
    pinned: false,
    data: {
      artifact: {
        path: artifactPath,
        complete,
        limits: { maxBytes: 100, maxRecords: 10 },
        retainedBytes: 20,
        retainedRecords,
        omittedBytes: 30,
        omittedRecords,
      },
    },
  };
}
