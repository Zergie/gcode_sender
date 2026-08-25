import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AppSettings,
  SessionMetadata,
  SettingsPatch,
  StoredProfile,
  ThemePreference,
} from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import type { Logger } from '../logger';

interface PersistedState {
  readonly version: 2;
  readonly settings: AppSettings;
  readonly profiles: readonly StoredProfile[];
  readonly sessions: readonly SessionMetadata[];
}

const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  version: 2,
  theme: 'system',
  lastSerialPort: null,
  startupMacro: '',
  commandTimeoutMs: 8_000,
  approvedCatalogHosts: [],
  firmwareInoPath: null,
});

const MAX_UNPINNED_SESSIONS = 100;
const MAX_UNPINNED_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

export class PersistenceStore {
  private readonly statePath: string;
  private readonly sessionsDirectory: string;
  private state: PersistedState = {
    version: 2,
    settings: DEFAULT_SETTINGS,
    profiles: [],
    sessions: [],
  };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    userDataPath: string,
    private readonly logger: Logger,
  ) {
    this.statePath = path.join(userDataPath, 'state.v2.json');
    this.sessionsDirectory = path.join(userDataPath, 'sessions');
  }

  async initialize(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, 'utf8'));
      this.state = validatePersistedState(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn('Ignoring unreadable v2 state and using defaults', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await this.persist();
    }
    await this.prune();
  }

  getSettings(): AppSettings {
    return structuredClone(this.state.settings);
  }

  async updateSettings(patch: SettingsPatch): Promise<AppSettings> {
    if (hasApprovedCatalogHosts(patch)) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'Approved catalog hosts can only be changed by the trusted catalog flow',
        recoverable: true,
      });
    }
    const settings = validateSettings({ ...this.state.settings, ...patch, version: 2 });
    this.state = { ...this.state, settings };
    await this.persist();
    return structuredClone(settings);
  }

  async approveCatalogHost(host: string): Promise<AppSettings> {
    if (!isBoundedString(host, 1, 253)) {
      throw invalid('Approved catalog host is invalid');
    }
    const hosts = new Set(this.state.settings.approvedCatalogHosts);
    hosts.add(host);
    const settings = validateSettings({
      ...this.state.settings,
      approvedCatalogHosts: [...hosts].sort(),
      version: 2,
    });
    this.state = { ...this.state, settings };
    await this.persist();
    return structuredClone(settings);
  }

  async revokeCatalogHost(host: string): Promise<AppSettings> {
    if (!isBoundedString(host, 1, 253)) {
      throw invalid('Approved catalog host is invalid');
    }
    if (!this.state.settings.approvedCatalogHosts.includes(host)) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Approved catalog host was not found',
        recoverable: true,
      });
    }
    const settings = validateSettings({
      ...this.state.settings,
      approvedCatalogHosts: this.state.settings.approvedCatalogHosts.filter(
        (approvedHost) => approvedHost !== host,
      ),
      version: 2,
    });
    this.state = { ...this.state, settings };
    await this.persist();
    return structuredClone(settings);
  }

  listProfiles(): readonly StoredProfile[] {
    return structuredClone(this.state.profiles);
  }

  async saveProfile(candidate: StoredProfile): Promise<StoredProfile> {
    const profile = validateProfile(candidate);
    const profiles = this.state.profiles.filter(({ id }) => id !== profile.id);
    this.state = { ...this.state, profiles: [...profiles, profile] };
    await this.persist();
    return structuredClone(profile);
  }

  async removeProfile(id: string): Promise<void> {
    assertId(id);
    this.state = {
      ...this.state,
      profiles: this.state.profiles.filter((profile) => profile.id !== id),
    };
    await this.persist();
  }

  async importProfiles(value: unknown): Promise<readonly StoredProfile[]> {
    if (!Array.isArray(value)) {
      throw invalid('Imported profiles must be a JSON array');
    }
    const imported = value.map(validateProfile);
    const merged = new Map(this.state.profiles.map((profile) => [profile.id, profile]));
    for (const profile of imported) {
      merged.set(profile.id, profile);
    }
    this.state = { ...this.state, profiles: [...merged.values()] };
    await this.persist();
    return structuredClone(imported);
  }

  listSessions(): readonly SessionMetadata[] {
    return structuredClone(this.state.sessions);
  }

  async saveSession(candidate: SessionMetadata): Promise<SessionMetadata> {
    const session = validateSession(candidate);
    const previousState = this.state;
    const sessions = previousState.sessions.filter(({ id }) => id !== session.id);
    const nextState = { ...previousState, sessions: pruneSessions([...sessions, session]) };
    this.state = nextState;
    try {
      await this.persist();
    } catch (error) {
      if (this.state === nextState) {
        this.state = previousState;
      }
      throw error;
    }
    await this.removeDiscardedSessionFiles(
      [...previousState.sessions, session],
      nextState.sessions,
    );
    return structuredClone(session);
  }

  async pinSession(id: string, pinned: boolean): Promise<SessionMetadata> {
    assertId(id);
    const existing = this.state.sessions.find((session) => session.id === id);
    if (existing === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Session not found',
        recoverable: true,
        details: { id },
      });
    }
    const updated = { ...existing, pinned };
    this.state = {
      ...this.state,
      sessions: this.state.sessions.map((session) => (session.id === id ? updated : session)),
    };
    await this.persist();
    return structuredClone(updated);
  }

  async removeSession(id: string): Promise<void> {
    assertId(id);
    const previousState = this.state;
    const nextState = {
      ...previousState,
      sessions: previousState.sessions.filter((session) => session.id !== id),
    };
    this.state = nextState;
    try {
      await this.persist();
    } catch (error) {
      if (this.state === nextState) {
        this.state = previousState;
      }
      throw error;
    }
    await this.removeDiscardedSessionFiles(previousState.sessions, nextState.sessions);
  }

  async prune(now = Date.now()): Promise<void> {
    const previousState = this.state;
    const sessions = pruneSessions(previousState.sessions, now);
    if (sessions.length !== previousState.sessions.length) {
      const nextState = { ...previousState, sessions };
      this.state = nextState;
      try {
        await this.persist();
      } catch (error) {
        if (this.state === nextState) {
          this.state = previousState;
        }
        throw error;
      }
      await this.removeDiscardedSessionFiles(previousState.sessions, sessions);
    }
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.statePath), { recursive: true });
        const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
          await rename(temporaryPath, this.statePath);
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          throw new AppError(
            {
              code: 'STORAGE_FAILED',
              message: 'Unable to save application data',
              recoverable: true,
            },
            { cause: error },
          );
        }
      });
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async removeDiscardedSessionFiles(
    previous: readonly SessionMetadata[],
    retained: readonly SessionMetadata[],
  ): Promise<void> {
    const retainedIds = new Set(retained.map((session) => session.id));
    const discarded = previous.filter((session) => !retainedIds.has(session.id));
    await Promise.all(
      discarded.map(async (session) => {
        const suffix =
          session.kind === 'job' ? 'job.jsonl' : session.kind === 'tuning' ? 'tuning.jsonl' : null;
        if (suffix === null) {
          return;
        }
        const artifactPath = path.join(this.sessionsDirectory, `${session.id}.${suffix}`);
        if (path.dirname(artifactPath) !== this.sessionsDirectory) {
          this.logger.warn('Refusing to remove a session artifact outside the sessions directory', {
            sessionId: session.id,
          });
          return;
        }
        await rm(artifactPath, { force: true }).catch((error: unknown) => {
          this.logger.warn('Unable to remove a discarded session artifact', {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }),
    );
  }
}

export function pruneSessions(
  sessions: readonly SessionMetadata[],
  now = Date.now(),
): readonly SessionMetadata[] {
  const pinned = sessions.filter((session) => session.pinned);
  const retained = sessions
    .filter((session) => !session.pinned)
    .filter((session) => {
      const endedAt = Date.parse(session.endedAt);
      return Number.isFinite(endedAt) && now - endedAt <= MAX_UNPINNED_AGE_MS;
    })
    .sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt))
    .slice(0, MAX_UNPINNED_SESSIONS);
  return [...pinned, ...retained].sort(
    (left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt),
  );
}

function validatePersistedState(value: unknown): PersistedState {
  if (!isRecord(value) || value['version'] !== 2) {
    throw invalid('Unsupported application state');
  }
  const profiles = value['profiles'];
  const sessions = value['sessions'];
  if (!Array.isArray(profiles) || !Array.isArray(sessions)) {
    throw invalid('Application state collections are invalid');
  }
  return {
    version: 2,
    settings: validateSettings(value['settings']),
    profiles: profiles.map(validateProfile),
    sessions: sessions.map(validateSession),
  };
}

function hasApprovedCatalogHosts(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'approvedCatalogHosts');
}

function validateSettings(value: unknown): AppSettings {
  if (!isRecord(value)) {
    throw invalid('Settings must be an object');
  }
  const theme = value['theme'];
  const lastSerialPort = value['lastSerialPort'];
  const startupMacro = value['startupMacro'];
  const commandTimeoutMs = value['commandTimeoutMs'];
  const approvedCatalogHosts = value['approvedCatalogHosts'];
  const firmwareInoPath = value['firmwareInoPath'] ?? null;
  if (!isTheme(theme) || !(lastSerialPort === null || isBoundedString(lastSerialPort, 1, 1_024))) {
    throw invalid('Settings contain an invalid theme or port');
  }
  if (!isBoundedString(startupMacro, 0, 100_000)) {
    throw invalid('Startup macro is invalid');
  }
  if (
    !Number.isInteger(commandTimeoutMs) ||
    (commandTimeoutMs as number) < 250 ||
    (commandTimeoutMs as number) > 600_000
  ) {
    throw invalid('Command timeout must be between 250 ms and 10 minutes');
  }
  if (
    !Array.isArray(approvedCatalogHosts) ||
    !approvedCatalogHosts.every((host) => isBoundedString(host, 1, 253))
  ) {
    throw invalid('Approved catalog hosts are invalid');
  }
  if (!(firmwareInoPath === null || isBoundedString(firmwareInoPath, 1, 32_767))) {
    throw invalid('Firmware sketch path is invalid');
  }
  return {
    version: 2,
    theme,
    lastSerialPort,
    startupMacro,
    commandTimeoutMs: commandTimeoutMs as number,
    approvedCatalogHosts: [...new Set(approvedCatalogHosts as string[])],
    firmwareInoPath,
  };
}

function validateProfile(value: unknown): StoredProfile {
  if (!isRecord(value)) {
    throw invalid('Profile must be an object');
  }
  assertId(value['id']);
  if (!Number.isInteger(value['version']) || (value['version'] as number) < 1) {
    throw invalid('Profile version must be a positive integer');
  }
  if (!['pid-schedule', 'simulation', 'machine'].includes(String(value['kind']))) {
    throw invalid('Profile kind is invalid');
  }
  if (!['draft', 'validated', 'applied'].includes(String(value['state']))) {
    throw invalid('Profile state is invalid');
  }
  if (
    !isBoundedString(value['name'], 1, 200) ||
    !isIsoDate(value['createdAt']) ||
    !isIsoDate(value['updatedAt'])
  ) {
    throw invalid('Profile metadata is invalid');
  }
  ensureJsonValue(value['data']);
  return structuredClone(value) as unknown as StoredProfile;
}

function validateSession(value: unknown): SessionMetadata {
  if (!isRecord(value)) {
    throw invalid('Session must be an object');
  }
  assertId(value['id']);
  if (!Number.isInteger(value['version']) || (value['version'] as number) < 1) {
    throw invalid('Session version must be a positive integer');
  }
  if (!['job', 'terminal', 'simulation', 'tuning'].includes(String(value['kind']))) {
    throw invalid('Session kind is invalid');
  }
  if (
    !isBoundedString(value['title'], 1, 500) ||
    !isIsoDate(value['startedAt']) ||
    !isIsoDate(value['endedAt'])
  ) {
    throw invalid('Session metadata is invalid');
  }
  if (typeof value['pinned'] !== 'boolean') {
    throw invalid('Session pinned flag is invalid');
  }
  ensureJsonValue(value['data']);
  return structuredClone(value) as unknown as SessionMetadata;
}

function ensureJsonValue(value: unknown, depth = 0): void {
  if (depth > 30) {
    throw invalid('Stored JSON is nested too deeply');
  }
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw invalid('Stored JSON contains a non-finite number');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => ensureJsonValue(item, depth + 1));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw invalid('Stored JSON contains a forbidden property');
      }
      ensureJsonValue(item, depth + 1);
    });
    return;
  }
  throw invalid('Stored data is not JSON serializable');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTheme(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system';
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertId(value: unknown): asserts value is string {
  if (!isBoundedString(value, 1, 200) || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw invalid('Identifier is invalid');
  }
}

function invalid(message: string): AppError {
  return new AppError({ code: 'INVALID_ARGUMENT', message, recoverable: true });
}
