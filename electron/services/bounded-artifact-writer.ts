import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../../shared/errors';

export interface ArtifactWriterLimits {
  readonly maxBytes: number;
  readonly maxRecords: number;
}

export interface ArtifactWriterStats {
  readonly truncated: boolean;
  readonly limits: ArtifactWriterLimits;
  readonly retainedBytes: number;
  readonly retainedRecords: number;
  readonly omittedBytes: number;
  readonly omittedRecords: number;
}

interface SerializedRecord {
  readonly value: string;
  readonly bytes: number;
}

/**
 * Retains a bounded, newline-delimited JSON artifact by compacting the oldest
 * complete records whenever a new record would exceed either configured cap.
 * The artifact is replaced atomically after every mutation, so a failed write
 * never leaves a partially serialized record on disk.
 */
export class BoundedArtifactWriter<T> {
  private records: SerializedRecord[] = [];
  private omittedBytes = 0;
  private omittedRecords = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly filePath: string,
    limits: ArtifactWriterLimits,
    private readonly serialize: (record: T) => unknown = (record) => record,
  ) {
    validateLimits(limits);
    this.limits = Object.freeze({ ...limits });
  }

  private readonly limits: ArtifactWriterLimits;

  getStats(): ArtifactWriterStats {
    return {
      truncated: this.omittedRecords > 0,
      limits: this.limits,
      retainedBytes: this.records.reduce((total, record) => total + record.bytes, 0),
      retainedRecords: this.records.length,
      omittedBytes: this.omittedBytes,
      omittedRecords: this.omittedRecords,
    };
  }

  async append(record: T): Promise<void> {
    this.ensureOpen();
    const serialized = serializeRecord(record, this.serialize);
    const previous = this.snapshot();

    if (serialized.bytes > this.limits.maxBytes) {
      this.omit(serialized);
    } else {
      this.records.push(serialized);
      this.compact();
    }

    try {
      await this.flush();
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  async flush(): Promise<void> {
    this.ensureOpen();
    const content = this.records.map((record) => record.value).join('');
    this.writeQueue = this.writeQueue.then(() => this.replaceArtifact(content));
    await this.writeQueue;
  }

  async close(): Promise<ArtifactWriterStats> {
    if (!this.closed) {
      await this.flush();
      this.closed = true;
    }
    return this.getStats();
  }

  private compact(): void {
    let retainedBytes = this.records.reduce((total, record) => total + record.bytes, 0);
    while (this.records.length > this.limits.maxRecords || retainedBytes > this.limits.maxBytes) {
      const removed = this.records.shift();
      if (removed === undefined) {
        break;
      }
      retainedBytes -= removed.bytes;
      this.omit(removed);
    }
  }

  private omit(record: SerializedRecord): void {
    this.omittedRecords += 1;
    this.omittedBytes += record.bytes;
  }

  private async replaceArtifact(content: string): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new AppError(
        {
          code: 'STORAGE_FAILED',
          message: 'Unable to write the execution artifact',
          recoverable: true,
          details: { filePath: this.filePath, operation: 'write' },
        },
        { cause: error },
      );
    }
  }

  private snapshot(): readonly [readonly SerializedRecord[], number, number] {
    return [this.records.slice(), this.omittedBytes, this.omittedRecords];
  }

  private restore(snapshot: readonly [readonly SerializedRecord[], number, number]): void {
    this.records = snapshot[0].slice();
    this.omittedBytes = snapshot[1];
    this.omittedRecords = snapshot[2];
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new AppError({
        code: 'STORAGE_FAILED',
        message: 'The execution artifact is already closed',
        recoverable: true,
        details: { filePath: this.filePath, operation: 'closed' },
      });
    }
  }
}

function serializeRecord<T>(record: T, serialize: (record: T) => unknown): SerializedRecord {
  let value: string;
  try {
    value = `${JSON.stringify(serialize(record))}\n`;
  } catch (error) {
    throw new AppError(
      {
        code: 'STORAGE_FAILED',
        message: 'Unable to serialize the execution artifact record',
        recoverable: true,
        details: { operation: 'serialize' },
      },
      { cause: error },
    );
  }
  return { value, bytes: Buffer.byteLength(value, 'utf8') };
}

function validateLimits(limits: ArtifactWriterLimits): void {
  if (
    !Number.isInteger(limits.maxBytes) ||
    limits.maxBytes < 1 ||
    !Number.isInteger(limits.maxRecords) ||
    limits.maxRecords < 1
  ) {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'Execution artifact limits must be positive integers',
      recoverable: true,
      details: { maxBytes: limits.maxBytes, maxRecords: limits.maxRecords },
    });
  }
}
