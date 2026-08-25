import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { AppError } from '../../shared/errors';
import { BoundedArtifactWriter } from './bounded-artifact-writer';

describe('BoundedArtifactWriter', () => {
  it('retains the newest complete records within both byte and record limits', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-artifact-'));
    const artifactPath = path.join(directory, 'job.jsonl');
    const writer = new BoundedArtifactWriter(artifactPath, { maxBytes: 34, maxRecords: 2 });

    await writer.append({ id: 1 });
    await writer.append({ id: 2 });
    await writer.append({ id: 3 });
    const stats = await writer.close();
    const content = await readFile(artifactPath, 'utf8');

    expect(content).toBe('{"id":2}\n{"id":3}\n');
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(34);
    expect(stats).toEqual({
      truncated: true,
      limits: { maxBytes: 34, maxRecords: 2 },
      retainedBytes: 18,
      retainedRecords: 2,
      omittedBytes: 9,
      omittedRecords: 1,
    });
    await expect(writer.close()).resolves.toEqual(stats);
  });

  it('omits a record larger than the byte ceiling without writing a partial record', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-artifact-'));
    const artifactPath = path.join(directory, 'trace.jsonl');
    const writer = new BoundedArtifactWriter(artifactPath, { maxBytes: 12, maxRecords: 10 });

    await writer.append({ ok: 1 });
    await writer.append({ tooLarge: '0123456789' });
    const stats = await writer.close();

    expect(await readFile(artifactPath, 'utf8')).toBe('{"ok":1}\n');
    expect(stats.truncated).toBe(true);
    expect(stats.retainedRecords).toBe(1);
    expect(stats.omittedRecords).toBe(1);
    expect(stats.omittedBytes).toBe(Buffer.byteLength('{"tooLarge":"0123456789"}\n'));
  });

  it('surfaces serialization and filesystem failures as recoverable storage errors', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-artifact-'));
    const blockingPath = path.join(directory, 'blocking');
    await writeFile(blockingPath, 'file');
    const writer = new BoundedArtifactWriter(path.join(blockingPath, 'artifact'), {
      maxBytes: 100,
      maxRecords: 10,
    });

    await expect(writer.append({ value: 1 })).rejects.toMatchObject<AppError>({
      code: 'STORAGE_FAILED',
      recoverable: true,
    });
    await expect(writer.append({ value: 2 })).rejects.toMatchObject<AppError>({
      code: 'STORAGE_FAILED',
    });
    expect(
      () =>
        new BoundedArtifactWriter(path.join(directory, 'invalid'), { maxBytes: 0, maxRecords: 1 }),
    ).toThrowError(AppError);
  });
});
