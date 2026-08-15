import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MainLogger } from './logger';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('main-process log rotation', () => {
  it('rotates at the size limit and discards an already oversized active log', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const directory = await mkdtemp(path.join(tmpdir(), 'gcode-sender-log-'));
    temporaryDirectories.push(directory);
    const logsDirectory = path.join(directory, 'logs');
    const logPath = path.join(logsDirectory, 'main.log');
    await mkdir(logsDirectory, { recursive: true });
    await writeFile(logPath, Buffer.alloc(MAX_LOG_BYTES, 120));
    const logger = new MainLogger(directory);

    logger.info('rotate');
    await logger.flush();

    expect((await stat(`${logPath}.1`)).size).toBe(MAX_LOG_BYTES);
    expect((await stat(logPath)).size).toBeLessThan(MAX_LOG_BYTES);

    await writeFile(logPath, Buffer.alloc(MAX_LOG_BYTES + 1, 120));
    logger.info('replace oversized log');
    await logger.flush();

    expect((await stat(logPath)).size).toBeLessThan(MAX_LOG_BYTES);
  });
});
