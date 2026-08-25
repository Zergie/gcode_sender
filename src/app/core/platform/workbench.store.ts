import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import type {
  ControlMode,
  ExclusiveActivityState,
  GcodeApi,
  HeatingProfile,
  JobFileInfo,
  JobStartRequest,
  JobState,
  JobTimeoutDecision,
  JobTimeoutEvent,
  SerialConnectionState,
  SerialLineEvent,
  SettingsPatch,
  TemperatureTelemetry,
  ThemePreference,
  SystemInfo,
  JsonValue,
  LoadedGcodeProgram,
  ProfileKind,
  ProfileState,
  StoredProfile,
} from '../../../../shared/contracts';
import type { LiveTuningState } from '../../../../shared/tuning-contracts';
import { validateHeatingProfile } from '../../../../shared/heating-profile-document';
import {
  advancePidGainTransition,
  assimilateFirmwareQuickPidObservation,
  createFirmwareQuickPidState,
  createPidSchedule,
  createTargetShaperState,
  interpolatePidGains,
  setFirmwareQuickPidTunings,
  stepFirmwareQuickPid,
  validateTargetShaperConfiguration,
  type FirmwareQuickPidState,
  type ModelAssistedTargetConfiguration,
  type PidGains,
  type PidSchedule,
  type TargetShaperState,
} from '../control';
import {
  DEFAULT_OVEN_PROFILE,
  DEFAULT_SIMULATION_CONTROLLER,
  PHYSICAL_FORECAST_REPLAN_SECONDS,
  STANDARD_LOAD_PID_SCHEDULE,
  cloneOvenModelProfile,
  createPhysicalForecastPlanner,
  createPhysicalTwinObserver,
  stepPhysicalFeedForward,
  validateOvenModelProfile,
  type OvenModelProfile,
  type PhysicalForecastPlan,
  type PhysicalForecastPlanner,
  type PhysicalTwinObserver,
} from '../simulation';
import { calculateValidationMetrics, type M105Telemetry, type ValidationMetrics } from '../tuning';
import { NotificationStore } from './notification.store';
import { ConfigurationStore } from '../configuration/configuration.store';
import { SessionCatalogStore } from './session-catalog.store';
import { SerialTelemetryStore } from './serial-telemetry.store';

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

export interface HeatingProfileValidation {
  readonly valid: boolean;
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
  ...DEFAULT_SIMULATION_CONTROLLER.modelAssistance,
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
const MAX_HEATING_PROFILE_DURATION_MS = 24 * 60 * 60_000;
const MAX_HEATING_PROFILE_POINTS = 128;

@Injectable({ providedIn: 'root' })
export class WorkbenchStore implements OnDestroy {
  private readonly configuration = inject(ConfigurationStore);
  private readonly notifications = inject(NotificationStore);
  private readonly sessionCatalog = inject(SessionCatalogStore);
  private readonly serialTelemetry = inject(SerialTelemetryStore);
  private readonly document = inject(DOCUMENT);
  private readonly api: GcodeApi | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { readonly gcode?: GcodeApi }).gcode;
  private readonly unsubscribe: Array<() => void> = [];
  private initializePromise: Promise<void> | null = null;
  private destroyed = false;
  private controlTimer: ReturnType<typeof setInterval> | undefined;
  private validationTimer: ReturnType<typeof setTimeout> | undefined;
  private targetShaperState: TargetShaperState = createTargetShaperState(0);
  private physicalForecastPlanner: PhysicalForecastPlanner | null = null;
  private lastPhysicalForecastAtMs: number | null = null;
  private lastPhysicalForecastRequestC: number | null = null;
  private lastPhysicalForecastPlan: PhysicalForecastPlan | null = null;
  private physicalTwinObserver: PhysicalTwinObserver | null = null;
  private physicalFirmwarePidState: FirmwareQuickPidState | null = null;
  private physicalPidRemainderSeconds = 0;
  private lastPhysicalPidMeasurementC: number | null = null;
  private lastPhysicalObservationAtMs: number | null = null;
  private lastObservedPwm8 = 0;
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
  readonly connection = this.serialTelemetry.connection;
  readonly ports = this.serialTelemetry.ports;
  readonly selectedPort = this.serialTelemetry.selectedPort;
  readonly serialPortDialogOpen = this.serialTelemetry.serialPortDialogOpen;
  readonly serialPortsRefreshing = this.serialTelemetry.serialPortsRefreshing;
  readonly selectedPortAvailable = computed(() =>
    this.ports().some((port) => port.path === this.selectedPort()),
  );
  readonly settings = this.configuration.settings;
  readonly telemetry = this.serialTelemetry.telemetry;
  readonly hasTelemetry = this.serialTelemetry.hasTelemetry;
  readonly requestedTarget = signal(0);
  readonly modelTarget = signal(0);
  readonly controlMode = signal<ControlMode>('pid');
  /** The in-memory Wasm artifact paired with the persisted sketch path. */
  readonly firmwareInLoop = this.configuration.firmwareInLoop;
  readonly firmwareInLoopHardware = this.configuration.firmwareInLoopHardware;
  readonly firmwareInLoopBuilding = this.configuration.firmwareInLoopBuilding;
  readonly controlArmed = signal(false);
  readonly pidSchedule = signal<PidSchedule>(DEFAULT_PID_SCHEDULE);
  readonly activePidGains = signal<PidGains>(interpolatePidGains(DEFAULT_PID_SCHEDULE, 0));
  readonly ovenModelProfile = this.configuration.ovenModelProfile;
  readonly modelAssistance = signal<ModelAssistedTargetConfiguration>({
    ...DEFAULT_TARGET_ASSISTANCE,
  });
  readonly activeProfile = signal('Standard oven model');
  readonly activity = signal<ExclusiveActivityState>({ active: null });
  readonly trend = signal<readonly TrendPoint[]>([]);
  readonly terminal = this.serialTelemetry.terminal;
  readonly commandHistory = this.serialTelemetry.commandHistory;
  readonly selectedProgram = signal<LoadedGcodeProgram | null>(null);
  readonly selectedJob = signal<JobFileInfo | null>(null);
  readonly heatingProfileDraft = signal<HeatingProfile | null>(null);
  readonly heatingProfileDirty = signal(false);
  readonly job = signal<JobState>(DEFAULT_JOB);
  readonly jobTimeout = signal<JobTimeoutEvent | null>(null);
  readonly liveTuning = signal<LiveTuningState>(DEFAULT_TUNING);
  readonly validation = signal<ValidationRunState>(DEFAULT_VALIDATION);
  readonly catalog = this.sessionCatalog.catalog;
  readonly sessions = this.sessionCatalog.sessions;
  readonly profiles = this.configuration.profiles;
  readonly toast = this.notifications.toast;

  readonly connected = computed(() => this.connection().status === 'connected');
  readonly telemetryLive = computed(() => this.connected() && this.hasTelemetry());
  readonly busy = computed(
    () => this.activity().active !== null || ACTIVE_JOB_STATUSES.has(this.job().status),
  );
  readonly terminalLocked = computed(() => this.busy());
  readonly resolvedTheme = signal<'dark' | 'light'>('dark');
  readonly averageDelta = computed(() => this.requestedTarget() - this.telemetry().average);
  readonly heatingProfileValidation = computed<HeatingProfileValidation>(() =>
    validateHeatingProfileDraft(this.heatingProfileDraft()),
  );

  initialize(): Promise<void> {
    if (this.initializePromise !== null) return this.initializePromise;
    this.initializePromise = this.initializeOnce();
    return this.initializePromise;
  }

  private async initializeOnce(): Promise<void> {
    if (this.initialized()) return;
    this.initialized.set(true);
    this.applyTheme(this.settings().theme);

    if (this.api === undefined) {
      const query = new URLSearchParams(window.location.search);
      const requestedTheme = query.get('theme');
      if (requestedTheme === 'dark' || requestedTheme === 'light' || requestedTheme === 'system') {
        this.configuration.setTheme(requestedTheme);
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
    this.sessionCatalog.initialize();
    await Promise.all([this.loadSettings(), this.refreshPorts(), this.loadDesktopState()]);
    this.clearUnavailableSelectedPort();
    this.targetShaperState = createTargetShaperState(this.telemetry().target);
    this.startControlLoop();
  }

  ngOnDestroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
    this.sessionCatalog.ngOnDestroy();
    if (this.controlTimer !== undefined) {
      clearInterval(this.controlTimer);
      this.controlTimer = undefined;
    }
    this.serialTelemetry.ngOnDestroy();
    if (this.validationTimer !== undefined) {
      clearTimeout(this.validationTimer);
      this.validationTimer = undefined;
    }
  }

  setTheme(theme: ThemePreference): void {
    this.configuration.setTheme(theme);
    this.applyTheme(theme);
    void this.api?.settings.update({ theme });
  }

  toggleSidebar(): void {
    const root = this.document.documentElement;
    root.dataset['sidebar'] = root.dataset['sidebar'] === 'collapsed' ? 'expanded' : 'collapsed';
  }

  setMode(mode: ControlMode): boolean {
    if (mode === 'model-assisted' && this.firmwareInLoop() === null) {
      this.notify(
        'Select and compile a FIRMWARE .ino file in Settings before enabling Model-assisted PID.',
      );
      return false;
    }
    this.controlMode.set(mode);
    this.physicalForecastPlanner = null;
    this.lastPhysicalForecastAtMs = null;
    this.lastPhysicalForecastRequestC = null;
    this.lastPhysicalForecastPlan = null;
    this.targetShaperState = createTargetShaperState(
      mode === 'pid' ? this.requestedTarget() : this.modelTarget(),
    );
    this.notify(mode === 'pid' ? 'PID control selected' : 'Model-assisted PID selected');
    return true;
  }

  async chooseFirmwareIno(): Promise<boolean> {
    if (this.api === undefined) {
      this.notify('Firmware-in-the-loop selection is available in the Electron desktop app.');
      return false;
    }
    this.configuration.setFirmwareBuildBusy(true);
    try {
      const result = await this.api.firmware.pickAndBuild();
      if (!result.ok) {
        this.notify(result.error.message);
        return false;
      }
      if (result.value === null) return false;
      if (result.value.status === 'failed') {
        this.notify(result.value.diagnostics.map(({ message }) => message).join(' '));
        return false;
      }
      const firmware = result.value.firmware;
      this.configuration.setFirmware(firmware);
      await this.updateSettings({ firmwareInoPath: firmware.source.path });
      this.notify(
        `${firmware.source.displayName} is ready (${firmware.cacheHit ? 'cached build' : 'fresh build'}).`,
      );
      return true;
    } finally {
      this.configuration.setFirmwareBuildBusy(false);
    }
  }

  refreshPorts(): Promise<void> {
    return this.serialTelemetry.refreshPorts();
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
    this.resetPhysicalControlModel();
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
    const connected = await this.serialTelemetry.connect(path, this.settings().startupMacro);
    if (connected !== null) {
      await this.enableMonitoring();
    } else {
      const error = this.connection().error;
      if (error !== null) this.notify(error.message);
    }
  }

  async disconnect(): Promise<void> {
    this.disarmControl();
    this.resetPhysicalControlModel();
    this.hasTelemetry.set(false);
    if (this.api === undefined) {
      this.connection.set(DEFAULT_CONNECTION);
      this.notify('Disconnected. Firmware behavior is outside desktop control.');
      return;
    }
    await this.serialTelemetry.disconnect();
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
      this.serialTelemetry.recordCommand(command);
      if (this.api !== undefined) {
        await this.serialTelemetry.send(command, 'terminal');
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
    return this.serialTelemetry.send(command, 'tuning');
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
    if (this.firmwareInLoop() === null) {
      this.notify(
        'Select and compile a FIRMWARE .ino file in Settings before enabling Model-assisted PID.',
      );
      return false;
    }
    const normalizedProfile = cloneOvenModelProfile(profile);
    try {
      validateOvenModelProfile(normalizedProfile);
      validateTargetShaperConfiguration(assistance);
    } catch (error) {
      this.notify(error instanceof Error ? error.message : 'The oven model is invalid.');
      return false;
    }
    this.configuration.setPhysicalModel(normalizedProfile);
    this.modelAssistance.set({ ...assistance });
    this.activeProfile.set(normalizedProfile.name);
    this.controlMode.set('model-assisted');
    this.resetPhysicalControlModel();
    this.targetShaperState = createTargetShaperState(this.modelTarget());
    this.notify(`${normalizedProfile.name} is now used for physical model-assisted control.`);
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
    if (this.busy()) {
      this.notify('Wait for the active operation to finish before loading another file.');
      return;
    }
    if (this.api === undefined) {
      const file: JobFileInfo = {
        path: 'C:\\Jobs\\ordinary-demo.gcode',
        name: 'ordinary-demo.gcode',
        sizeBytes: 42_240,
        modifiedAt: DEMO_FIXTURE_TIME_ISO,
        extension: '.gcode',
      };
      this.selectProgram({ file, kind: 'gcode', profile: null, metadataWarning: null });
      this.notify('Demo G-code selected. Native file picking is available in the desktop app.');
      return;
    }
    const result = await this.api.jobs.pickFile();
    if (result.ok && result.value !== null) this.selectProgram(result.value);
    else if (!result.ok) this.notify(result.error.message);
  }

  acceptDroppedFile(file: File): void {
    if (this.busy()) {
      this.notify('Wait for the active operation to finish before loading another file.');
      return;
    }
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
    const info: JobFileInfo = {
      path: file.name,
      name: file.name,
      sizeBytes: file.size,
      modifiedAt: new Date(file.lastModified).toISOString(),
      extension,
    };
    this.selectProgram({ file: info, kind: 'gcode', profile: null, metadataWarning: null });
  }

  newHeatingProfile(): void {
    if (this.busy()) {
      this.notify('Wait for the active operation to finish before creating a profile.');
      return;
    }
    this.selectedProgram.set(null);
    this.selectedJob.set(null);
    this.heatingProfileDraft.set({
      version: 1,
      name: 'Untitled heating profile',
      interpolation: 'linear',
      points: [
        { timeMs: 0, targetC: 25 },
        { timeMs: 10 * 60_000, targetC: 180 },
        { timeMs: 20 * 60_000, targetC: 0 },
      ],
    });
    this.heatingProfileDirty.set(true);
    this.notify('New heating profile ready to edit.');
  }

  updateHeatingProfileName(name: string): void {
    if (this.busy()) return;
    this.heatingProfileDraft.update((profile) =>
      profile === null ? null : { ...profile, name: String(name) },
    );
    this.heatingProfileDirty.set(true);
  }

  updateHeatingProfilePoint(index: number, patch: Partial<HeatingProfile['points'][number]>): void {
    if (this.busy()) return;
    this.heatingProfileDraft.update((profile) => {
      if (profile === null || index < 0 || index >= profile.points.length) return profile;
      const points = profile.points.map((point, pointIndex) => {
        if (pointIndex !== index) return point;
        const previous = profile.points[index - 1];
        const next = profile.points[index + 1];
        const requestedTime = Number(patch.timeMs ?? point.timeMs);
        const requestedTarget = Number(patch.targetC ?? point.targetC);
        const minimumTime = index === 0 ? 0 : (previous?.timeMs ?? 0) + 1;
        const maximumTime = Math.min(
          MAX_HEATING_PROFILE_DURATION_MS,
          next === undefined ? MAX_HEATING_PROFILE_DURATION_MS : next.timeMs - 1,
        );
        return {
          timeMs:
            index === 0
              ? 0
              : Math.round(
                  Math.min(maximumTime, Math.max(minimumTime, requestedTime || minimumTime)),
                ),
          targetC: Math.round(Math.min(250, Math.max(0, requestedTarget || 0))),
        };
      });
      return { ...profile, points };
    });
    this.heatingProfileDirty.set(true);
  }

  addHeatingProfilePoint(afterIndex: number): number {
    if (this.busy()) return afterIndex;
    let insertedIndex = afterIndex;
    this.heatingProfileDraft.update((profile) => {
      if (profile === null) return null;
      if (profile.points.length >= MAX_HEATING_PROFILE_POINTS) {
        this.notify(`Heating profiles support up to ${MAX_HEATING_PROFILE_POINTS} stages.`);
        return profile;
      }
      const boundedIndex = Math.max(0, Math.min(profile.points.length - 1, afterIndex));
      const current = profile.points[boundedIndex]!;
      const next = profile.points[boundedIndex + 1];
      if (next !== undefined && next.timeMs - current.timeMs < 2) {
        this.notify('Move the neighboring stages apart before inserting another stage.');
        return profile;
      }
      const point =
        next === undefined
          ? {
              timeMs: Math.min(MAX_HEATING_PROFILE_DURATION_MS, current.timeMs + 5 * 60_000),
              targetC: Math.round(current.targetC),
            }
          : {
              timeMs: Math.round((current.timeMs + next.timeMs) / 2),
              targetC: Math.round((current.targetC + next.targetC) / 2),
            };
      if (point.timeMs <= current.timeMs) {
        this.notify('The profile already reaches the 24-hour duration limit.');
        return profile;
      }
      insertedIndex = boundedIndex + 1;
      return {
        ...profile,
        points: [
          ...profile.points.slice(0, insertedIndex),
          point,
          ...profile.points.slice(insertedIndex),
        ],
      };
    });
    this.heatingProfileDirty.set(true);
    return insertedIndex;
  }

  removeHeatingProfilePoint(index: number): void {
    if (this.busy()) return;
    this.heatingProfileDraft.update((profile) => {
      if (profile === null || profile.points.length <= 2 || index <= 0) return profile;
      return { ...profile, points: profile.points.filter((_, pointIndex) => pointIndex !== index) };
    });
    this.heatingProfileDirty.set(true);
  }

  async saveHeatingProfile(): Promise<LoadedGcodeProgram | null> {
    if (this.busy()) {
      this.notify('Wait for the active operation to finish before saving a profile.');
      return null;
    }
    const profile = this.heatingProfileDraft();
    const validation = this.heatingProfileValidation();
    if (profile === null || !validation.valid) {
      this.notify(validation.error ?? 'Create a valid heating profile before saving.');
      return null;
    }
    if (this.api === undefined) {
      const stem = profile.name
        .trim()
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/^-|-$/g, '');
      const file: JobFileInfo = {
        path: `C:\\Jobs\\${stem || 'heating-profile'}.gcode`,
        name: `${stem || 'heating-profile'}.gcode`,
        sizeBytes: 512 + profile.points.length * 48,
        modifiedAt: new Date().toISOString(),
        extension: '.gcode',
      };
      const program: LoadedGcodeProgram = {
        file,
        kind: 'heating-profile',
        profile: cloneHeatingProfile(profile),
        metadataWarning: null,
      };
      this.selectProgram(program);
      this.notify(`${profile.name} saved in the browser demo.`);
      return program;
    }
    const result = await this.api.jobs.saveHeatingProfile(profile);
    if (result.ok && result.value !== null) {
      this.selectProgram(result.value);
      this.notify(`${result.value.profile?.name ?? result.value.file.name} saved.`);
      return result.value;
    }
    if (!result.ok) this.notify(result.error.message);
    return null;
  }

  async runLoadedProgram(startLine = 1): Promise<boolean> {
    if (!this.connected()) {
      this.notify('Connect the controller before running a G-code file.');
      return false;
    }
    if (this.busy()) {
      this.notify('Wait for the active operation to finish before starting another file.');
      return false;
    }
    if (this.heatingProfileDraft() !== null) {
      if (!this.heatingProfileValidation().valid) {
        this.notify(this.heatingProfileValidation().error ?? 'The heating profile is invalid.');
        return false;
      }
      if (this.heatingProfileDirty() || this.selectedProgram() === null) {
        const saved = await this.saveHeatingProfile();
        if (saved === null) return false;
      }
    }
    if (this.selectedProgram() === null) {
      this.notify('Load a G-code file or create a heating profile first.');
      return false;
    }
    return this.startJob(startLine);
  }

  async startJob(startLine = 1): Promise<boolean> {
    const file = this.selectedJob();
    if (file === null) return false;
    if (!this.connected()) {
      this.notify('Connect the controller before starting a job.');
      return false;
    }
    if (this.busy()) {
      this.notify('Another operation already owns the controller.');
      return false;
    }
    this.disarmControl();
    if (this.api !== undefined) {
      const request = createJobStartRequest(
        file,
        startLine,
        this.selectedProgram(),
        this.settings().commandTimeoutMs,
      );
      const result = await this.api.jobs.start(request);
      if (result.ok) {
        this.job.set(result.value);
        return true;
      } else this.notify(result.error.message);
      return false;
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
    return true;
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
    if (this.api === undefined) {
      this.configuration.patchSettings(patch);
      if (patch.theme !== undefined) this.applyTheme(patch.theme);
      this.notify('Settings saved for this demo session.');
      return;
    }
    const result = await this.api.settings.update(patch);
    if (result.ok) {
      this.configuration.applySettings(result.value);
      if (patch.theme !== undefined) this.applyTheme(result.value.theme);
    } else this.notify(result.error.message);
  }

  async refreshCatalog(): Promise<void> {
    await this.sessionCatalog.refreshCatalog();
  }

  async revokeCatalogHost(host: string): Promise<void> {
    await this.sessionCatalog.revokeCatalogHost(host);
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
    const profile = this.configuration.createProfile(name, kind, state, data as JsonValue);
    if (this.api === undefined) {
      this.configuration.addProfile(profile);
      this.notify(`${profile.name} saved in the browser demo.`);
      return profile;
    }
    const result = await this.api.profiles.save(profile);
    if (result.ok) {
      this.configuration.replaceProfile(result.value);
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
      if (refreshed.ok) this.configuration.replaceProfiles(refreshed.value);
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
      this.configuration.removeProfile(id);
      return;
    }
    const result = await this.api.profiles.remove(id);
    if (result.ok) this.configuration.removeProfile(id);
    else this.notify(result.error.message);
  }

  async saveTerminalSession(): Promise<string | null> {
    return this.sessionCatalog.saveSession(
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
    return this.sessionCatalog.saveSession(
      'simulation',
      `Simulation · ${new Date().toLocaleString()}`,
      data,
    );
  }

  async exportTerminalSession(format: 'json' | 'csv'): Promise<void> {
    const id = await this.saveTerminalSession();
    if (id === null || this.api === undefined) return;
    await this.sessionCatalog.exportSessions([id], format);
  }

  async exportSessions(ids: readonly string[], format: 'json' | 'csv'): Promise<void> {
    await this.sessionCatalog.exportSessions(ids, format);
  }

  async refreshSessions(): Promise<void> {
    await this.sessionCatalog.refreshSessions();
  }

  notify(message: string): void {
    this.notifications.show(message);
  }

  private async loadSettings(): Promise<void> {
    if (this.api === undefined) return;
    const result = await this.api.settings.get();
    if (result.ok) {
      this.configuration.applySettings(result.value);
      this.applyTheme(result.value.theme);
      if (result.value.lastSerialPort !== null) this.selectedPort.set(result.value.lastSerialPort);
    }
  }

  private clearUnavailableSelectedPort(): void {
    this.serialTelemetry.clearSelectionIfUnavailable();
  }

  private async loadDesktopState(): Promise<void> {
    if (this.api === undefined) return;
    const [job, activity, catalog, systemInfo, tuning, sessions, profiles] = await Promise.all([
      this.api.jobs.getState(),
      this.api.activity.get(),
      this.api.catalog.get(),
      this.api.system.getInfo(),
      this.api.tuning.getState(),
      this.api.sessions.list(),
      this.api.profiles.list(),
    ]);
    await this.serialTelemetry.loadState();
    if (job.ok) this.job.set(job.value);
    if (activity.ok) this.activity.set(activity.value);
    if (catalog.ok) this.sessionCatalog.replaceCatalog(catalog.value);
    if (systemInfo.ok) this.systemInfo.set(systemInfo.value);
    if (tuning.ok) this.liveTuning.set(tuning.value);
    if (sessions.ok) this.sessionCatalog.replaceSessions(sessions.value);
    if (profiles.ok) this.configuration.replaceProfiles(profiles.value);
  }

  private registerDesktopEvents(): void {
    if (this.api === undefined) return;
    this.serialTelemetry.initialize(
      (state) => this.consumeSerialState(state),
      (event) => this.consumeTelemetry(event),
      () => undefined,
      (message) => this.notify(message),
    );
    this.unsubscribe.push(
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
    );
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
      this.resetPhysicalControlModel();
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
    const measuredTemperatureC = this.hasTelemetry()
      ? this.telemetry().average
      : this.ovenModelProfile().ambientTemperatureC;
    const observer = this.physicalTwinObserver;
    let shaped: PhysicalForecastPlan;
    const requestedTargetC = this.requestedTarget();
    const forecastDue =
      force ||
      this.lastPhysicalForecastPlan === null ||
      this.lastPhysicalForecastAtMs === null ||
      requestedTargetC !== this.lastPhysicalForecastRequestC ||
      now - this.lastPhysicalForecastAtMs >= PHYSICAL_FORECAST_REPLAN_SECONDS * 1_000;
    if (
      domainMode === 'model-assisted-pid' &&
      observer !== null &&
      this.hasTelemetry() &&
      this.connected() &&
      this.controlArmed() &&
      this.activity().active === null &&
      this.job().status !== 'streaming' &&
      this.job().status !== 'pause-pending' &&
      forecastDue
    ) {
      this.physicalForecastPlanner ??= createPhysicalForecastPlanner({
        configuration: this.modelAssistance(),
        initialTargetC: this.targetShaperState.trajectoryTargetC,
      });
      const estimatedPidState = setFirmwareQuickPidTunings(
        this.physicalFirmwarePidState ??
          createFirmwareQuickPidState({
            measurementC: measuredTemperatureC,
            output: this.telemetry().power,
            tunings: this.activePidGains(),
          }),
        this.activePidGains(),
      );
      this.physicalFirmwarePidState = estimatedPidState;
      const forecastElapsedSeconds =
        this.lastPhysicalForecastAtMs === null
          ? stepSeconds
          : Math.max(0.1, (now - this.lastPhysicalForecastAtMs) / 1_000);
      shaped = this.physicalForecastPlanner.plan({
        mode: domainMode,
        source: observer,
        firmwarePidState: estimatedPidState,
        requestedTargetC,
        stepSeconds: forecastElapsedSeconds,
      });
      this.lastPhysicalForecastAtMs = now;
      this.lastPhysicalForecastRequestC = requestedTargetC;
      this.lastPhysicalForecastPlan = shaped;
    } else if (
      domainMode === 'model-assisted-pid' &&
      this.lastPhysicalForecastPlan !== null &&
      observer !== null &&
      this.hasTelemetry()
    ) {
      shaped = this.lastPhysicalForecastPlan;
    } else {
      shaped = stepPhysicalFeedForward({
        mode: domainMode,
        profile: this.ovenModelProfile(),
        configuration: this.modelAssistance(),
        state: this.targetShaperState,
        requestedTargetC,
        measuredTemperatureC,
        measuredPidOutput: this.hasTelemetry() ? this.telemetry().power : 0,
        activeGains: this.activePidGains(),
        stepSeconds,
      });
    }
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
    this.selectProgram({
      file: demoFile,
      kind: 'heating-profile',
      profile: {
        version: 1,
        name: 'Standard load 200 °C',
        interpolation: 'linear',
        points: [
          { timeMs: 0, targetC: 25 },
          { timeMs: 4 * 60_000, targetC: 120 },
          { timeMs: 10 * 60_000, targetC: 180 },
          { timeMs: 18 * 60_000, targetC: 200 },
          { timeMs: 28 * 60_000, targetC: 200 },
          { timeMs: 36 * 60_000, targetC: 0 },
        ],
      },
      metadataWarning: null,
    });
    this.job.set({ ...DEFAULT_JOB, file: demoFile });
    this.configuration.replaceProfiles(this.demoProfiles());
  }

  private consumeTelemetry(event: TemperatureTelemetry): void {
    this.telemetry.set(event);
    this.hasTelemetry.set(true);
    this.observePhysicalTwin(event);
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

  private observePhysicalTwin(event: TemperatureTelemetry): void {
    const observedAtMs = Date.parse(event.timestamp);
    const timestampMs = Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
    const sensors = {
      t1C: event.thermistors[0],
      t2C: event.thermistors[1],
      t3C: event.thermistors[2],
    };
    const elapsedSeconds =
      this.lastPhysicalObservationAtMs === null
        ? 0
        : Math.max(0, (timestampMs - this.lastPhysicalObservationAtMs) / 1_000);
    if (this.physicalTwinObserver === null) {
      this.physicalTwinObserver = createPhysicalTwinObserver({
        profile: this.ovenModelProfile(),
        initialTemperatureC: event.average,
        initialSensorsC: sensors,
      });
      this.physicalForecastPlanner = null;
      this.lastPhysicalForecastAtMs = null;
      this.lastPhysicalForecastRequestC = null;
      this.lastPhysicalForecastPlan = null;
    } else {
      this.physicalTwinObserver.observe({
        ...sensors,
        elapsedSeconds,
        appliedPwm8: this.lastObservedPwm8,
      });
    }
    this.observeFirmwarePid(event, elapsedSeconds);
    this.lastPhysicalObservationAtMs = timestampMs;
    this.lastObservedPwm8 = Math.min(255, Math.max(0, Math.trunc(event.power)));
  }

  private observeFirmwarePid(event: TemperatureTelemetry, elapsedSeconds: number): void {
    const currentMeasurementC = event.average;
    if (this.physicalFirmwarePidState === null) {
      this.physicalFirmwarePidState = assimilateFirmwareQuickPidObservation(
        createFirmwareQuickPidState({
          measurementC: currentMeasurementC,
          output: event.power,
          tunings: this.activePidGains(),
        }),
        {
          setpointC: event.target,
          measurementC: currentMeasurementC,
          output: event.power,
        },
      );
      this.lastPhysicalPidMeasurementC = currentMeasurementC;
      this.physicalPidRemainderSeconds = 0;
      return;
    }

    let state = setFirmwareQuickPidTunings(this.physicalFirmwarePidState, this.activePidGains());
    const previousMeasurementC = this.lastPhysicalPidMeasurementC ?? currentMeasurementC;
    const availableSeconds = this.physicalPidRemainderSeconds + elapsedSeconds;
    const sampleCount = Math.floor((availableSeconds + 1e-9) / 0.1);
    for (let index = 0; index < sampleCount; index += 1) {
      const fraction = sampleCount === 0 ? 1 : (index + 1) / sampleCount;
      const measurementC =
        previousMeasurementC + (currentMeasurementC - previousMeasurementC) * fraction;
      state = stepFirmwareQuickPid(state, {
        setpointC: event.target,
        measurementC,
        elapsedSeconds: 0.1,
      }).state;
    }
    this.physicalPidRemainderSeconds = Math.max(0, availableSeconds - sampleCount * 0.1);
    this.physicalFirmwarePidState = assimilateFirmwareQuickPidObservation(state, {
      setpointC: event.target,
      measurementC: currentMeasurementC,
      output: event.power,
    });
    this.lastPhysicalPidMeasurementC = currentMeasurementC;
  }

  private resetPhysicalControlModel(): void {
    this.physicalForecastPlanner = null;
    this.lastPhysicalForecastAtMs = null;
    this.lastPhysicalForecastRequestC = null;
    this.lastPhysicalForecastPlan = null;
    this.physicalTwinObserver = null;
    this.physicalFirmwarePidState = null;
    this.physicalPidRemainderSeconds = 0;
    this.lastPhysicalPidMeasurementC = null;
    this.lastPhysicalObservationAtMs = null;
    this.lastObservedPwm8 = 0;
  }

  private async completeDemoValidation(targetC: number): Promise<void> {
    if (this.validation().status !== 'running') return;
    const initial = this.telemetry().average;
    this.validationSamples = this.demoThermalTrace(240, 1, initial, targetC).map((sample) => ({
      atMs: sample.timeSeconds * 1_000,
      t0C: sample.average,
      t1C: sample.t1,
      t2C: sample.t2,
      t3C: sample.t3,
      reportedTargetC: targetC,
      output: sample.power,
    }));
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
    await this.sessionCatalog.saveSession(
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
    const durationSeconds = 89 * 5;
    return this.demoThermalTrace(
      durationSeconds,
      5,
      this.ovenModelProfile().ambientTemperatureC,
      200,
    ).map((sample) => ({
      time: now - (durationSeconds - sample.timeSeconds) * 1_000,
      average: sample.average,
      t1: sample.t1,
      t2: sample.t2,
      t3: sample.t3,
      target: 200,
      modelTarget: 200,
      power: sample.power,
    }));
  }

  /** Static browser-demo data; real thermal runs are always owned by selected Wasm firmware. */
  private demoThermalTrace(
    durationSeconds: number,
    sampleEverySeconds: number,
    initialTemperatureC: number,
    targetC: number,
  ): readonly {
    timeSeconds: number;
    average: number;
    t1: number;
    t2: number;
    t3: number;
    power: number;
  }[] {
    const ambientC = this.ovenModelProfile().ambientTemperatureC;
    const sampleCount = Math.round(durationSeconds / sampleEverySeconds);
    return Array.from({ length: sampleCount + 1 }, (_, index) => {
      const timeSeconds = index * sampleEverySeconds;
      const progress = 1 - Math.exp(-timeSeconds / 150);
      const projectedAverage = initialTemperatureC + (targetC - initialTemperatureC) * progress;
      const sensorSpread = 0.6 * Math.sin(timeSeconds / 35);
      const t1 = projectedAverage + sensorSpread;
      const t2 = projectedAverage - sensorSpread;
      const average = (t1 + t2) / 2;
      return {
        timeSeconds,
        average,
        t1,
        t2,
        t3: ambientC + (average - ambientC) * 0.08,
        power: Math.max(0, Math.min(255, Math.round(255 * (1 - progress * 0.85)))),
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
    if (result.ok) this.selectProgram(result.value);
    else this.notify(result.error.message);
  }

  private selectProgram(program: LoadedGcodeProgram): void {
    this.selectedProgram.set(program);
    this.selectedJob.set(program.file);
    this.heatingProfileDraft.set(
      program.kind === 'heating-profile' && program.profile !== null
        ? cloneHeatingProfile(program.profile)
        : null,
    );
    this.heatingProfileDirty.set(false);
  }
}

function cloneHeatingProfile(profile: HeatingProfile): HeatingProfile {
  return {
    version: 1,
    name: profile.name,
    interpolation: 'linear',
    points: profile.points.map((point) => ({ ...point })),
  };
}

function validateHeatingProfileDraft(profile: HeatingProfile | null): HeatingProfileValidation {
  if (profile === null) return { valid: false, error: 'No heating profile is loaded.' };
  try {
    validateHeatingProfile(profile);
    return { valid: true, error: null };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'The heating profile is invalid.',
    };
  }
}

export function createJobStartRequest(
  file: JobFileInfo,
  startLine: number,
  program: LoadedGcodeProgram | null,
  configuredTimeoutMs: number,
): JobStartRequest {
  return program?.kind === 'heating-profile'
    ? {
        path: file.path,
        startLine,
        commandTimeoutMs: Math.max(configuredTimeoutMs, 8_000),
      }
    : { path: file.path, startLine };
}
