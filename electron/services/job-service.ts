import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import type {
  JobExecutionLogEntry,
  JobFileInfo,
  LoadedGcodeProgram,
  JobProgress,
  JobStartRequest,
  JobState,
  JobTimeoutDecision,
  JobTimeoutEvent,
  JsonValue,
  SessionMetadata,
} from '../../shared/contracts';
import { AppError, asAppError } from '../../shared/errors';
import { INITIAL_GCODE_COMMENT_STATE, normalizeGcodeLine } from '../../shared/job-normalizer';
import {
  hasHeatingProfileMarker,
  MAX_HEATING_PROFILE_FILE_BYTES,
  MAX_HEATING_PROFILE_PREFIX_BYTES,
  parseHeatingProfileDocument,
} from '../../shared/heating-profile-document';
import type { Logger } from '../logger';
import type { ActivityService } from './activity-service';
import type { PersistenceStore } from './persistence-store';
import type { SerialService } from './serial-service';

export interface JobLogPage {
  readonly entries: readonly JobExecutionLogEntry[];
  readonly offset: number;
  readonly nextOffset: number | null;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const SUPPORTED_EXTENSIONS = new Set(['.gcode', '.gco', '.gc', '.txt']);

export class JobService {
  private state: JobState = idleState();
  private readonly stateListeners = new Set<(state: JobState) => void>();
  private readonly timeoutListeners = new Set<(event: JobTimeoutEvent) => void>();
  private pauseGate: Deferred<void> | null = null;
  private timeoutDecision: {
    readonly id: string;
    readonly deferred: Deferred<JobTimeoutDecision>;
  } | null = null;
  private stopRequested = false;
  private activeRun: Promise<void> | null = null;
  private activeCommandAbort: AbortController | null = null;
  private logPath: string | null = null;
  private logWriteQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionsDirectory: string,
    private readonly serial: SerialService,
    private readonly activity: ActivityService,
    private readonly store: PersistenceStore,
    private readonly logger: Logger,
  ) {
    this.serial.subscribe('state', (connection) => {
      if (
        !['disconnected', 'error'].includes(connection.status) ||
        !isJobActive(this.state.status)
      ) {
        return;
      }
      this.stopRequested = true;
      this.activeCommandAbort?.abort();
      this.pauseGate?.resolve();
      this.pauseGate = null;
      this.timeoutDecision?.deferred.resolve('stop');
      this.timeoutDecision = null;
      this.state = { ...this.state, status: 'stopping', pauseRequested: false };
      this.notifyState();
    });
  }

  getState(): JobState {
    return structuredClone(this.state);
  }

  async inspectFile(filePath: string): Promise<LoadedGcodeProgram> {
    return inspectProgramMetadata(await this.inspectJobFile(filePath));
  }

  private async inspectJobFile(filePath: string): Promise<JobFileInfo> {
    validatePath(filePath);
    const extension = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new AppError({
        code: 'FILE_INVALID',
        message: 'Select a .gcode, .gco, .gc, or .txt file',
        recoverable: true,
      });
    }
    try {
      const details = await stat(filePath);
      if (!details.isFile()) {
        throw new AppError({
          code: 'FILE_INVALID',
          message: 'The selected path is not a file',
          recoverable: true,
        });
      }
      const file: JobFileInfo = {
        path: filePath,
        name: path.basename(filePath),
        sizeBytes: details.size,
        modifiedAt: details.mtime.toISOString(),
        extension: extension as JobFileInfo['extension'],
      };
      return file;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        {
          code: 'FILE_NOT_FOUND',
          message: 'The selected G-code file cannot be read',
          recoverable: true,
        },
        { cause: error },
      );
    }
  }

  async start(request: JobStartRequest): Promise<JobState> {
    if (isJobActive(this.state.status)) {
      throw new AppError({
        code: 'BUSY',
        message: 'A file is already streaming',
        recoverable: true,
      });
    }
    if (this.serial.getState().status !== 'connected') {
      throw new AppError({
        code: 'NOT_CONNECTED',
        message: 'Connect before starting a job',
        recoverable: true,
      });
    }
    this.activity.acquire('job');

    try {
      // Reserve the lane before any asynchronous preparation so overlapping
      // starts cannot both inspect and later compete for the same job run.
      // Starting a stream intentionally performs only path/stat checks. Metadata
      // classification is an explicit load-time concern, never a command preflight.
      const file = await this.inspectJobFile(request.path);
      const startLine = request.startLine ?? 1;
      if (!Number.isInteger(startLine) || startLine < 1) {
        throw new AppError({
          code: 'INVALID_ARGUMENT',
          message: 'Start line must be a positive integer',
          recoverable: true,
        });
      }
      const timeoutMs = request.commandTimeoutMs ?? this.store.getSettings().commandTimeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 600_000) {
        throw new AppError({
          code: 'INVALID_ARGUMENT',
          message: 'Command timeout is invalid',
          recoverable: true,
        });
      }

      return this.beginRun(file, startLine, timeoutMs);
    } catch (error) {
      this.activity.release('job');
      throw error;
    }
  }

  private beginRun(file: JobFileInfo, startLine: number, timeoutMs: number): JobState {
    const id = randomUUID();
    this.logPath = path.join(this.sessionsDirectory, `${id}.job.jsonl`);
    this.logWriteQueue = Promise.resolve();
    this.stopRequested = false;
    this.pauseGate = null;
    this.timeoutDecision = null;
    this.state = {
      id,
      status: 'preparing',
      file,
      startedAt: new Date().toISOString(),
      endedAt: null,
      progress: initialProgress(file.sizeBytes),
      lastCompletedSourceLine: null,
      pauseRequested: false,
      error: null,
    };
    this.notifyState();
    const activeRun = this.run(file, startLine, timeoutMs);
    this.activeRun = activeRun;
    const clearActiveRun = (): void => {
      if (this.activeRun === activeRun) {
        this.activeRun = null;
      }
    };
    void activeRun.then(clearActiveRun, clearActiveRun);
    return this.getState();
  }

  pauseAfterCurrent(): JobState {
    if (!['preparing', 'streaming'].includes(this.state.status)) {
      throw new AppError({
        code: 'INVALID_STATE',
        message: 'The job is not streaming',
        recoverable: true,
      });
    }
    this.state = { ...this.state, status: 'pause-pending', pauseRequested: true };
    this.notifyState();
    return this.getState();
  }

  resume(): JobState {
    if (!['paused', 'pause-pending'].includes(this.state.status)) {
      throw new AppError({
        code: 'INVALID_STATE',
        message: 'The job is not paused',
        recoverable: true,
      });
    }
    this.state = { ...this.state, status: 'streaming', pauseRequested: false };
    const gate = this.pauseGate;
    this.pauseGate = null;
    gate?.resolve();
    this.notifyState();
    return this.getState();
  }

  async stop(): Promise<JobState> {
    const activeRun = this.activeRun;
    if (activeRun === null) {
      return this.getState();
    }
    if (!isJobActive(this.state.status)) {
      await activeRun;
      return this.getState();
    }
    if (this.stopRequested) {
      await activeRun;
      return this.getState();
    }
    this.stopRequested = true;
    this.state = { ...this.state, status: 'stopping', pauseRequested: false };
    this.notifyState();
    this.activeCommandAbort?.abort();
    this.pauseGate?.resolve();
    this.pauseGate = null;
    this.timeoutDecision?.deferred.resolve('stop');
    this.timeoutDecision = null;
    await this.serial.bestEffortHeaterOff();
    await activeRun;
    return this.getState();
  }

  resolveTimeout(decisionId: string, decision: JobTimeoutDecision): JobState {
    if (!['retry', 'continue', 'stop'].includes(decision)) {
      throw new AppError({
        code: 'INVALID_ARGUMENT',
        message: 'Unknown timeout decision',
        recoverable: true,
      });
    }
    const pending = this.timeoutDecision;
    if (pending === null || pending.id !== decisionId) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Timeout decision is no longer active',
        recoverable: true,
      });
    }
    this.timeoutDecision = null;
    pending.deferred.resolve(decision);
    return this.getState();
  }

  async getLog(offset = 0, limit = 500): Promise<JobLogPage> {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 5_000
    ) {
      throw new AppError({
        code: 'INVALID_ARGUMENT',
        message: 'Log page is invalid',
        recoverable: true,
      });
    }
    await this.logWriteQueue;
    return readJobLogPage(this.logPath, offset, limit);
  }

  subscribeState(listener: (state: JobState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  subscribeTimeout(listener: (event: JobTimeoutEvent) => void): () => void {
    this.timeoutListeners.add(listener);
    return () => this.timeoutListeners.delete(listener);
  }

  private async run(file: JobFileInfo, startLine: number, timeoutMs: number): Promise<void> {
    const startedMonotonic = performance.now();
    let sourceLine = 0;
    let completedCommands = 0;
    let bytesRead = 0;
    let comments = INITIAL_GCODE_COMMENT_STATE;
    try {
      await mkdir(this.sessionsDirectory, { recursive: true });
      this.state = { ...this.state, status: 'streaming' };
      this.notifyState();
      const input = createReadStream(file.path, { encoding: 'utf8' });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });

      for await (const rawLine of lines) {
        sourceLine += 1;
        bytesRead = Math.min(file.sizeBytes, bytesRead + Buffer.byteLength(rawLine, 'utf8') + 1);
        if (rawLine.includes('\uFFFD')) {
          throw new AppError({
            code: 'FILE_INVALID',
            message: `File is not valid UTF-8 near line ${sourceLine}`,
            recoverable: true,
          });
        }
        const normalized = normalizeGcodeLine(rawLine, comments);
        comments = normalized.state;
        if (sourceLine < startLine || normalized.command === null) {
          this.updateProgress(
            sourceLine,
            completedCommands,
            bytesRead,
            file.sizeBytes,
            startedMonotonic,
          );
          continue;
        }
        if (this.stopRequested) {
          break;
        }
        await this.waitWhilePaused();
        if (this.stopRequested) {
          break;
        }
        const completed = await this.transmitWithDecisions(
          normalized.command,
          sourceLine,
          timeoutMs,
        );
        if (!completed || this.stopRequested) {
          break;
        }
        completedCommands += 1;
        this.state = { ...this.state, lastCompletedSourceLine: sourceLine };
        this.updateProgress(
          sourceLine,
          completedCommands,
          bytesRead,
          file.sizeBytes,
          startedMonotonic,
        );
      }

      this.state = {
        ...this.state,
        status: this.stopRequested ? 'stopped' : 'completed',
        endedAt: new Date().toISOString(),
        pauseRequested: false,
        progress:
          this.state.progress === null
            ? null
            : {
                ...this.state.progress,
                percent: this.stopRequested ? this.state.progress.percent : 100,
                etaMs: null,
              },
      };
    } catch (error) {
      const appError = asAppError(error);
      this.logger.error('G-code streaming failed', { error: appError.message, sourceLine });
      this.state = {
        ...this.state,
        status: this.stopRequested ? 'stopped' : 'failed',
        endedAt: new Date().toISOString(),
        pauseRequested: false,
        error: this.stopRequested ? null : appError.toInfo(),
      };
    } finally {
      this.activeCommandAbort = null;
      this.pauseGate?.resolve();
      this.pauseGate = null;
      this.timeoutDecision?.deferred.resolve('stop');
      this.timeoutDecision = null;
      this.notifyState();
      await this.logWriteQueue.catch(() => undefined);
      await this.persistSession().catch((error: unknown) => {
        this.logger.warn('Unable to retain job session metadata', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.activity.release('job');
    }
  }

  private async transmitWithDecisions(
    command: string,
    sourceLine: number,
    timeoutMs: number,
  ): Promise<boolean> {
    while (!this.stopRequested) {
      await this.appendLog({
        timestamp: new Date().toISOString(),
        sourceLine,
        command,
        outcome: 'sent',
      });
      const controller = new AbortController();
      this.activeCommandAbort = controller;
      try {
        const response = await this.serial.sendAndWait(
          command,
          timeoutMs,
          controller.signal,
          'job',
        );
        this.activeCommandAbort = null;
        if (response.parsed.kind === 'error') {
          await this.appendLog({
            timestamp: new Date().toISOString(),
            sourceLine,
            command,
            outcome: 'error',
            response: response.raw,
          });
          throw new AppError({ code: 'INVALID_STATE', message: response.raw, recoverable: true });
        }
        await this.appendLog({
          timestamp: new Date().toISOString(),
          sourceLine,
          command,
          outcome: 'completed',
          response: response.raw,
        });
        if (this.state.pauseRequested) {
          await this.waitWhilePaused();
        }
        return true;
      } catch (error) {
        this.activeCommandAbort = null;
        const appError = asAppError(error);
        if (this.stopRequested || controller.signal.aborted) {
          return false;
        }
        if (appError.code !== 'TIMEOUT') {
          throw appError;
        }
        await this.appendLog({
          timestamp: new Date().toISOString(),
          sourceLine,
          command,
          outcome: 'timeout',
        });
        const decisionId = randomUUID();
        const deferred = createDeferred<JobTimeoutDecision>();
        this.timeoutDecision = { id: decisionId, deferred };
        this.state = { ...this.state, status: 'awaiting-decision' };
        this.notifyState();
        const timeoutEvent: JobTimeoutEvent = {
          decisionId,
          jobId: this.state.id!,
          sourceLine,
          command,
          timeoutMs,
          timestamp: new Date().toISOString(),
        };
        for (const listener of this.timeoutListeners) {
          listener(timeoutEvent);
        }
        const decision = await deferred.promise;
        if (decision === 'stop') {
          this.stopRequested = true;
          await this.serial.bestEffortHeaterOff();
          return false;
        }
        await this.appendLog({
          timestamp: new Date().toISOString(),
          sourceLine,
          command,
          outcome: decision === 'retry' ? 'retried' : 'continued',
        });
        this.state = { ...this.state, status: 'streaming' };
        this.notifyState();
        if (decision === 'continue') {
          return true;
        }
      }
    }
    return false;
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.state.pauseRequested) {
      return;
    }
    if (this.pauseGate === null) {
      this.pauseGate = createDeferred<void>();
    }
    this.state = { ...this.state, status: 'paused' };
    this.notifyState();
    await this.pauseGate.promise;
  }

  private updateProgress(
    sourceLine: number,
    completedCommands: number,
    bytesRead: number,
    totalBytes: number,
    startedMonotonic: number,
  ): void {
    const elapsedMs = performance.now() - startedMonotonic;
    const percent = totalBytes === 0 ? 100 : Math.min(100, (bytesRead / totalBytes) * 100);
    const etaMs = percent <= 0 || percent >= 100 ? null : elapsedMs * ((100 - percent) / percent);
    const progress: JobProgress = {
      sourceLine,
      completedCommands,
      bytesRead,
      totalBytes,
      percent,
      elapsedMs,
      etaMs,
    };
    this.state = { ...this.state, progress };
    this.notifyState();
  }

  private async appendLog(entry: JobExecutionLogEntry): Promise<void> {
    const logPath = this.logPath;
    if (logPath === null) {
      return;
    }
    this.logWriteQueue = this.logWriteQueue.then(() =>
      appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8'),
    );
    await this.logWriteQueue;
  }

  private async persistSession(): Promise<void> {
    if (
      this.state.id === null ||
      this.state.file === null ||
      this.state.startedAt === null ||
      this.state.endedAt === null
    ) {
      return;
    }
    const data: JsonValue = {
      file: {
        name: this.state.file.name,
        path: this.state.file.path,
        sizeBytes: this.state.file.sizeBytes,
      },
      status: this.state.status,
      lastCompletedSourceLine: this.state.lastCompletedSourceLine,
      logPath: this.logPath,
    };
    const session: SessionMetadata = {
      id: this.state.id,
      version: 1,
      kind: 'job',
      title: this.state.file.name,
      startedAt: this.state.startedAt,
      endedAt: this.state.endedAt,
      pinned: false,
      data,
    };
    await this.store.saveSession(session);
  }

  private notifyState(): void {
    const snapshot = this.getState();
    for (const listener of this.stateListeners) {
      listener(snapshot);
    }
  }
}

export async function readJobLogPage(
  logPath: string | null,
  offset: number,
  limit: number,
): Promise<JobLogPage> {
  if (logPath === null) {
    return { entries: [], offset, nextOffset: null };
  }
  const entries: JobExecutionLogEntry[] = [];
  let index = 0;
  try {
    const input = createReadStream(logPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (index >= offset) {
        entries.push(JSON.parse(line) as JobExecutionLogEntry);
      }
      index += 1;
      if (entries.length > limit) {
        break;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new AppError(
        {
          code: 'STORAGE_FAILED',
          message: 'Unable to read the execution log',
          recoverable: true,
        },
        { cause: error },
      );
    }
  }
  const hasMore = entries.length > limit;
  return {
    entries: entries.slice(0, limit),
    offset,
    nextOffset: hasMore ? offset + limit : null,
  };
}

function initialProgress(totalBytes: number): JobProgress {
  return {
    sourceLine: 0,
    completedCommands: 0,
    bytesRead: 0,
    totalBytes,
    percent: 0,
    elapsedMs: 0,
    etaMs: null,
  };
}

function idleState(): JobState {
  return {
    id: null,
    status: 'idle',
    file: null,
    startedAt: null,
    endedAt: null,
    progress: null,
    lastCompletedSourceLine: null,
    pauseRequested: false,
    error: null,
  };
}

function isJobActive(status: JobState['status']): boolean {
  return [
    'preparing',
    'streaming',
    'pause-pending',
    'paused',
    'awaiting-decision',
    'stopping',
  ].includes(status);
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function validatePath(filePath: string): void {
  if (
    typeof filePath !== 'string' ||
    filePath.length < 1 ||
    filePath.length > 32_767 ||
    filePath.includes('\0')
  ) {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'File path is invalid',
      recoverable: true,
    });
  }
}

async function inspectProgramMetadata(file: JobFileInfo): Promise<LoadedGcodeProgram> {
  const generic = (metadataWarning: string | null = null): LoadedGcodeProgram => ({
    file,
    kind: 'gcode',
    profile: null,
    metadataWarning,
  });
  try {
    const prefixSize = Math.min(file.sizeBytes, MAX_HEATING_PROFILE_PREFIX_BYTES);
    const handle = await open(file.path, 'r');
    let prefix: Uint8Array;
    try {
      const buffer = Buffer.alloc(prefixSize);
      const { bytesRead } = await handle.read(buffer, 0, prefixSize, 0);
      prefix = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    if (!hasHeatingProfileMarker(prefix)) return generic();
    if (file.sizeBytes > MAX_HEATING_PROFILE_FILE_BYTES) {
      return generic('Heating-profile metadata was ignored because the file is too large.');
    }
    const contents = await readAtMost(file.path, MAX_HEATING_PROFILE_FILE_BYTES);
    if (contents === null) {
      return generic('Heating-profile metadata was ignored because the file is too large.');
    }
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    } catch {
      return generic('Heating-profile metadata was ignored because the file is not valid UTF-8.');
    }
    const parsed = parseHeatingProfileDocument(source);
    return parsed.ok
      ? { file, kind: 'heating-profile', profile: parsed.profile, metadataWarning: null }
      : generic(parsed.warning);
  } catch {
    return generic('Heating-profile metadata could not be inspected.');
  }
}

async function readAtMost(filePath: string, maximumBytes: number): Promise<Uint8Array | null> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > maximumBytes ? null : buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
