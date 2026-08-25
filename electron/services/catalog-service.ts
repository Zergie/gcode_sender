import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BUNDLED_COMMAND_CATALOG } from '../../shared/bundled-catalog';
import { MAX_CATALOG_BYTES, parseCommandCatalog } from '../../shared/catalog';
import type {
  CatalogApprovalRequest,
  CommandCatalogEntry,
  CommandCatalogSnapshot,
  FirmwareInfo,
} from '../../shared/contracts';
import { AppError, asAppError } from '../../shared/errors';
import type { Logger } from '../logger';
import type { PersistenceStore } from './persistence-store';

interface CatalogCacheFile {
  readonly version: 1;
  readonly url: string;
  readonly firmwareId: string;
  readonly fetchedAt: string;
  readonly entries: readonly CommandCatalogEntry[];
}

interface PendingApproval {
  readonly request: CatalogApprovalRequest;
  readonly firmware: FirmwareInfo;
}

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 8_000;

export class CatalogService {
  private firmware: FirmwareInfo | null = null;
  private snapshot: CommandCatalogSnapshot = bundledSnapshot(null);
  private pendingApproval: PendingApproval | null = null;
  private readonly approvalListeners = new Set<(request: CatalogApprovalRequest) => void>();
  private readonly snapshotListeners = new Set<(snapshot: CommandCatalogSnapshot) => void>();

  constructor(
    private readonly cacheDirectory: string,
    private readonly store: PersistenceStore,
    private readonly logger: Logger,
  ) {}

  get(): CommandCatalogSnapshot {
    return structuredClone(this.snapshot);
  }

  async setFirmware(firmware: FirmwareInfo): Promise<void> {
    this.firmware = firmware;
    const cached = await this.readCache(firmware);
    if (cached !== null) {
      this.setSnapshot(
        toSnapshot(cached, Date.now() - Date.parse(cached.fetchedAt) > CACHE_MAX_AGE_MS, 'cache'),
      );
    } else {
      this.setSnapshot(bundledSnapshot(firmwareId(firmware)));
    }

    if (cached === null || Date.now() - Date.parse(cached.fetchedAt) > CACHE_MAX_AGE_MS) {
      void this.refresh().catch((error: unknown) => {
        const appError = asAppError(error, 'CATALOG_FETCH_FAILED');
        if (appError.code !== 'CATALOG_APPROVAL_REQUIRED') {
          this.logger.warn('Automatic command catalog refresh failed', { error: appError.message });
        }
      });
    }
  }

  async refresh(): Promise<CommandCatalogSnapshot> {
    const firmware = this.firmware;
    const urlText = firmware?.gcodeCatalogUrl;
    if (firmware === null || urlText === undefined) {
      this.setSnapshot(bundledSnapshot(firmware === null ? null : firmwareId(firmware)));
      return this.get();
    }

    const url = parseHttpsUrl(urlText);
    const approvedHosts = this.store.getSettings().approvedCatalogHosts;
    if (!approvedHosts.includes(url.host)) {
      const request: CatalogApprovalRequest = {
        id: randomUUID(),
        host: url.host,
        url: url.href,
        firmwareId: firmwareId(firmware),
      };
      this.pendingApproval = { request, firmware };
      for (const listener of this.approvalListeners) {
        listener(request);
      }
      throw new AppError({
        code: 'CATALOG_APPROVAL_REQUIRED',
        message: `Approval is required before contacting ${url.host}`,
        recoverable: true,
        details: { requestId: request.id, host: request.host },
      });
    }

    try {
      const entries = await fetchCatalog(url);
      const cache: CatalogCacheFile = {
        version: 1,
        url: url.href,
        firmwareId: firmwareId(firmware),
        fetchedAt: new Date().toISOString(),
        entries,
      };
      await this.writeCache(cache);
      this.setSnapshot(toSnapshot(cache, false, 'remote'));
      return this.get();
    } catch (error) {
      const cached = await this.readCache(firmware);
      this.setSnapshot(
        cached === null ? bundledSnapshot(firmwareId(firmware)) : toSnapshot(cached, true, 'cache'),
      );
      const appError = asAppError(error, 'CATALOG_FETCH_FAILED');
      this.logger.warn('Using fallback command catalog', {
        error: appError.message,
        url: url.href,
      });
      return this.get();
    }
  }

  async approve(requestId: string, approved: boolean): Promise<CommandCatalogSnapshot> {
    const pending = this.pendingApproval;
    if (pending === null || pending.request.id !== requestId) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Catalog approval request is no longer active',
        recoverable: true,
      });
    }
    this.pendingApproval = null;
    if (!approved) {
      return this.get();
    }
    await this.store.approveCatalogHost(pending.request.host);
    // Only refresh if the device has not changed while approval was pending.
    if (this.firmware === null || firmwareId(this.firmware) !== firmwareId(pending.firmware)) {
      return this.get();
    }
    return this.refresh();
  }

  subscribeApproval(listener: (request: CatalogApprovalRequest) => void): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }

  subscribeSnapshot(listener: (snapshot: CommandCatalogSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  private setSnapshot(snapshot: CommandCatalogSnapshot): void {
    this.snapshot = snapshot;
    const event = this.get();
    for (const listener of this.snapshotListeners) {
      listener(event);
    }
  }

  private async readCache(firmware: FirmwareInfo): Promise<CatalogCacheFile | null> {
    const cachePath = this.cachePath(firmware);
    try {
      const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
      if (!isRecord(parsed) || parsed['version'] !== 1) {
        return null;
      }
      if (
        parsed['url'] !== firmware.gcodeCatalogUrl ||
        parsed['firmwareId'] !== firmwareId(firmware) ||
        typeof parsed['fetchedAt'] !== 'string' ||
        !Number.isFinite(Date.parse(parsed['fetchedAt']))
      ) {
        return null;
      }
      const entries = parseCommandCatalog(parsed['entries']);
      if (entries === null) {
        return null;
      }
      return {
        version: 1,
        url: parsed['url'] as string,
        firmwareId: parsed['firmwareId'] as string,
        fetchedAt: parsed['fetchedAt'] as string,
        entries,
      };
    } catch {
      return null;
    }
  }

  private async writeCache(cache: CatalogCacheFile): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true });
    const target = this.cachePathFor(cache.url, cache.firmwareId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new AppError(
        {
          code: 'STORAGE_FAILED',
          message: 'Unable to cache the command catalog',
          recoverable: true,
        },
        { cause: error },
      );
    }
  }

  private cachePath(firmware: FirmwareInfo): string {
    return this.cachePathFor(firmware.gcodeCatalogUrl ?? '', firmwareId(firmware));
  }

  private cachePathFor(url: string, id: string): string {
    const hash = createHash('sha256').update(`${id}\0${url}`).digest('hex');
    return path.join(this.cacheDirectory, `${hash}.json`);
  }
}

async function fetchCatalog(url: URL): Promise<readonly CommandCatalogEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new AppError({
        code: 'CATALOG_FETCH_FAILED',
        message: `Catalog server returned HTTP ${response.status}`,
        recoverable: true,
      });
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_BYTES) {
      throw new AppError({
        code: 'CATALOG_INVALID',
        message: 'Command catalog is too large',
        recoverable: true,
      });
    }
    const bytes = await readBoundedBody(response, MAX_CATALOG_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw new AppError(
        {
          code: 'CATALOG_INVALID',
          message: 'Command catalog is not valid UTF-8 JSON',
          recoverable: true,
        },
        { cause: error },
      );
    }
    const entries = parseCommandCatalog(parsed);
    if (entries === null) {
      throw new AppError({
        code: 'CATALOG_INVALID',
        message: 'Command catalog schema is invalid',
        recoverable: true,
      });
    }
    return entries;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError({
        code: 'TIMEOUT',
        message: 'Command catalog request timed out',
        recoverable: true,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new AppError({
          code: 'CATALOG_INVALID',
          message: 'Command catalog is too large',
          recoverable: true,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError(
      {
        code: 'CATALOG_INVALID',
        message: 'Firmware supplied an invalid command catalog URL',
        recoverable: true,
      },
      { cause: error },
    );
  }
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    throw new AppError({
      code: 'CATALOG_INVALID',
      message: 'Command catalog URL must use HTTPS',
      recoverable: true,
    });
  }
  return url;
}

function firmwareId(firmware: FirmwareInfo): string {
  return firmware.uuid ?? firmware.firmwareName;
}

function bundledSnapshot(id: string | null): CommandCatalogSnapshot {
  return {
    entries: BUNDLED_COMMAND_CATALOG,
    source: 'bundled',
    url: null,
    firmwareId: id,
    fetchedAt: null,
    stale: true,
  };
}

function toSnapshot(
  cache: CatalogCacheFile,
  stale: boolean,
  source: 'cache' | 'remote',
): CommandCatalogSnapshot {
  return {
    entries: cache.entries,
    source,
    url: cache.url,
    firmwareId: cache.firmwareId,
    fetchedAt: cache.fetchedAt,
    stale,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
