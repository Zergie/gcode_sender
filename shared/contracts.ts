import type { ApiResult, AppErrorInfo } from './errors';
import type { LiveTuningRequest, LiveTuningState } from './tuning-contracts';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type ThemePreference = 'dark' | 'light' | 'system';
export type ControlMode = 'pid' | 'model-assisted';

export interface AppSettings {
  readonly version: 2;
  readonly theme: ThemePreference;
  readonly lastSerialPort: string | null;
  readonly startupMacro: string;
  readonly commandTimeoutMs: number;
  readonly approvedCatalogHosts: readonly string[];
}

export type SettingsPatch = Partial<Omit<AppSettings, 'version'>>;

export interface SerialPortDescriptor {
  readonly path: string;
  readonly manufacturer?: string;
  readonly serialNumber?: string;
  readonly productId?: string;
  readonly vendorId?: string;
  readonly friendlyName?: string;
}

export type SerialStatus =
  'disconnected' | 'connecting' | 'handshaking' | 'connected' | 'disconnecting' | 'error';

export interface FirmwareInfo {
  readonly raw: string;
  readonly firmwareName: string;
  readonly sourceCodeUrl?: string;
  readonly gcodeCatalogUrl?: string;
  readonly protocolVersion?: string;
  readonly machineType?: string;
  readonly uuid?: string;
}

export interface SerialConnectionState {
  readonly status: SerialStatus;
  readonly portPath: string | null;
  readonly baudRate: 115200;
  readonly firmware: FirmwareInfo | null;
  readonly connectedAt: string | null;
  readonly error: AppErrorInfo | null;
}

export interface SerialConnectRequest {
  readonly path: string;
  /** Empty or whitespace-only macros are intentionally skipped. */
  readonly startupMacro?: string;
  readonly handshakeTimeoutMs?: number;
}

export type SerialSendOrigin = 'terminal' | 'control' | 'tuning';

export interface SerialSendRequest {
  readonly command: string;
  readonly origin: SerialSendOrigin;
}

export interface SerialLineEvent {
  readonly direction: 'rx' | 'tx';
  readonly line: string;
  readonly timestamp: string;
  readonly origin?: SerialSendOrigin | 'job' | 'system';
}

export interface TemperatureTelemetry {
  readonly timestamp: string;
  readonly average: number;
  readonly target: number;
  readonly power: number;
  readonly thermistors: readonly [number, number, number];
  readonly raw: string;
}

export interface FirmwareErrorEvent {
  readonly timestamp: string;
  readonly message: string;
  readonly raw: string;
}

export type ExclusiveActivity = 'job' | 'tuning' | 'validation';

export interface ExclusiveActivityState {
  readonly active: ExclusiveActivity | null;
}

export interface JobFileInfo {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly extension: '.gcode' | '.gco' | '.gc' | '.txt';
}

export interface HeatingProfilePoint {
  readonly timeMs: number;
  readonly targetC: number;
}

export interface HeatingProfile {
  readonly version: 1;
  readonly name: string;
  readonly interpolation: 'linear';
  readonly points: readonly HeatingProfilePoint[];
}

export interface LoadedGcodeProgram {
  readonly file: JobFileInfo;
  readonly kind: 'heating-profile' | 'gcode';
  readonly profile: HeatingProfile | null;
  readonly metadataWarning: string | null;
}

export interface JobStartRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly commandTimeoutMs?: number;
}

export type JobStatus =
  | 'idle'
  | 'preparing'
  | 'streaming'
  | 'pause-pending'
  | 'paused'
  | 'awaiting-decision'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed';

export interface JobProgress {
  readonly sourceLine: number;
  readonly completedCommands: number;
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly percent: number;
  readonly elapsedMs: number;
  readonly etaMs: number | null;
}

export interface JobExecutionLogEntry {
  readonly timestamp: string;
  readonly sourceLine: number;
  readonly command: string;
  readonly outcome: 'sent' | 'completed' | 'timeout' | 'continued' | 'retried' | 'error';
  readonly response?: string;
}

export interface JobLogPage {
  readonly entries: readonly JobExecutionLogEntry[];
  readonly offset: number;
  readonly nextOffset: number | null;
}

export interface JobState {
  readonly id: string | null;
  readonly status: JobStatus;
  readonly file: JobFileInfo | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly progress: JobProgress | null;
  readonly lastCompletedSourceLine: number | null;
  readonly pauseRequested: boolean;
  readonly error: AppErrorInfo | null;
}

export interface JobTimeoutEvent {
  readonly decisionId: string;
  readonly jobId: string;
  readonly sourceLine: number;
  readonly command: string;
  readonly timeoutMs: number;
  readonly timestamp: string;
}

export type JobTimeoutDecision = 'retry' | 'continue' | 'stop';

export interface CommandParameter {
  readonly name: string;
  readonly description: string;
}

export interface CommandCatalogEntry {
  readonly code: string;
  readonly description: string;
  readonly parameters?: readonly CommandParameter[];
}

export interface CommandCatalogSnapshot {
  readonly entries: readonly CommandCatalogEntry[];
  readonly source: 'remote' | 'cache' | 'bundled';
  readonly url: string | null;
  readonly firmwareId: string | null;
  readonly fetchedAt: string | null;
  readonly stale: boolean;
}

export interface CatalogApprovalRequest {
  readonly id: string;
  readonly host: string;
  readonly url: string;
  readonly firmwareId: string | null;
}

export type ProfileState = 'draft' | 'validated' | 'applied';
export type ProfileKind = 'pid-schedule' | 'simulation' | 'machine';

export interface StoredProfile {
  readonly id: string;
  readonly version: number;
  readonly kind: ProfileKind;
  readonly name: string;
  readonly state: ProfileState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly data: JsonValue;
}

export type SessionKind = 'job' | 'terminal' | 'simulation' | 'tuning';

export interface SessionMetadata {
  readonly id: string;
  readonly version: number;
  readonly kind: SessionKind;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly pinned: boolean;
  readonly data: JsonValue;
}

export interface SystemInfo {
  readonly platform: 'win32' | 'darwin' | 'linux' | string;
  readonly arch: string;
  readonly versions: Readonly<Record<string, string>>;
}

export type Unsubscribe = () => void;

export interface GcodeApi {
  readonly system: {
    getInfo(): Promise<ApiResult<SystemInfo>>;
    openExternal(url: string): Promise<ApiResult<void>>;
  };
  readonly serial: {
    listPorts(): Promise<ApiResult<readonly SerialPortDescriptor[]>>;
    getState(): Promise<ApiResult<SerialConnectionState>>;
    connect(request: SerialConnectRequest): Promise<ApiResult<SerialConnectionState>>;
    disconnect(): Promise<ApiResult<SerialConnectionState>>;
    reconnect(): Promise<ApiResult<SerialConnectionState>>;
    send(request: SerialSendRequest): Promise<ApiResult<void>>;
    heaterOff(): Promise<ApiResult<void>>;
  };
  readonly jobs: {
    pickFile(): Promise<ApiResult<LoadedGcodeProgram | null>>;
    resolveDroppedFile(file: File): string;
    inspectFile(path: string): Promise<ApiResult<LoadedGcodeProgram>>;
    saveHeatingProfile(profile: HeatingProfile): Promise<ApiResult<LoadedGcodeProgram | null>>;
    getState(): Promise<ApiResult<JobState>>;
    getLog(offset?: number, limit?: number): Promise<ApiResult<JobLogPage>>;
    start(request: JobStartRequest): Promise<ApiResult<JobState>>;
    pauseAfterCurrent(): Promise<ApiResult<JobState>>;
    resume(): Promise<ApiResult<JobState>>;
    stop(): Promise<ApiResult<JobState>>;
    resolveTimeout(decisionId: string, decision: JobTimeoutDecision): Promise<ApiResult<JobState>>;
  };
  readonly tuning: {
    getState(): Promise<ApiResult<LiveTuningState>>;
    start(request: LiveTuningRequest): Promise<ApiResult<LiveTuningState>>;
    cancel(): Promise<ApiResult<LiveTuningState>>;
  };
  readonly catalog: {
    get(): Promise<ApiResult<CommandCatalogSnapshot>>;
    refresh(): Promise<ApiResult<CommandCatalogSnapshot>>;
    approve(requestId: string, approved: boolean): Promise<ApiResult<CommandCatalogSnapshot>>;
  };
  readonly settings: {
    get(): Promise<ApiResult<AppSettings>>;
    update(patch: SettingsPatch): Promise<ApiResult<AppSettings>>;
  };
  readonly profiles: {
    list(): Promise<ApiResult<readonly StoredProfile[]>>;
    save(profile: StoredProfile): Promise<ApiResult<StoredProfile>>;
    remove(id: string): Promise<ApiResult<void>>;
    importFile(): Promise<ApiResult<readonly StoredProfile[] | null>>;
    exportFile(ids: readonly string[]): Promise<ApiResult<string | null>>;
  };
  readonly sessions: {
    list(): Promise<ApiResult<readonly SessionMetadata[]>>;
    save(session: SessionMetadata): Promise<ApiResult<SessionMetadata>>;
    pin(id: string, pinned: boolean): Promise<ApiResult<SessionMetadata>>;
    remove(id: string): Promise<ApiResult<void>>;
    exportFile(ids: readonly string[], format: 'json' | 'csv'): Promise<ApiResult<string | null>>;
  };
  readonly activity: {
    get(): Promise<ApiResult<ExclusiveActivityState>>;
    begin(activity: Exclude<ExclusiveActivity, 'job'>): Promise<ApiResult<ExclusiveActivityState>>;
    end(activity: Exclude<ExclusiveActivity, 'job'>): Promise<ApiResult<ExclusiveActivityState>>;
  };
  readonly events: {
    onSerialState(listener: (state: SerialConnectionState) => void): Unsubscribe;
    onSerialLine(listener: (event: SerialLineEvent) => void): Unsubscribe;
    onTelemetry(listener: (event: TemperatureTelemetry) => void): Unsubscribe;
    onFirmware(listener: (event: FirmwareInfo) => void): Unsubscribe;
    onFirmwareError(listener: (event: FirmwareErrorEvent) => void): Unsubscribe;
    onJobState(listener: (state: JobState) => void): Unsubscribe;
    onJobTimeout(listener: (event: JobTimeoutEvent) => void): Unsubscribe;
    onTuningState(listener: (state: LiveTuningState) => void): Unsubscribe;
    onCatalogApproval(listener: (event: CatalogApprovalRequest) => void): Unsubscribe;
    onCatalogSnapshot(listener: (snapshot: CommandCatalogSnapshot) => void): Unsubscribe;
    onActivity(listener: (state: ExclusiveActivityState) => void): Unsubscribe;
  };
}

declare global {
  interface Window {
    readonly gcode: GcodeApi;
  }
}

export {};
