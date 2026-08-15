import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_ARCHIVES = 3;
const MAX_LOG_ENTRY_BYTES = 64 * 1024;

export class MainLogger implements Logger {
  private readonly logPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.logPath = path.join(userDataPath, 'logs', 'main.log');
  }

  debug(message: string, details?: Readonly<Record<string, unknown>>): void {
    this.write('debug', message, details);
  }

  info(message: string, details?: Readonly<Record<string, unknown>>): void {
    this.write('info', message, details);
  }

  warn(message: string, details?: Readonly<Record<string, unknown>>): void {
    this.write('warn', message, details);
  }

  error(message: string, details?: Readonly<Record<string, unknown>>): void {
    this.write('error', message, details);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private write(
    level: LogLevel,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): void {
    const record = serializeRecord(level, message, details);
    const consoleMethod =
      level === 'debug'
        ? console.debug
        : level === 'info'
          ? console.info
          : level === 'warn'
            ? console.warn
            : console.error;
    consoleMethod(`[${level}] ${message}`, details ?? '');

    const write = this.writeQueue
      .catch(() => undefined)
      .then(() => this.appendWithRotation(record));
    this.writeQueue = write.catch((error: unknown) => {
      console.error('Unable to append the main-process log', error);
    });
  }

  private async appendWithRotation(record: string): Promise<void> {
    await mkdir(path.dirname(this.logPath), { recursive: true });
    const existingBytes = await stat(this.logPath)
      .then((details) => details.size)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return 0;
        }
        throw error;
      });
    const recordBytes = Buffer.byteLength(record, 'utf8');
    await this.removeOversizedArchives();
    if (existingBytes > MAX_LOG_BYTES) {
      await rm(this.logPath, { force: true });
    } else if (existingBytes > 0 && existingBytes + recordBytes > MAX_LOG_BYTES) {
      await this.rotate();
    }
    await appendFile(this.logPath, record, 'utf8');
  }

  private async rotate(): Promise<void> {
    await rm(`${this.logPath}.${MAX_LOG_ARCHIVES}`, { force: true });
    for (let index = MAX_LOG_ARCHIVES - 1; index >= 1; index -= 1) {
      await renameIfPresent(`${this.logPath}.${index}`, `${this.logPath}.${index + 1}`);
    }
    await renameIfPresent(this.logPath, `${this.logPath}.1`);
  }

  private async removeOversizedArchives(): Promise<void> {
    await Promise.all(
      Array.from({ length: MAX_LOG_ARCHIVES }, async (_value, offset) => {
        const archivePath = `${this.logPath}.${offset + 1}`;
        const archiveBytes = await stat(archivePath)
          .then((details) => details.size)
          .catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return 0;
            }
            throw error;
          });
        if (archiveBytes > MAX_LOG_BYTES) {
          await rm(archivePath, { force: true });
        }
      }),
    );
  }
}

function serializeRecord(
  level: LogLevel,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): string {
  const base = { timestamp: new Date().toISOString(), level, message };
  let serialized: string;
  try {
    serialized = JSON.stringify({ ...base, ...(details === undefined ? {} : { details }) });
  } catch {
    serialized = JSON.stringify({ ...base, details: '[unserializable]' });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LOG_ENTRY_BYTES) {
    serialized = JSON.stringify({
      ...base,
      message: message.slice(0, 8_192),
      details: '[truncated]',
    });
  }
  return `${serialized}\n`;
}

async function renameIfPresent(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
