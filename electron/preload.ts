import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { GcodeApi, Unsubscribe } from '../shared/contracts';
import type { ApiResult } from '../shared/errors';
import type { LiveTuningRequest, LiveTuningState } from '../shared/tuning-contracts';
import type { JobLogPage } from './services/job-service';

// Keep this preload self-contained: sandboxed preloads cannot require arbitrary
// local modules. These values intentionally mirror shared/ipc.ts.
const CHANNEL = {
  systemInfo: 'system:info',
  systemOpenExternal: 'system:open-external',
  serialList: 'serial:list',
  serialState: 'serial:state:get',
  serialConnect: 'serial:connect',
  serialDisconnect: 'serial:disconnect',
  serialReconnect: 'serial:reconnect',
  serialSend: 'serial:send',
  serialHeaterOff: 'serial:heater-off',
  jobsPick: 'jobs:pick',
  jobsInspect: 'jobs:inspect',
  jobsSaveHeatingProfile: 'jobs:save-heating-profile',
  jobsState: 'jobs:state:get',
  jobsLog: 'jobs:log:get',
  jobsStart: 'jobs:start',
  jobsPause: 'jobs:pause',
  jobsResume: 'jobs:resume',
  jobsStop: 'jobs:stop',
  jobsResolveTimeout: 'jobs:resolve-timeout',
  tuningState: 'tuning:state:get',
  tuningStart: 'tuning:start',
  tuningCancel: 'tuning:cancel',
  catalogGet: 'catalog:get',
  catalogRefresh: 'catalog:refresh',
  catalogApprove: 'catalog:approve',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  profilesList: 'profiles:list',
  profilesSave: 'profiles:save',
  profilesRemove: 'profiles:remove',
  profilesImport: 'profiles:import',
  profilesExport: 'profiles:export',
  sessionsList: 'sessions:list',
  sessionsSave: 'sessions:save',
  sessionsPin: 'sessions:pin',
  sessionsRemove: 'sessions:remove',
  sessionsExport: 'sessions:export',
  activityGet: 'activity:get',
  activityBegin: 'activity:begin',
  activityEnd: 'activity:end',
  eventSerialState: 'event:serial-state',
  eventSerialLine: 'event:serial-line',
  eventTelemetry: 'event:telemetry',
  eventFirmware: 'event:firmware',
  eventFirmwareError: 'event:firmware-error',
  eventJobState: 'event:job-state',
  eventJobTimeout: 'event:job-timeout',
  eventTuningState: 'event:tuning-state',
  eventCatalogApproval: 'event:catalog-approval',
  eventCatalogSnapshot: 'event:catalog-snapshot',
  eventActivity: 'event:activity',
} as const;

type ExtendedGcodeApi = GcodeApi & {
  readonly jobs: GcodeApi['jobs'] & {
    getLog(offset?: number, limit?: number): Promise<ApiResult<JobLogPage>>;
  };
  readonly tuning: {
    getState(): Promise<ApiResult<LiveTuningState>>;
    start(request: LiveTuningRequest): Promise<ApiResult<LiveTuningState>>;
    cancel(): Promise<ApiResult<LiveTuningState>>;
  };
  readonly events: GcodeApi['events'] & {
    onTuningState(listener: (state: LiveTuningState) => void): Unsubscribe;
  };
};

const invoke = <T>(channel: string, ...args: readonly unknown[]): Promise<ApiResult<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<ApiResult<T>>;

const on = <T>(channel: string, listener: (payload: T) => void): Unsubscribe => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

const api: ExtendedGcodeApi = {
  system: {
    getInfo: () => invoke(CHANNEL.systemInfo),
    openExternal: (url) => invoke(CHANNEL.systemOpenExternal, url),
  },
  serial: {
    listPorts: () => invoke(CHANNEL.serialList),
    getState: () => invoke(CHANNEL.serialState),
    connect: (request) => invoke(CHANNEL.serialConnect, request),
    disconnect: () => invoke(CHANNEL.serialDisconnect),
    reconnect: () => invoke(CHANNEL.serialReconnect),
    send: (request) => invoke(CHANNEL.serialSend, request),
    heaterOff: () => invoke(CHANNEL.serialHeaterOff),
  },
  jobs: {
    pickFile: () => invoke(CHANNEL.jobsPick),
    resolveDroppedFile: (file) => webUtils.getPathForFile(file),
    inspectFile: (filePath) => invoke(CHANNEL.jobsInspect, filePath),
    saveHeatingProfile: (profile) => invoke(CHANNEL.jobsSaveHeatingProfile, profile),
    getState: () => invoke(CHANNEL.jobsState),
    getLog: (offset, limit) => invoke(CHANNEL.jobsLog, offset, limit),
    start: (request) => invoke(CHANNEL.jobsStart, request),
    pauseAfterCurrent: () => invoke(CHANNEL.jobsPause),
    resume: () => invoke(CHANNEL.jobsResume),
    stop: () => invoke(CHANNEL.jobsStop),
    resolveTimeout: (decisionId, decision) =>
      invoke(CHANNEL.jobsResolveTimeout, decisionId, decision),
  },
  tuning: {
    getState: () => invoke(CHANNEL.tuningState),
    start: (request) => invoke(CHANNEL.tuningStart, request),
    cancel: () => invoke(CHANNEL.tuningCancel),
  },
  catalog: {
    get: () => invoke(CHANNEL.catalogGet),
    refresh: () => invoke(CHANNEL.catalogRefresh),
    approve: (requestId, approved) => invoke(CHANNEL.catalogApprove, requestId, approved),
  },
  settings: {
    get: () => invoke(CHANNEL.settingsGet),
    update: (patch) => invoke(CHANNEL.settingsUpdate, patch),
  },
  profiles: {
    list: () => invoke(CHANNEL.profilesList),
    save: (profile) => invoke(CHANNEL.profilesSave, profile),
    remove: (id) => invoke(CHANNEL.profilesRemove, id),
    importFile: () => invoke(CHANNEL.profilesImport),
    exportFile: (ids) => invoke(CHANNEL.profilesExport, ids),
  },
  sessions: {
    list: () => invoke(CHANNEL.sessionsList),
    save: (session) => invoke(CHANNEL.sessionsSave, session),
    pin: (id, pinned) => invoke(CHANNEL.sessionsPin, id, pinned),
    remove: (id) => invoke(CHANNEL.sessionsRemove, id),
    exportFile: (ids, format) => invoke(CHANNEL.sessionsExport, ids, format),
  },
  activity: {
    get: () => invoke(CHANNEL.activityGet),
    begin: (activity) => invoke(CHANNEL.activityBegin, activity),
    end: (activity) => invoke(CHANNEL.activityEnd, activity),
  },
  events: {
    onSerialState: (listener) => on(CHANNEL.eventSerialState, listener),
    onSerialLine: (listener) => on(CHANNEL.eventSerialLine, listener),
    onTelemetry: (listener) => on(CHANNEL.eventTelemetry, listener),
    onFirmware: (listener) => on(CHANNEL.eventFirmware, listener),
    onFirmwareError: (listener) => on(CHANNEL.eventFirmwareError, listener),
    onJobState: (listener) => on(CHANNEL.eventJobState, listener),
    onJobTimeout: (listener) => on(CHANNEL.eventJobTimeout, listener),
    onTuningState: (listener) => on(CHANNEL.eventTuningState, listener),
    onCatalogApproval: (listener) => on(CHANNEL.eventCatalogApproval, listener),
    onCatalogSnapshot: (listener) => on(CHANNEL.eventCatalogSnapshot, listener),
    onActivity: (listener) => on(CHANNEL.eventActivity, listener),
  },
};

contextBridge.exposeInMainWorld('gcode', Object.freeze(api));
