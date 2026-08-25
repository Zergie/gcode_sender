import { readFile, writeFile } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { dialog, ipcMain, shell } from 'electron';

import type {
  JobStartRequest,
  JobTimeoutDecision,
  HeatingProfile,
  SerialConnectRequest,
  SerialSendRequest,
  SessionMetadata,
  SettingsPatch,
  StoredProfile,
} from '../shared/contracts';
import type { LiveTuningRequest } from '../shared/tuning-contracts';
import { validateHeatingProfile } from '../shared/heating-profile-document';
import { failure, success, type ApiResult } from '../shared/errors';
import { IPC, type IpcChannel } from '../shared/ipc';
import type { Logger } from './logger';
import { heatingProfileDefaultFileName, writeHeatingProfileFile } from './heating-profile-file';
import type { ActivityService } from './services/activity-service';
import type { CatalogService } from './services/catalog-service';
import type { JobService } from './services/job-service';
import type { LiveTuningService } from './services/live-tuning-service';
import type { PersistenceStore } from './services/persistence-store';
import type { SerialService } from './services/serial-service';
import type { FirmwareBuildService } from './firmware';
import {
  assembleSessionExports,
  sessionsToCsvWithArtifacts,
} from './services/session-artifact-exporter';

interface IpcDependencies {
  readonly getRenderer: () => WebContents | null;
  readonly serial: SerialService;
  readonly jobs: JobService;
  readonly tuning: LiveTuningService;
  readonly catalog: CatalogService;
  readonly store: PersistenceStore;
  readonly activity: ActivityService;
  readonly logger: Logger;
  readonly firmware: FirmwareBuildService;
}

export function registerIpcHandlers(dependencies: IpcDependencies): () => void {
  const channels: IpcChannel[] = [];
  const handle = <TArgs extends readonly unknown[], TResult>(
    channel: IpcChannel,
    action: (...args: TArgs) => Promise<TResult> | TResult,
  ): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<ApiResult<TResult>> => {
      if (event.sender !== dependencies.getRenderer()) {
        return failure(
          new Error('IPC sender is not the application renderer'),
          'PERMISSION_DENIED',
        );
      }
      try {
        return success(await action(...(args as unknown as TArgs)));
      } catch (error) {
        dependencies.logger.warn('IPC request failed', {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
        return failure(error, 'IPC_FAILED');
      }
    });
    channels.push(channel);
  };

  handle(IPC.systemInfo, () => ({
    platform: process.platform,
    arch: process.arch,
    versions: { ...process.versions } as Record<string, string>,
  }));
  handle(IPC.systemOpenExternal, async (urlText: string) => {
    const url = requireSafeExternalUrl(urlText);
    await shell.openExternal(url.href, { activate: true });
  });

  handle(IPC.firmwareToolchainStatus, () => dependencies.firmware.getToolchainStatus());
  handle(IPC.firmwarePickAndBuild, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose Arduino firmware sketch',
      properties: ['openFile'],
      filters: [{ name: 'Arduino sketches', extensions: ['ino'] }],
    });
    return result.canceled || result.filePaths.length === 0
      ? null
      : dependencies.firmware.build(result.filePaths[0]!);
  });

  handle(IPC.serialList, () => dependencies.serial.listPorts());
  handle(IPC.serialState, () => dependencies.serial.getState());
  handle(IPC.serialConnect, async (request: SerialConnectRequest) => {
    const settings = dependencies.store.getSettings();
    const state = await dependencies.serial.connect({
      ...request,
      startupMacro: request.startupMacro ?? settings.startupMacro,
    });
    await dependencies.store.updateSettings({ lastSerialPort: request.path });
    return state;
  });
  handle(IPC.serialDisconnect, () => dependencies.serial.disconnect());
  handle(IPC.serialReconnect, () => dependencies.serial.reconnect());
  handle(IPC.serialSend, async (request: SerialSendRequest) => {
    if (typeof request !== 'object' || request === null) {
      throw new TypeError('Serial send request is invalid');
    }
    await dependencies.serial.send(request.command, request.origin);
  });
  handle(IPC.serialHeaterOff, () => dependencies.serial.requestHeaterOff());

  handle(IPC.jobsPick, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open G-code file',
      properties: ['openFile'],
      filters: [{ name: 'G-code files', extensions: ['gcode', 'gco', 'gc', 'txt'] }],
    });
    return result.canceled || result.filePaths.length === 0
      ? null
      : dependencies.jobs.inspectFile(result.filePaths[0]!);
  });
  handle(IPC.jobsInspect, (filePath: string) => dependencies.jobs.inspectFile(filePath));
  handle(IPC.jobsSaveHeatingProfile, async (candidate: HeatingProfile) => {
    const profile = validateHeatingProfile(candidate);
    const result = await dialog.showSaveDialog({
      title: 'Save heating profile',
      defaultPath: heatingProfileDefaultFileName(profile.name),
      filters: [{ name: 'G-code profile', extensions: ['gcode'] }],
    });
    if (result.canceled || result.filePath === undefined) return null;
    const filePath = await writeHeatingProfileFile(result.filePath, profile);
    return dependencies.jobs.inspectFile(filePath);
  });
  handle(IPC.jobsState, () => dependencies.jobs.getState());
  handle(IPC.jobsLog, (offset?: number, limit?: number) => dependencies.jobs.getLog(offset, limit));
  handle(IPC.jobsStart, (request: JobStartRequest) => dependencies.jobs.start(request));
  handle(IPC.jobsPause, () => dependencies.jobs.pauseAfterCurrent());
  handle(IPC.jobsResume, () => dependencies.jobs.resume());
  handle(IPC.jobsStop, () => dependencies.jobs.stop());
  handle(IPC.jobsResolveTimeout, (decisionId: string, decision: JobTimeoutDecision) =>
    dependencies.jobs.resolveTimeout(decisionId, decision),
  );

  handle(IPC.tuningState, () => dependencies.tuning.getState());
  handle(IPC.tuningStart, (request: LiveTuningRequest) => dependencies.tuning.start(request));
  handle(IPC.tuningCancel, () => dependencies.tuning.cancel());

  handle(IPC.catalogGet, () => dependencies.catalog.get());
  handle(IPC.catalogRefresh, () => dependencies.catalog.refresh());
  handle(IPC.catalogApprovedHosts, () => dependencies.catalog.approvedHosts());
  handle(IPC.catalogRevokeHost, (host: string) => dependencies.catalog.revokeHost(host));

  handle(IPC.settingsGet, () => dependencies.store.getSettings());
  handle(IPC.settingsUpdate, (patch: SettingsPatch) => dependencies.store.updateSettings(patch));

  handle(IPC.profilesList, () => dependencies.store.listProfiles());
  handle(IPC.profilesSave, (profile: StoredProfile) => dependencies.store.saveProfile(profile));
  handle(IPC.profilesRemove, (id: string) => dependencies.store.removeProfile(id));
  handle(IPC.profilesImport, () => importProfiles(dependencies.store));
  handle(IPC.profilesExport, (ids: readonly string[]) => exportProfiles(dependencies.store, ids));

  handle(IPC.sessionsList, () => dependencies.store.listSessions());
  handle(IPC.sessionsSave, (session: SessionMetadata) => dependencies.store.saveSession(session));
  handle(IPC.sessionsPin, (id: string, pinned: boolean) =>
    dependencies.store.pinSession(id, pinned),
  );
  handle(IPC.sessionsRemove, (id: string) => dependencies.store.removeSession(id));
  handle(IPC.sessionsExport, (ids: readonly string[], format: 'json' | 'csv') =>
    exportSessions(dependencies.store, ids, format),
  );

  handle(IPC.activityGet, () => dependencies.activity.getState());
  handle(IPC.activityBegin, (activity: 'tuning' | 'validation') =>
    dependencies.activity.acquire(activity),
  );
  handle(IPC.activityEnd, (activity: 'tuning' | 'validation') =>
    dependencies.activity.release(activity),
  );

  return () => channels.forEach((channel) => ipcMain.removeHandler(channel));
}

async function importProfiles(store: PersistenceStore): Promise<readonly StoredProfile[] | null> {
  const result = await dialog.showOpenDialog({
    title: 'Import profiles',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const contents = await readBoundedFile(result.filePaths[0]!, 10 * 1024 * 1024);
  return store.importProfiles(JSON.parse(contents) as unknown);
}

async function exportProfiles(
  store: PersistenceStore,
  ids: readonly string[],
): Promise<string | null> {
  const selected = selectByIds(store.listProfiles(), ids);
  const result = await dialog.showSaveDialog({
    title: 'Export profiles',
    defaultPath: 'gcode-sender-profiles.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || result.filePath === undefined) {
    return null;
  }
  await writeFile(result.filePath, `${JSON.stringify(selected, null, 2)}\n`, 'utf8');
  return result.filePath;
}

async function exportSessions(
  store: PersistenceStore,
  ids: readonly string[],
  format: 'json' | 'csv',
): Promise<string | null> {
  if (format !== 'json' && format !== 'csv') {
    throw new TypeError('Unknown session export format');
  }
  const selected = await assembleSessionExports(selectByIds(store.listSessions(), ids));
  const result = await dialog.showSaveDialog({
    title: 'Export sessions',
    defaultPath: `gcode-sender-sessions.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (result.canceled || result.filePath === undefined) {
    return null;
  }
  const contents =
    format === 'json'
      ? `${JSON.stringify(selected, null, 2)}\n`
      : sessionsToCsvWithArtifacts(selected);
  await writeFile(result.filePath, contents, 'utf8');
  return result.filePath;
}

function selectByIds<T extends { readonly id: string }>(
  items: readonly T[],
  ids: readonly string[],
): readonly T[] {
  if (!Array.isArray(ids) || ids.length > 10_000 || !ids.every((id) => typeof id === 'string')) {
    throw new TypeError('Export identifiers are invalid');
  }
  const selectedIds = new Set(ids);
  return items.filter((item) => selectedIds.has(item.id));
}

async function readBoundedFile(filePath: string, maximumBytes: number): Promise<string> {
  const contents = await readFile(filePath);
  if (contents.byteLength > maximumBytes) {
    throw new TypeError('Import file is too large');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(contents);
}

function requireSafeExternalUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 8_192) {
    throw new TypeError('External URL is invalid');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('Only HTTPS links can be opened');
  }
  return url;
}
