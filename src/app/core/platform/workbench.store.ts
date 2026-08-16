import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import type {
  AppSettings,
  CatalogApprovalRequest,
  CommandCatalogSnapshot,
  ControlMode,
  ExclusiveActivityState,
  GcodeApi,
  JobFileInfo,
  JobState,
  JobTimeoutDecision,
  JobTimeoutEvent,
  SerialConnectionState,
  SerialLineEvent,
  SerialPortDescriptor,
  SessionKind,
  SessionMetadata,
  SettingsPatch,
  TemperatureTelemetry,
  ThemePreference,
  SystemInfo,
  JsonValue,
  ProfileKind,
  ProfileState,
  StoredProfile,
} from '../../../../shared/contracts';
import type { LiveTuningState } from '../../../../shared/tuning-contracts';
import { BUNDLED_COMMAND_CATALOG } from '../../../../shared/bundled-catalog';
import {
  advancePidGainTransition,
  createPidSchedule,
  createTargetShaperState,
  interpolatePidGains,
  stepTargetShaper,
  validateTargetShaperConfiguration,
  type ModelAssistedTargetConfiguration,
  type PidGains,
  type PidSchedule,
  type TargetShaperState,
} from '../control';
import {
  DEFAULT_OVEN_PROFILE,
  STANDARD_LOAD_PID_SCHEDULE,
  cloneOvenModelProfile,
  validateOvenModelProfile,
  type OvenModelProfile,
} from '../simulation';
import { calculateValidationMetrics, type M105Telemetry, type ValidationMetrics } from '../tuning';

export type DemoState =
  'disconnected' | 'monitoring' | 'streaming' | 'simulation' | 'tuning' | 'error';

export interface TrendPoint {
  readonly time: number;
  readonly average: number;
  readonly t1: number;
  readonly t2: number;
  readonly t3: number;
  readonly target: number;
  readonly modelTarget: number;
  readonly power: number;
}

export interface TerminalEntry extends SerialLineEvent {
  readonly id: number;
}

export interface ValidationRunState {
  readonly status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
  readonly targetC: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly sampleCount: number;
  readonly maximumDurationMs: number;
  readonly metrics: ValidationMetrics | null;
  readonly error: string | null;
}

const DEFAULT_CONNECTION: SerialConnectionState = {
  status: 'disconnected',
  portPath: null,
  baudRate: 115200,
  firmware: null,
  connectedAt: null,
  error: null,
};

const DEFAULT_JOB: JobState = {
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

const DEFAULT_SETTINGS: AppSettings = {
  version: 2,
  theme: 'dark',
  lastSerialPort: null,
  startupMacro: '',
  commandTimeoutMs: 8_000,
  approvedCatalogHosts: [],
};

const DEFAULT_TUNING: LiveTuningState = {
  id: null,
  status: 'idle',
  startedAt: null,
  endedAt: null,
  currentTarget: null,
  currentBreakpointIndex: 0,
  peaksCollected: 0,
  peakGoal: 12,
  rollbackGains: null,
  results: [],
  error: null,
};

const DEFAULT_VALIDATION: ValidationRunState = {
  status: 'idle',
  targetC: null,
  startedAt: null,
  endedAt: null,
  sampleCount: 0,
  maximumDurationMs: 20 * 60_000,
  metrics: null,
  error: null,
};

const DEFAULT_PID_SCHEDULE: PidSchedule = STANDARD_LOAD_PID_SCHEDULE;

const DEFAULT_TARGET_ASSISTANCE: ModelAssistedTargetConfiguration = {
  heatingRampCPerMinute: 15,
  coolingRampCPerMinute: 120,
  predictionHorizonSeconds: 15,
  maximumTargetLeadC: 15,
  minimumCommandC: 0,
  maximumCommandC: 250,
};

const DEMO_FIXTURE_TIME_MS = Date.UTC(2026, 7, 15, 12, 0, 0);
const DEMO_FIXTURE_TIME_ISO = new Date(DEMO_FIXTURE_TIME_MS).toISOString();
const ACTIVE_JOB_STATUSES = new Set<JobState['status']>([
  'preparing',
  'streaming',
  'pause-pending',
  'paused',
  'awaiting-decision',
  'stopping',
]);

@Injectable({ providedIn: 'root' })
export class WorkbenchStore implements OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly api: GcodeApi | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { readonly gcode?: GcodeApi }).gcode;
  private readonly unsubscribe: Array<() => void> = [];
  private controlTimer: ReturnType<typeof setInterval> | undefined;
  private validationTimer: ReturnType<typeof setTimeout> | undefined;
  private portsRefreshPromise: Promise<void> | null = null;
  private targetShaperState: TargetShaperState = createTargetShaperState(0);
  private lastControlTick = performance.now();
  private lastFirmwareTargetSent: number | null = null;
  private lastGainsSent: PidGains | null = null;
  private controlWriteInFlight = false;
  private validationFinalizing = false;
  private controlGeneration = 0;
  private validationSamples: M105Telemetry[] = [];
  private terminalId = 0;

  readonly isDesktop = signal(this.api !== undefined);
  readonly demoState = signal<DemoState | null>(null);
  readonly systemInfo = signal<SystemInfo>({
    platform: typeof navigator === 'undefined' ? 'unknown' : navigator.platform,
    arch: 'browser',
    versions: {},
  });
  readonly initialized = signal(false);
  readonly connection = signal<SerialConnectionState>(DEFAULT_CONNECTION);
  readonly ports = signal<readonly SerialPortDescriptor[]>([]);
  readonly selectedPort = signal('');
  readonly serialPortDialogOpen = signal(false);
  readonly serialPortsRefreshing = signal(false);
  readonly selectedPortAvailable = computed(() =>
    this.ports().some((port) => port.path === this.selectedPort()),
  );
  readonly settings = signal<AppSettings>(DEFAULT_SETTINGS);
  readonly telemetry = signal<TemperatureTelemetry>({
    timestamp: new Date().toISOString(),
    average: 22,
    target: 0,
    power: 0,
    thermistors: [22, 22, 22],
    raw: '',
  });
  readonly hasTelemetry = signal(false);
  readonly requestedTarget = signal(0);
  readonly modelTarget = signal(0);
  readonly controlMode = signal<ControlMode>('model-assisted');
  readonly controlArmed = signal(false);
  readonly pidSchedule = signal<PidSchedule>(DEFAULT_PID_SCHEDULE);
  readonly activePidGains = signal<PidGains>(interpolatePidGains(DEFAULT_PID_SCHEDULE, 0));
  readonly ovenModelProfile = signal<OvenModelProfile>(cloneOvenModelProfile(DEFAULT_OVEN_PROFILE));
  readonly modelAssistance = signal<ModelAssistedTargetConfiguration>({
    ...DEFAULT_TARGET_ASSISTANCE,
  });
  readonly activeProfile = signal('Built-in standard oven');
  readonly activity = signal<ExclusiveActivityState>({ active: null });
  readonly trend = signal<readonly TrendPoint[]>([]);
  readonly terminal = signal<readonly TerminalEntry[]>([]);
  readonly commandHistory = signal<readonly string[]>([]);
  readonly selectedJob = signal<JobFileInfo | null>(null);
  readonly job = signal<JobState>(DEFAULT_JOB);
  readonly jobTimeout = signal<JobTimeoutEvent | null>(null);
  readonly liveTuning = signal<LiveTuningState>(DEFAULT_TUNING);
  readonly validation = signal<ValidationRunState>(DEFAULT_VALIDATION);
  readonly catalog = signal<CommandCatalogSnapshot>({
    entries: BUNDLED_COMMAND_CATALOG,
    source: 'bundled',
    url: null,
    firmwareId: null,
    fetchedAt: null,
    stale: false,
  });
  readonly sessions = signal<readonly SessionMetadata[]>([]);
  readonly profiles = signal<readonly StoredProfile[]>([]);
  readonly catalogApproval = signal<CatalogApprovalRequest | null>(null);
  readonly toast = signal<string | null>(null);

  readonly connected = computed(() => this.connection().status === 'connected');
  readonly telemetryLive = computed(() => this.connected() && this.hasTelemetry());
  readonly busy = computed(
    () => this.activity().active !== null || ACTIVE_JOB_STATUSES.has(this.job().status),
  );
  readonly terminalLocked = computed(() => this.busy());
  readonly resolvedTheme = signal<'dark' | 'light'>('dark');
  readonly averageDelta = computed(() => this.requestedTarget() - this.telemetry().average);

  async initialize(): Promise<void> {
    if (this.initialized()) return;
    this.initialized.set(true);
    this.applyTheme(this.settings().theme);

    if (this.api === undefined) {
      const query = new URLSearchParams(window.location.search);
      const requestedTheme = query.get('theme');
      if (requestedTheme === 'dark' || requestedTheme === 'light' || requestedTheme === 'system') {
        this.settings.update((settings) => ({ ...settings, theme: requestedTheme }));
        this.applyTheme(requestedTheme);
      }
      const requestedState = query.get('state');
      const demoState = this.parseDemoState(requestedState);
      if (demoState !== null) {
        this.selectedPort.set('COM4');
        this.demoState.set(demoState);
        this.configureDemoState(demoState);
      }
      return;
    }

    this.registerDesktopEvents();
    await Promise.all([this.loadSettings(), this.refreshPorts(), this.loadDesktopState()]);
    this.clearUnavailableSelectedPort();
    this.targetShaperState = createTargetShaperState(this.telemetry().target);
    this.startControlLoop();
  }

  ngOnDestroy(): void {
    this.unsubscribe.forEach((unsubscribe) => unsubscribe());
    if (this.controlTimer !== undefined) clearInterval(this.controlTimer);
    if (this.validationTimer !== undefined) clearTimeout(this.validationTimer);
  }

  setTheme(theme: ThemePreference): void {
    this.settings.update((current) => ({ ...current, theme }));
    this.applyTheme(theme);
    void this.api?.settings.update({ theme });
  }

  toggleSidebar(): void {
    const root = this.document.documentElement;
    root.dataset['sidebar'] = root.dataset['sidebar'] === 'collapsed' ? 'expanded' : 'collapsed';
  }

  setMode(mode: ControlMode): void {
    this.controlMode.set(mode);
    this.targetShaperState = createTargetShaperState(
      mode === 'pid' ? this.requestedTarget() : this.modelTarget(),
    );
    this.notify(mode === 'pid' ? 'PID control selected' : 'Model-assisted PID selected');
  }

  refreshPorts(): Promise<void> {
    if (this.portsRefreshPromise !== null) return this.portsRefreshPromise;
    this.serialPortsRefreshing.set(true);
    const refresh = this.loadPorts().finally(() => {
      if (this.portsRefreshPromise === refresh) {
        this.portsRefreshPromise = null;
        this.serialPortsRefreshing.set(false);
      }
    });
    this.portsRefreshPromise = refresh;
    return refresh;
  }

  private async loadPorts(): Promise<void> {
    try {
      if (this.api === undefined) {
        this.ports.set([
          {
            path: 'COM4',
            friendlyName: 'STM32 Virtual COM Port',
            manufacturer: 'STMicroelectronics',
          },
          { path: 'COM7', friendlyName: 'USB Serial Device' },
        ]);
        this.clearUnavailableSelectedPort();
        return;
      }
      const result = await this.api.serial.listPorts();
      if (result.ok) {
        this.ports.set(result.value);
        this.clearUnavailableSelectedPort();
      } else {
        this.ports.set([]);
        this.clearUnavailableSelectedPort();
        this.notify(result.error.message);
      }
    } catch (error) {
      this.ports.set([]);
      this.clearUnavailableSelectedPort();
      this.notify(error instanceof Error ? error.message : 'Unable to enumerate serial ports.');
    }
  }

  async toggleConnection(): Promise<void> {
    if (this.connected()) await this.disconnect();
    else await this.openSerialPortDialog();
  }

  async openSerialPortDialog(): Promise<void> {
    this.serialPortDialogOpen.set(true);
    await this.refreshPorts();
  }

  dismissSerialPortDialog(): void {
    this.serialPortDialogOpen.set(false);
  }

  async connectSelectedPort(): Promise<void> {
    if (!this.serialPortDialogOpen()) return;
    if (this.serialPortsRefreshing()) return;
    if (!this.selectedPortAvailable()) {
      this.notify('Select one of the currently available serial ports.');
      return;
    }
    this.serialPortDialogOpen.set(false);
    await this.updateSettings({ lastSerialPort: this.selectedPort() });
    await this.connect();
  }

  async connect(): Promise<void> {
    this.disarmControl();
    this.hasTelemetry.set(false);
    const path = this.selectedPort();
    if (!path) {
      await this.openSerialPortDialog();
      return;
    }
    if (this.api === undefined) {
      this.connectDemo();
      await this.enableMonitoring();
      this.notify(`Connected to ${this.selectedPort()} (demo)`);
      return;
    }
    this.connection.update((state) => ({ ...state, status: 'connecting', error: null }));
    const result = await this.api.serial.connect({
      path,
      startupMacro: this.settings().startupMacro,
    });
    if (result.ok) {
      this.connection.set(result.value);
      await this.enableMonitoring();
    } else {
      this.connection.update((state) => ({ ...state, status: 'error', error: result.error }));
      this.notify(result.error.message);
    }
  }

  async disconnect(): Promise<void> {
    this.disarmControl();
    this.hasTelemetry.set(false);
    if (this.api === undefined) {
      this.connection.set(DEFAULT_CONNECTION);
      this.notify('Disconnected. Firmware behavior is outside desktop control.');
      return;
    }
    const result = await this.api.serial.disconnect();
    if (result.ok) this.connection.set(result.value);
    else this.notify(result.error.message);
  }

  async setTarget(value: number): Promise<void> {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this.notify('Enter a finite target between 0 and 250 °C.');
      return;
    }
    const target = Math.min(250, Math.max(0, numeric));
    if (this.connected() && this.busy()) {
      this.notify('Target changes are locked while an exclusive operation owns the controller.');
      return;
    }
    this.requestedTarget.set(target);
    if (!this.connected()) {
      this.notify('Connect the controller, then apply the target again to arm desktop control.');
      return;
    }
    this.controlArmed.set(true);
    this.controlGeneration += 1;
    await this.advanceControl(true);
  }

  async stopHeating(): Promise<void> {
    this.disarmControl();
    this.requestedTarget.set(0);
    this.modelTarget.set(0);
    this.targetShaperState = createTargetShaperState(0);
    this.lastFirmwareTargetSent = 0;
    if (this.connected()) {
      const heaterOffError = await this.requestHeaterOff();
      if (heaterOffError !== null) {
        this.notify(`Heater-off was not confirmed: ${heaterOffError}`);
        return;
      }
    }
    this.notify('Heater-off confirmed with M104 S0.');
  }

  async applyPidSchedule(schedule: PidSchedule): Promise<boolean> {
    const validated = createPidSchedule(schedule);
    if (this.connected() && this.busy()) {
      this.notify('The PID schedule cannot be changed during an exclusive operation.');
      return false;
    }
    this.pidSchedule.set(validated);
    const nextGains = interpolatePidGains(validated, this.requestedTarget());
    this.activePidGains.set(nextGains);
    this.lastGainsSent = null;
    if (!this.connected()) return true;
    const command = this.pidCommand(nextGains);
    if (await this.transmitControl(command)) {
      this.lastGainsSent = nextGains;
      return true;
    }
    return false;
  }

  async sendTerminal(commandText: string): Promise<boolean> {
    if (this.terminalLocked()) {
      this.notify('Terminal is locked while an exclusive operation is active.');
      return false;
    }
    const commands = commandText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (commands.length === 0) return false;

    for (const command of commands) {
      this.commandHistory.update((items) =>
        [command, ...items.filter((item) => item !== command)].slice(0, 50),
      );
      if (this.api !== undefined) {
        const result = await this.api.serial.send({ command, origin: 'terminal' });
        if (!result.ok) this.notify(result.error.message);
      } else {
        this.appendTerminal(this.entry('terminal', 'tx', command));
        window.setTimeout(() => this.demoCommandResponse(command), 180);
      }
    }
    return true;
  }

  async sendTuningCommand(command: string): Promise<boolean> {
    if (this.api === undefined) {
      this.appendTerminal(this.entry('tuning', 'tx', command));
      window.setTimeout(() => this.demoCommandResponse(command), 160);
      return true;
    }
    const result = await this.api.serial.send({ command, origin: 'tuning' });
    if (!result.ok) {
      this.notify(result.error.message);
      return false;
    }
    return true;
  }

  async beginExclusive(activity: 'tuning' | 'validation'): Promise<boolean> {
    if (this.api === undefined) {
      this.activity.set({ active: activity });
      return true;
    }
    const result = await this.api.activity.begin(activity);
    if (result.ok) {
      this.activity.set(result.value);
      return true;
    }
    this.notify(result.error.message);
    return false;
  }

  async endExclusive(activity: 'tuning' | 'validation'): Promise<void> {
    if (this.api === undefined) {
      this.activity.set({ active: null });
      return;
    }
    const result = await this.api.activity.end(activity);
    if (result.ok) this.activity.set(result.value);
    else this.notify(result.error.message);
  }

  async startBoundedValidation(targetC: number, schedule: PidSchedule): Promise<boolean> {
    if (!Number.isFinite(targetC) || targetC < 1 || targetC > 250) {
      this.notify('Validation target must be between 1 and 250 °C.');
      return false;
    }
    const boundedTarget = targetC;
    const validatedSchedule = createPidSchedule(schedule);
    if (!this.connected()) {
      this.notify('Connect the controller before starting validation.');
      return false;
    }
    if (!(await this.beginExclusive('validation'))) return false;

    this.disarmControl();
    this.pidSchedule.set(validatedSchedule);
    const gains = interpolatePidGains(validatedSchedule, boundedTarget);
    this.activePidGains.set(gains);
    this.validationSamples = [];
    this.validationFinalizing = false;
    const startedAt = new Date().toISOString();
    this.validation.set({
      ...DEFAULT_VALIDATION,
      status: 'running',
      targetC: boundedTarget,
      startedAt,
    });

    if (this.api === undefined) {
      window.setTimeout(() => void this.completeDemoValidation(boundedTarget), 350);
      return true;
    }

    const gainsSent = await this.transmitControl(this.pidCommand(gains));
    const targetSent = gainsSent
      ? await this.transmitControl(`M104 S${boundedTarget.toFixed(1)}`)
      : false;
    if (!gainsSent || !targetSent) {
      await this.finishValidation('failed', 'The validation commands were not accepted.');
      return false;
    }

    this.validationTimer = setTimeout(
      () => void this.finishValidation('completed'),
      DEFAULT_VALIDATION.maximumDurationMs,
    );
    return true;
  }

  async cancelValidation(): Promise<void> {
    if (this.validation().status !== 'running') return;
    await this.finishValidation('cancelled');
  }

  useModelAssistedControl(
    profile: OvenModelProfile,
    assistance: ModelAssistedTargetConfiguration,
  ): boolean {
    const normalizedProfile = cloneOvenModelProfile(profile);
    try {
      validateOvenModelProfile(normalizedProfile);
      validateTargetShaperConfiguration(assistance);
    } catch (error) {
      this.notify(error instanceof Error ? error.message : 'The oven model is invalid.');
      return false;
    }
    this.ovenModelProfile.set(normalizedProfile);
    this.modelAssistance.set({ ...assistance });
    this.activeProfile.set(normalizedProfile.name);
    this.controlMode.set('model-assisted');
    this.targetShaperState = createTargetShaperState(this.modelTarget());
    this.notify(`${normalizedProfile.name} is now used for model-assisted target shaping.`);
    return true;
  }

  async startLiveTuning(targets: readonly number[]): Promise<boolean> {
    this.disarmControl();
    if (this.api === undefined) {
      this.activity.set({ active: 'tuning' });
      this.liveTuning.set({
        ...DEFAULT_TUNING,
        id: `demo-tune-${Date.now()}`,
        status: 'snapshotting',
        startedAt: new Date().toISOString(),
        currentTarget: targets[0] ?? null,
      });
      return true;
    }
    const result = await this.api.tuning.start({
      targets,
      hysteresis: 5,
      peakCount: 12,
      maximumTarget: 250,
    });
    if (result.ok) {
      this.liveTuning.set(result.value);
      return true;
    }
    this.notify(result.error.message);
    return false;
  }

  async cancelLiveTuning(): Promise<void> {
    if (this.api === undefined) {
      this.activity.set({ active: null });
      this.liveTuning.update((state) => ({
        ...state,
        status: 'cancelled',
        endedAt: new Date().toISOString(),
      }));
      return;
    }
    const result = await this.api.tuning.cancel();
    if (result.ok) this.liveTuning.set(result.value);
    else this.notify(result.error.message);
  }

  clearTerminal(): void {
    this.terminal.set([]);
  }

  async chooseJob(): Promise<void> {
    if (this.api === undefined) {
      this.notify('Demo job selected. Drop a local file to preview the workflow.');
      return;
    }
    const result = await this.api.jobs.pickFile();
    if (result.ok && result.value !== null) this.selectedJob.set(result.value);
    else if (!result.ok) this.notify(result.error.message);
  }

  acceptDroppedFile(file: File): void {
    if (this.api !== undefined) {
      const path = this.api.jobs.resolveDroppedFile(file);
      void this.inspectDroppedPath(path);
      return;
    }
    const extension = this.extensionFor(file.name);
    if (extension === null) {
      this.notify('Use a .gcode, .gco, .gc, or .txt file.');
      return;
    }
    this.selectedJob.set({
      path: file.name,
      name: file.name,
      sizeBytes: file.size,
      modifiedAt: new Date(file.lastModified).toISOString(),
      extension,
    });
  }

  async startJob(startLine = 1): Promise<void> {
    const file = this.selectedJob();
    if (file === null) return;
    if (this.api !== undefined) {
      const result = await this.api.jobs.start({ path: file.path, startLine });
      if (result.ok) this.job.set(result.value);
      else this.notify(result.error.message);
      return;
    }
    this.job.set({
      ...DEFAULT_JOB,
      id: `demo-${Date.now()}`,
      status: 'streaming',
      file,
      startedAt: new Date().toISOString(),
      progress: {
        sourceLine: startLine,
        completedCommands: 0,
        bytesRead: 0,
        totalBytes: file.sizeBytes,
        percent: 0,
        elapsedMs: 0,
        etaMs: 720_000,
      },
    });
  }

  async pauseOrResumeJob(): Promise<void> {
    const job = this.job();
    if (this.api !== undefined) {
      const result =
        job.status === 'paused'
          ? await this.api.jobs.resume()
          : await this.api.jobs.pauseAfterCurrent();
      if (result.ok) this.job.set(result.value);
      else this.notify(result.error.message);
      return;
    }
    this.job.update((current) => ({
      ...current,
      status: current.status === 'paused' ? 'streaming' : 'paused',
      pauseRequested: false,
    }));
  }

  async stopJob(): Promise<void> {
    if (this.api !== undefined) {
      const result = await this.api.jobs.stop();
      if (result.ok) {
        this.job.set(result.value);
        await this.refreshSessions();
      } else this.notify(result.error.message);
      return;
    }
    this.job.update((current) => ({
      ...current,
      status: 'stopped',
      endedAt: new Date().toISOString(),
    }));
    await this.stopHeating();
  }

  async resolveJobTimeout(decision: JobTimeoutDecision): Promise<void> {
    const timeout = this.jobTimeout();
    if (timeout === null) return;
    if (this.api !== undefined) {
      const result = await this.api.jobs.resolveTimeout(timeout.decisionId, decision);
      if (result.ok) {
        this.job.set(result.value);
        this.jobTimeout.set(null);
      } else this.notify(result.error.message);
      return;
    }
    this.jobTimeout.set(null);
    this.job.update((current) => ({
      ...current,
      status: decision === 'stop' ? 'stopped' : 'streaming',
      endedAt: decision === 'stop' ? new Date().toISOString() : null,
    }));
  }

  async updateSettings(patch: SettingsPatch): Promise<void> {
    this.settings.update((current) => ({ ...current, ...patch }));
    if (patch.theme !== undefined) this.applyTheme(patch.theme);
    if (this.api === undefined) {
      this.notify('Settings saved for this demo session.');
      return;
    }
    const result = await this.api.settings.update(patch);
    if (result.ok) this.settings.set(result.value);
    else this.notify(result.error.message);
  }

  async refreshCatalog(): Promise<void> {
    if (this.api === undefined) {
      this.catalog.update((current) => ({
        ...current,
        source: 'cache',
        fetchedAt: new Date().toISOString(),
        stale: false,
      }));
      this.notify('Command catalog refreshed from demo cache.');
      return;
    }
    const result = await this.api.catalog.refresh();
    if (result.ok) this.catalog.set(result.value);
    else this.notify(result.error.message);
  }

  async resolveCatalogApproval(approved: boolean): Promise<void> {
    const request = this.catalogApproval();
    if (request === null) return;
    if (this.api === undefined) {
      this.catalogApproval.set(null);
      return;
    }
    const result = await this.api.catalog.approve(request.id, approved);
    if (result.ok) {
      this.catalog.set(result.value);
      this.catalogApproval.set(null);
      this.notify(approved ? `Approved ${request.host}.` : `Rejected ${request.host}.`);
    } else {
      this.notify(result.error.message);
    }
  }

  async openExternal(url: string): Promise<void> {
    if (this.api === undefined) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    const result = await this.api.system.openExternal(url);
    if (!result.ok) this.notify(result.error.message);
  }

  async saveProfile(
    name: string,
    kind: ProfileKind,
    state: ProfileState,
    data: unknown,
  ): Promise<StoredProfile | null> {
    const now = new Date().toISOString();
    const profile: StoredProfile = {
      id: crypto.randomUUID(),
      version: 1,
      kind,
      name: name.trim() || 'Untitled profile',
      state,
      createdAt: now,
      updatedAt: now,
      data: data as JsonValue,
    };
    if (this.api === undefined) {
      this.profiles.update((items) => [profile, ...items]);
      this.notify(`${profile.name} saved in the browser demo.`);
      return profile;
    }
    const result = await this.api.profiles.save(profile);
    if (result.ok) {
      this.profiles.update((items) => [
        result.value,
        ...items.filter((item) => item.id !== result.value.id),
      ]);
      this.notify(`${result.value.name} saved.`);
      return result.value;
    }
    this.notify(result.error.message);
    return null;
  }

  async importProfiles(): Promise<void> {
    if (this.api === undefined) {
      this.notify('Profile import opens a native picker in the desktop app.');
      return;
    }
    const result = await this.api.profiles.importFile();
    if (result.ok && result.value !== null) {
      const refreshed = await this.api.profiles.list();
      if (refreshed.ok) this.profiles.set(refreshed.value);
      this.notify(`Imported ${result.value.length} profile revision(s).`);
    } else if (!result.ok) this.notify(result.error.message);
  }

  async exportProfiles(ids: readonly string[]): Promise<void> {
    if (this.api === undefined) {
      this.notify('Profile export opens a native save dialog in the desktop app.');
      return;
    }
    const result = await this.api.profiles.exportFile(ids);
    if (result.ok && result.value !== null) this.notify(`Exported profiles to ${result.value}`);
    else if (!result.ok) this.notify(result.error.message);
  }

  async removeProfile(id: string): Promise<void> {
    if (this.api === undefined) {
      this.profiles.update((items) => items.filter((profile) => profile.id !== id));
      return;
    }
    const result = await this.api.profiles.remove(id);
    if (result.ok) this.profiles.update((items) => items.filter((profile) => profile.id !== id));
    else this.notify(result.error.message);
  }

  async saveTerminalSession(): Promise<string | null> {
    return this.saveSession(
      'terminal',
      `Terminal · ${new Date().toLocaleString()}`,
      {
        connection: this.connection().portPath,
        firmware: this.connection().firmware?.firmwareName ?? null,
        lines: this.terminal().map((entry) => ({
          timestamp: entry.timestamp,
          direction: entry.direction,
          line: entry.line,
          origin: entry.origin ?? null,
        })),
      },
      this.terminal()[0]?.timestamp,
    );
  }

  async saveSimulationSession(data: unknown): Promise<string | null> {
    return this.saveSession('simulation', `Simulation · ${new Date().toLocaleString()}`, data);
  }

  async exportTerminalSession(format: 'json' | 'csv'): Promise<void> {
    const id = await this.saveTerminalSession();
    if (id === null || this.api === undefined) return;
    const result = await this.api.sessions.exportFile([id], format);
    if (result.ok && result.value !== null)
      this.notify(`Terminal session exported to ${result.value}`);
    else if (!result.ok) this.notify(result.error.message);
  }

  async exportSessions(ids: readonly string[], format: 'json' | 'csv'): Promise<void> {
    if (this.api === undefined) {
      this.notify('Session export opens a native save dialog in the desktop app.');
      return;
    }
    const result = await this.api.sessions.exportFile(ids, format);
    if (result.ok && result.value !== null) this.notify(`Sessions exported to ${result.value}`);
    else if (!result.ok) this.notify(result.error.message);
  }

  async refreshSessions(): Promise<void> {
    if (this.api === undefined) return;
    const result = await this.api.sessions.list();
    if (result.ok) this.sessions.set(result.value);
  }

  notify(message: string): void {
    this.toast.set(message);
    window.setTimeout(() => {
      if (this.toast() === message) this.toast.set(null);
    }, 4_000);
  }

  private async loadSettings(): Promise<void> {
    if (this.api === undefined) return;
    const result = await this.api.settings.get();
    if (result.ok) {
      this.settings.set(result.value);
      this.applyTheme(result.value.theme);
      if (result.value.lastSerialPort !== null) this.selectedPort.set(result.value.lastSerialPort);
    }
  }

  private clearUnavailableSelectedPort(): void {
    const selected = this.selectedPort();
    if (selected !== '' && !this.ports().some((port) => port.path === selected)) {
      this.selectedPort.set('');
    }
  }

  private async loadDesktopState(): Promise<void> {
    if (this.api === undefined) return;
    const [connection, job, activity, catalog, systemInfo, tuning, sessions, profiles] =
      await Promise.all([
        this.api.serial.getState(),
        this.api.jobs.getState(),
        this.api.activity.get(),
        this.api.catalog.get(),
        this.api.system.getInfo(),
        this.api.tuning.getState(),
        this.api.sessions.list(),
        this.api.profiles.list(),
      ]);
    if (connection.ok) this.connection.set(connection.value);
    if (job.ok) this.job.set(job.value);
    if (activity.ok) this.activity.set(activity.value);
    if (catalog.ok) this.catalog.set(catalog.value);
    if (systemInfo.ok) this.systemInfo.set(systemInfo.value);
    if (tuning.ok) this.liveTuning.set(tuning.value);
    if (sessions.ok) this.sessions.set(sessions.value);
    if (profiles.ok) this.profiles.set(profiles.value);
  }

  private registerDesktopEvents(): void {
    if (this.api === undefined) return;
    this.unsubscribe.push(
      this.api.events.onSerialState((state) => this.consumeSerialState(state)),
      this.api.events.onSerialLine((event) =>
        this.appendTerminal({ ...event, id: ++this.terminalId }),
      ),
      this.api.events.onTelemetry((event) => this.consumeTelemetry(event)),
      this.api.events.onJobState((state) => {
        this.job.set(state);
        if (
          state.status === 'completed' ||
          state.status === 'stopped' ||
          state.status === 'failed'
        ) {
          window.setTimeout(() => void this.refreshSessions(), 750);
        }
      }),
      this.api.events.onJobTimeout((event) => this.jobTimeout.set(event)),
      this.api.events.onTuningState((state) => {
        this.liveTuning.set(state);
        if (
          state.status === 'completed' ||
          state.status === 'cancelled' ||
          state.status === 'failed'
        ) {
          window.setTimeout(() => void this.refreshSessions(), 750);
        }
      }),
      this.api.events.onActivity((state) => this.activity.set(state)),
      this.api.events.onFirmwareError((event) => this.notify(event.message)),
      this.api.events.onCatalogApproval((event) => {
        this.catalogApproval.set(event);
        this.notify(`Open Settings to approve or reject catalog host ${event.host}.`);
      }),
      this.api.events.onCatalogSnapshot((snapshot) => this.catalog.set(snapshot)),
    );
  }

  private async saveSession(
    kind: SessionKind,
    title: string,
    data: unknown,
    startedAt = new Date().toISOString(),
  ): Promise<string | null> {
    const now = new Date().toISOString();
    const session: SessionMetadata = {
      id: crypto.randomUUID(),
      version: 1,
      kind,
      title,
      startedAt,
      endedAt: now,
      pinned: false,
      data: data as JsonValue,
    };
    if (this.api === undefined) {
      this.sessions.update((items) => [session, ...items].slice(0, 100));
      this.notify(`${title} saved in the browser demo.`);
      return session.id;
    }
    const result = await this.api.sessions.save(session);
    if (!result.ok) {
      this.notify(result.error.message);
      return null;
    }
    this.sessions.update((items) => [
      result.value,
      ...items.filter((item) => item.id !== result.value.id),
    ]);
    this.notify(`${result.value.title} saved.`);
    return result.value.id;
  }

  private connectDemo(): void {
    this.connection.set({
      ...DEFAULT_CONNECTION,
      status: 'connected',
      portPath: this.selectedPort(),
      connectedAt: new Date(DEMO_FIXTURE_TIME_MS - 1_820_000).toISOString(),
      firmware: {
        raw: 'PID_TEMP_STM32',
        firmwareName: 'PID_TEMP_STM32',
        machineType: 'Dual heater oven',
        protocolVersion: '1.0',
      },
    });
  }

  private async enableMonitoring(): Promise<void> {
    if (!this.connected()) return;
    if (this.api === undefined) {
      this.appendTerminal(this.entry('control', 'tx', 'M155 S1'));
      return;
    }
    const result = await this.api.serial.send({ command: 'M155 S1', origin: 'control' });
    if (!result.ok)
      this.notify(`Connected, but telemetry monitoring could not start: ${result.error.message}`);
  }

  private consumeSerialState(state: SerialConnectionState): void {
    this.connection.set(state);
    if (state.status !== 'connected') {
      this.hasTelemetry.set(false);
      this.disarmControl();
      if (this.validation().status === 'running') {
        void this.finishValidation('failed', 'The controller disconnected during validation.');
      }
    }
  }

  private disarmControl(): void {
    this.controlArmed.set(false);
    this.controlGeneration += 1;
    this.lastFirmwareTargetSent = null;
    this.lastGainsSent = null;
  }

  private pidCommand(gains: PidGains): string {
    return `M301 P${gains.kp.toFixed(3)} I${gains.ki.toFixed(3)} D${gains.kd.toFixed(3)}`;
  }

  private startControlLoop(): void {
    if (this.controlTimer !== undefined) return;
    this.lastControlTick = performance.now();
    this.controlTimer = setInterval(() => void this.advanceControl(false), 1_000);
  }

  private async advanceControl(force: boolean): Promise<void> {
    const now = performance.now();
    const stepSeconds = Math.max(0.1, Math.min(2, (now - this.lastControlTick) / 1_000));
    this.lastControlTick = now;
    const domainMode = this.controlMode() === 'model-assisted' ? 'model-assisted-pid' : 'pid';
    const shaped = stepTargetShaper(
      domainMode,
      this.modelAssistance(),
      this.targetShaperState,
      this.requestedTarget(),
      stepSeconds,
    );
    this.targetShaperState = shaped.state;
    this.modelTarget.set(shaped.firmwareTargetC);

    const scheduledGains = interpolatePidGains(this.pidSchedule(), shaped.trajectoryTargetC);
    const transitionedGains = advancePidGainTransition(
      this.activePidGains(),
      scheduledGains,
      stepSeconds,
      5,
    );
    this.activePidGains.set(transitionedGains);

    if (
      !this.connected() ||
      !this.controlArmed() ||
      this.controlWriteInFlight ||
      this.activity().active !== null ||
      this.job().status === 'streaming' ||
      this.job().status === 'pause-pending'
    ) {
      return;
    }

    const gainsChanged =
      this.lastGainsSent === null ||
      Math.abs(transitionedGains.kp - this.lastGainsSent.kp) >= 0.02 ||
      Math.abs(transitionedGains.ki - this.lastGainsSent.ki) >= 0.002 ||
      Math.abs(transitionedGains.kd - this.lastGainsSent.kd) >= 0.05;
    const targetChanged =
      this.lastFirmwareTargetSent === null ||
      Math.abs(shaped.firmwareTargetC - this.lastFirmwareTargetSent) >= 0.15;
    if (!force && !gainsChanged && !targetChanged) return;

    const generation = this.controlGeneration;
    this.controlWriteInFlight = true;
    try {
      if (force || gainsChanged) {
        const command = this.pidCommand(transitionedGains);
        if (
          generation === this.controlGeneration &&
          this.controlArmed() &&
          (await this.transmitControl(command))
        ) {
          this.lastGainsSent = transitionedGains;
        }
      }
      if (
        (force || targetChanged) &&
        generation === this.controlGeneration &&
        this.controlArmed()
      ) {
        const command = `M104 S${shaped.firmwareTargetC.toFixed(1)}`;
        if (await this.transmitControl(command))
          this.lastFirmwareTargetSent = shaped.firmwareTargetC;
      }
    } finally {
      this.controlWriteInFlight = false;
    }
  }

  private async transmitControl(command: string): Promise<boolean> {
    if (this.api === undefined) {
      this.appendTerminal(this.entry('control', 'tx', command));
      return true;
    }
    const result = await this.api.serial.send({ command, origin: 'control' });
    if (!result.ok) {
      this.notify(result.error.message);
      return false;
    }
    return true;
  }

  private configureDemoState(state: DemoState): void {
    if (state === 'disconnected') {
      this.connection.set(DEFAULT_CONNECTION);
      return;
    }
    if (state === 'error') {
      this.connection.set({
        ...DEFAULT_CONNECTION,
        status: 'error',
        portPath: this.selectedPort(),
        error: {
          code: 'SERIAL_HANDSHAKE_FAILED',
          message: 'Firmware handshake timed out. Check the selected port and controller power.',
          recoverable: true,
        },
      });
      return;
    }
    this.seedDemoFixtures();
    this.connectDemo();
    if (state === 'streaming') {
      this.job.update((job) => ({
        ...job,
        id: 'demo-job',
        status: 'streaming',
        startedAt: new Date(DEMO_FIXTURE_TIME_MS - 754_000).toISOString(),
        progress: {
          sourceLine: 843,
          completedCommands: 726,
          bytesRead: 91_406,
          totalBytes: job.file?.sizeBytes ?? 148_220,
          percent: 61.67,
          elapsedMs: 754_000,
          etaMs: 468_000,
        },
        lastCompletedSourceLine: 842,
      }));
    }
    if (state === 'tuning') {
      this.activity.set({ active: 'tuning' });
      this.liveTuning.set({
        ...DEFAULT_TUNING,
        id: 'demo-live-tune',
        status: 'cooling',
        startedAt: new Date(DEMO_FIXTURE_TIME_MS - 542_000).toISOString(),
        currentTarget: 150,
        currentBreakpointIndex: 1,
        peaksCollected: 5,
        peakGoal: 12,
        rollbackGains: { kp: 18.2, ki: 0.73, kd: 82 },
      });
    }
  }

  private parseDemoState(value: string | null): DemoState | null {
    return value === 'disconnected' ||
      value === 'monitoring' ||
      value === 'streaming' ||
      value === 'simulation' ||
      value === 'tuning' ||
      value === 'error'
      ? value
      : null;
  }

  private seedDemoFixtures(): void {
    this.requestedTarget.set(200);
    this.modelTarget.set(192.4);
    this.targetShaperState = createTargetShaperState(192.4);
    this.telemetry.set({
      timestamp: DEMO_FIXTURE_TIME_ISO,
      average: 184.6,
      target: 192.4,
      power: 174,
      thermistors: [186.2, 183, 48.7],
      raw: 'T0:184.6 /192.4 @:174 T1:186.2 T2:183.0 T3:48.7',
    });
    this.hasTelemetry.set(true);
    this.trend.set(this.seedTrend());
    this.terminal.set([
      this.entry('system', 'rx', 'Explicit browser demo — hardware calls are simulated.'),
      this.entry('terminal', 'tx', 'M115'),
      this.entry(
        'terminal',
        'rx',
        'FIRMWARE_NAME:PID_TEMP_STM32 MACHINE_TYPE:DUAL_HEATER PROTOCOL_VERSION:1.0',
      ),
    ]);
    this.commandHistory.set(['M105', 'M503', 'M115']);
    const demoFile: JobFileInfo = {
      path: 'C:\\Jobs\\standard-load-200c.gcode',
      name: 'standard-load-200c.gcode',
      sizeBytes: 148_220,
      modifiedAt: new Date(DEMO_FIXTURE_TIME_MS - 86_400_000).toISOString(),
      extension: '.gcode',
    };
    this.selectedJob.set(demoFile);
    this.job.set({ ...DEFAULT_JOB, file: demoFile });
    this.profiles.set(this.demoProfiles());
  }

  private consumeTelemetry(event: TemperatureTelemetry): void {
    this.telemetry.set(event);
    this.hasTelemetry.set(true);
    this.trend.update((points) =>
      [
        ...points,
        {
          time: Date.parse(event.timestamp),
          average: event.average,
          t1: event.thermistors[0],
          t2: event.thermistors[1],
          t3: event.thermistors[2],
          target: this.requestedTarget(),
          modelTarget: this.modelTarget(),
          power: event.power,
        },
      ].slice(-7_200),
    );
    if (this.validation().status === 'running') {
      const startedAt = Date.parse(this.validation().startedAt ?? event.timestamp);
      const receivedAt = Date.parse(event.timestamp);
      const previousAt = this.validationSamples.at(-1)?.atMs ?? -1;
      const relativeAt = Number.isFinite(receivedAt - startedAt) ? receivedAt - startedAt : 0;
      const sample: M105Telemetry = {
        atMs: Math.max(previousAt + 1, relativeAt),
        t0C: event.average,
        t1C: event.thermistors[0],
        t2C: event.thermistors[1],
        t3C: event.thermistors[2],
        reportedTargetC: event.target,
        output: event.power,
        raw: event.raw,
      };
      this.validationSamples.push(sample);
      this.validation.update((state) => ({ ...state, sampleCount: this.validationSamples.length }));
      if (sample.atMs >= 120_000 && this.validationSamples.length >= 2) {
        const target = this.validation().targetC;
        if (target !== null) {
          try {
            const metrics = calculateValidationMetrics(this.validationSamples, target);
            if (metrics.settlingTimeMs !== undefined) void this.finishValidation('completed');
          } catch (error) {
            void this.finishValidation(
              'failed',
              error instanceof Error ? error.message : 'Validation telemetry was invalid.',
            );
          }
        }
      }
    }
  }

  private async completeDemoValidation(targetC: number): Promise<void> {
    if (this.validation().status !== 'running') return;
    const initial = this.telemetry().average;
    this.validationSamples = Array.from({ length: 241 }, (_, index) => {
      const response = targetC - (targetC - initial) * Math.exp(-index / 28);
      return {
        atMs: index * 1_000,
        t0C: response,
        t1C: response + 0.7,
        t2C: response - 0.7,
        t3C: 38 + response * 0.06,
        reportedTargetC: targetC,
        output: Math.max(22, Math.min(255, (targetC - response) * 12 + 25)),
      };
    });
    this.validation.update((state) => ({ ...state, sampleCount: this.validationSamples.length }));
    await this.finishValidation('completed');
  }

  private async finishValidation(
    requestedStatus: 'completed' | 'cancelled' | 'failed',
    requestedError: string | null = null,
  ): Promise<void> {
    const current = this.validation();
    if (current.status !== 'running' || this.validationFinalizing) return;
    this.validationFinalizing = true;
    if (this.validationTimer !== undefined) {
      clearTimeout(this.validationTimer);
      this.validationTimer = undefined;
    }

    let metrics: ValidationMetrics | null = null;
    let status = requestedStatus;
    let error = requestedError;
    if (this.validationSamples.length >= 2 && current.targetC !== null) {
      try {
        metrics = calculateValidationMetrics(this.validationSamples, current.targetC);
      } catch (caught) {
        if (status === 'completed') status = 'failed';
        error =
          caught instanceof Error ? caught.message : 'Validation metrics could not be calculated.';
      }
    } else if (status === 'completed') {
      status = 'failed';
      error = 'Validation ended before enough telemetry was collected.';
    }

    if (this.connected()) {
      const heaterOffError = await this.requestHeaterOff();
      if (heaterOffError !== null) {
        status = 'failed';
        error = `Heater-off was not confirmed: ${heaterOffError}`;
        this.notify(error);
      }
    }
    await this.endExclusive('validation');
    const endedAt = new Date().toISOString();
    this.validation.set({
      ...current,
      status,
      endedAt,
      sampleCount: this.validationSamples.length,
      metrics,
      error,
    });
    await this.saveSession(
      'tuning',
      `Validation · ${current.targetC?.toFixed(0) ?? '—'} °C · Standard load`,
      {
        type: 'bounded-validation',
        condition: 'Standard load',
        status,
        targetC: current.targetC,
        pidSchedule: this.pidSchedule(),
        metrics,
        sampleCount: this.validationSamples.length,
        maximumDurationMs: current.maximumDurationMs,
        error,
      },
      current.startedAt ?? endedAt,
    );
    this.validationFinalizing = false;
  }

  private async requestHeaterOff(): Promise<string | null> {
    if (this.api === undefined) {
      this.appendTerminal(this.entry('system', 'tx', 'M104 S0'));
      return null;
    }
    const result = await this.api.serial.heaterOff();
    return result.ok ? null : result.error.message;
  }

  private seedTrend(): readonly TrendPoint[] {
    const now = this.demoState() === null ? Date.now() : DEMO_FIXTURE_TIME_MS;
    return Array.from({ length: 90 }, (_, index) => {
      const progress = index / 89;
      const average = 24 + 161 * (1 - Math.exp(-progress * 3.2));
      return {
        time: now - (89 - index) * 5_000,
        average,
        t1: average + 1.5 + Math.sin(index / 8) * 0.4,
        t2: average - 1.5 - Math.sin(index / 8) * 0.4,
        t3: 24 + progress * 25,
        target: 200,
        modelTarget: 24 + progress * 169,
        power: 255 - progress * 78,
      };
    });
  }

  private demoProfiles(): readonly StoredProfile[] {
    const now = DEMO_FIXTURE_TIME_ISO;
    return [
      {
        id: 'demo-pid-standard',
        version: 1,
        kind: 'pid-schedule',
        name: 'Standard load PID',
        state: 'applied',
        createdAt: now,
        updatedAt: now,
        data: DEFAULT_PID_SCHEDULE as unknown as JsonValue,
      },
      {
        id: 'demo-oven-standard',
        version: 1,
        kind: 'simulation',
        name: DEFAULT_OVEN_PROFILE.name,
        state: 'validated',
        createdAt: now,
        updatedAt: now,
        data: {
          profile: DEFAULT_OVEN_PROFILE,
          modelAssistance: DEFAULT_TARGET_ASSISTANCE,
        } as unknown as JsonValue,
      },
    ];
  }

  private appendTerminal(entry: TerminalEntry): void {
    this.terminal.update((entries) => [...entries, entry].slice(-500));
  }

  private entry(
    origin: SerialLineEvent['origin'],
    direction: 'rx' | 'tx',
    line: string,
  ): TerminalEntry {
    return {
      id: ++this.terminalId,
      timestamp: this.demoState() === null ? new Date().toISOString() : DEMO_FIXTURE_TIME_ISO,
      direction,
      line,
      origin,
    };
  }

  private demoCommandResponse(command: string): void {
    if (/^M105/i.test(command))
      this.appendTerminal(this.entry('terminal', 'rx', this.telemetry().raw));
    else if (/^M503/i.test(command)) {
      ['kp: 18.200', 'ki: 0.730', 'kd: 82.000'].forEach((line) =>
        this.appendTerminal(this.entry('terminal', 'rx', line)),
      );
    } else this.appendTerminal(this.entry('terminal', 'rx', 'ok'));
  }

  private applyTheme(preference: ThemePreference): void {
    const systemDark =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
    this.resolvedTheme.set(resolved);
    this.document.documentElement.dataset['theme'] = resolved;
  }

  private extensionFor(name: string): JobFileInfo['extension'] | null {
    const match = name.toLowerCase().match(/(\.gcode|\.gco|\.gc|\.txt)$/)?.[1];
    return match === '.gcode' || match === '.gco' || match === '.gc' || match === '.txt'
      ? match
      : null;
  }

  private async inspectDroppedPath(path: string): Promise<void> {
    if (this.api === undefined) return;
    const result = await this.api.jobs.inspectFile(path);
    if (result.ok) this.selectedJob.set(result.value);
    else this.notify(result.error.message);
  }
}
