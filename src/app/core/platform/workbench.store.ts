import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
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
  createPhysicalForecastPlanner,
  createPhysicalTwinObserver,
  stepPhysicalFeedForward,
  type OvenModelProfile,
  type PhysicalForecastPlan,
  type PhysicalForecastPlanner,
  type PhysicalTwinObserver,
} from '../simulation';
import { NotificationStore } from './notification.store';
import { ConfigurationStore } from '../configuration/configuration.store';
import { SessionCatalogStore } from './session-catalog.store';
import { SerialTelemetryStore } from './serial-telemetry.store';
import { HeaterControlStore } from './heater-control.store';
import { JobsProgramsStore } from './jobs-programs.store';
import { TuningValidationStore } from './tuning-validation.store';

export type DemoState =
  'disconnected' | 'monitoring' | 'streaming' | 'simulation' | 'tuning' | 'terminal' | 'error';

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

@Injectable({ providedIn: 'root' })
export class WorkbenchStore implements OnDestroy {
  private readonly configuration = inject(ConfigurationStore);
  private readonly notifications = inject(NotificationStore);
  private readonly sessionCatalog = inject(SessionCatalogStore);
  private readonly serialTelemetry = inject(SerialTelemetryStore);
  private readonly heaterControl = inject(HeaterControlStore);
  private readonly jobsPrograms = inject(JobsProgramsStore);
  private readonly tuningValidation = inject(TuningValidationStore);
  private readonly document = inject(DOCUMENT);
  private readonly api: GcodeApi | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { readonly gcode?: GcodeApi }).gcode;
  private readonly unsubscribe: Array<() => void> = [];
  private initializePromise: Promise<void> | null = null;
  private destroyed = false;
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
  private terminalId = 0;
  private observedPhysicalConfigurationRevision: number | undefined;
  private readonly physicalConfigurationEffect = effect(() => {
    const revision = this.configuration.physicalConfigurationRevision();
    if (this.observedPhysicalConfigurationRevision === undefined) {
      this.observedPhysicalConfigurationRevision = revision;
      return;
    }
    if (revision === this.observedPhysicalConfigurationRevision || this.destroyed) return;
    this.observedPhysicalConfigurationRevision = revision;
    this.resetPhysicalControlModel();
    this.tuningValidation.invalidatePhysicalConfiguration();
  });

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
  readonly requestedTarget = this.heaterControl.requestedTarget;
  readonly modelTarget = this.heaterControl.modelTarget;
  readonly controlMode = this.heaterControl.controlMode;
  /** The in-memory Wasm artifact paired with the persisted sketch path. */
  readonly firmwareInLoop = this.configuration.firmwareInLoop;
  readonly firmwareInLoopHardware = this.configuration.firmwareInLoopHardware;
  readonly firmwareInLoopBuilding = this.configuration.firmwareInLoopBuilding;
  readonly controlArmed = this.heaterControl.controlArmed;
  readonly pidSchedule = this.heaterControl.pidSchedule;
  readonly activePidGains = this.heaterControl.activePidGains;
  readonly ovenModelProfile = this.configuration.ovenModelProfile;
  readonly modelAssistance = this.heaterControl.modelAssistance;
  readonly activeProfile = signal('Standard oven model');
  readonly activity = signal<ExclusiveActivityState>({ active: null });
  readonly trend = signal<readonly TrendPoint[]>([]);
  readonly terminal = this.serialTelemetry.terminal;
  readonly commandHistory = this.serialTelemetry.commandHistory;
  readonly selectedProgram = this.jobsPrograms.selectedProgramForCompatibility;
  readonly selectedJob = this.jobsPrograms.selectedJobForCompatibility;
  readonly heatingProfileDraft = this.jobsPrograms.heatingProfileDraftForCompatibility;
  readonly heatingProfileDirty = this.jobsPrograms.heatingProfileDirtyForCompatibility;
  readonly job = this.jobsPrograms.jobForCompatibility;
  readonly jobTimeout = this.jobsPrograms.jobTimeoutForCompatibility;
  readonly liveTuning = this.tuningValidation.liveTuningForCompatibility;
  readonly validation = this.tuningValidation.validation;
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
  readonly heatingProfileValidation = this.jobsPrograms.heatingProfileValidation;

  initialize(): Promise<void> {
    if (this.initializePromise !== null) return this.initializePromise;
    this.initializePromise = this.initializeOnce();
    return this.initializePromise;
  }

  private async initializeOnce(): Promise<void> {
    if (this.initialized()) return;
    this.initialized.set(true);
    this.jobsPrograms.configure({
      busy: () => this.activity().active !== null || ACTIVE_JOB_STATUSES.has(this.job().status),
      connected: () => this.connected(),
      disarm: () => this.disarmControl(),
      refreshSessions: () => this.refreshSessions(),
      stopHeating: () => this.stopHeating(),
      commandTimeoutMs: () => this.settings().commandTimeoutMs,
    });
    this.tuningValidation.configure({
      connected: () => this.connected(),
      beginExclusive: (activity) => this.beginExclusive(activity),
      endExclusive: (activity) => this.endExclusive(activity),
      disarm: () => this.disarmControl(),
      prepareValidation: async (target, schedule) => {
        const validatedSchedule = createPidSchedule(schedule);
        this.pidSchedule.set(validatedSchedule);
        const gains = interpolatePidGains(validatedSchedule, target);
        this.activePidGains.set(gains);
        const gainsSent = await this.transmitControl(this.pidCommand(gains));
        return gainsSent && (await this.transmitControl(`M104 S${target.toFixed(1)}`));
      },
      requestHeaterOff: () => this.requestHeaterOff(),
      saveSession: (title, data, startedAt) =>
        this.sessionCatalog.saveSession('tuning', title, data, startedAt),
      refreshSessions: () => this.refreshSessions(),
      completeDemoValidation: (target) => this.completeDemoValidation(target),
    });
    this.jobsPrograms.initialize();
    this.tuningValidation.initialize();
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
    this.heaterControl.ngOnDestroy();
    this.serialTelemetry.ngOnDestroy();
    this.jobsPrograms.ngOnDestroy();
    this.tuningValidation.ngOnDestroy();
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
    if (!this.heaterControl.setMode(mode, this.firmwareInLoop() !== null)) return false;
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
    await this.heaterControl.applyTarget(Number(value), this.connected(), this.busy(), () =>
      this.advanceControl(true),
    );
  }

  async stopHeating(): Promise<void> {
    this.resetPhysicalControlModel();
    await this.heaterControl.stopHeating(this.connected(), () => this.requestHeaterOff());
  }

  async applyPidSchedule(schedule: PidSchedule): Promise<boolean> {
    return this.heaterControl.applyPidSchedule(schedule, this.connected(), this.busy());
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
    return this.tuningValidation.startBoundedValidation(targetC, schedule);
  }

  async cancelValidation(): Promise<void> {
    await this.tuningValidation.cancelValidation();
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
    try {
      validateTargetShaperConfiguration(assistance);
    } catch (error) {
      this.notify(error instanceof Error ? error.message : 'The oven model is invalid.');
      return false;
    }
    const result = this.configuration.activatePhysicalModelProfile(profile);
    if (!result.ok) {
      this.notify(result.errors.map((error) => `${error.path}: ${error.message}`).join('; '));
      return false;
    }
    const normalizedProfile = result.profile;
    this.heaterControl.setModelAssistance(assistance);
    this.activeProfile.set(normalizedProfile.name);
    this.heaterControl.setMode('model-assisted', true);
    this.resetPhysicalControlModel();
    this.targetShaperState = createTargetShaperState(this.modelTarget());
    this.notify(`${normalizedProfile.name} is now used for physical model-assisted control.`);
    return true;
  }

  async startLiveTuning(targets: readonly number[]): Promise<boolean> {
    return this.tuningValidation.startLiveTuning(targets);
  }

  async cancelLiveTuning(): Promise<void> {
    await this.tuningValidation.cancelLiveTuning();
  }

  clearTerminal(): void {
    this.terminal.set([]);
  }

  async chooseJob(): Promise<void> {
    return this.jobsPrograms.chooseJob();
    /*
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
    */
  }

  acceptDroppedFile(file: File): void {
    this.jobsPrograms.acceptDroppedFile(file);
    return;
    /*
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
    */
  }

  newHeatingProfile(): void {
    this.jobsPrograms.newHeatingProfile();
    return;
    /*
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
    */
  }

  updateHeatingProfileName(name: string): void {
    this.jobsPrograms.updateHeatingProfileName(name);
    return;
    /*
    if (this.busy()) return;
    this.heatingProfileDraft.update((profile) =>
      profile === null ? null : { ...profile, name: String(name) },
    );
    this.heatingProfileDirty.set(true);
    */
  }

  updateHeatingProfilePoint(index: number, patch: Partial<HeatingProfile['points'][number]>): void {
    this.jobsPrograms.updateHeatingProfilePoint(index, patch);
    return;
    /*
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
    */
  }

  addHeatingProfilePoint(afterIndex: number): number {
    return this.jobsPrograms.addHeatingProfilePoint(afterIndex);
    /*
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
    */
  }

  removeHeatingProfilePoint(index: number): void {
    this.jobsPrograms.removeHeatingProfilePoint(index);
    return;
    /*
    if (this.busy()) return;
    this.heatingProfileDraft.update((profile) => {
      if (profile === null || profile.points.length <= 2 || index <= 0) return profile;
      return { ...profile, points: profile.points.filter((_, pointIndex) => pointIndex !== index) };
    });
    this.heatingProfileDirty.set(true);
    */
  }

  async saveHeatingProfile(): Promise<LoadedGcodeProgram | null> {
    return this.jobsPrograms.saveHeatingProfile();
    /*
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
    */
  }

  async runLoadedProgram(startLine = 1): Promise<boolean> {
    return this.jobsPrograms.runLoadedProgram(startLine);
    /*
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
    */
  }

  async startJob(startLine = 1): Promise<boolean> {
    return this.jobsPrograms.startJob(startLine);
    /*
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
    */
  }

  async pauseOrResumeJob(): Promise<void> {
    return this.jobsPrograms.pauseOrResumeJob();
    /*
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
    */
  }

  async stopJob(): Promise<void> {
    return this.jobsPrograms.stopJob();
    /*
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
    */
  }

  async resolveJobTimeout(decision: JobTimeoutDecision): Promise<void> {
    return this.jobsPrograms.resolveJobTimeout(decision);
    /*
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
    */
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
    if (job.ok) this.jobsPrograms.replaceJob(job.value);
    if (activity.ok) this.activity.set(activity.value);
    if (catalog.ok) this.sessionCatalog.replaceCatalog(catalog.value);
    if (systemInfo.ok) this.systemInfo.set(systemInfo.value);
    if (tuning.ok) this.tuningValidation.replaceTuning(tuning.value);
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
    this.unsubscribe.push(this.api.events.onActivity((state) => this.activity.set(state)));
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
        void this.tuningValidation.failValidation('The controller disconnected during validation.');
      }
    }
  }

  private disarmControl(): void {
    this.heaterControl.disarm();
    this.lastFirmwareTargetSent = null;
    this.lastGainsSent = null;
  }

  private pidCommand(gains: PidGains): string {
    return `M301 P${gains.kp.toFixed(3)} I${gains.ki.toFixed(3)} D${gains.kd.toFixed(3)}`;
  }

  private startControlLoop(): void {
    this.lastControlTick = performance.now();
    this.heaterControl.initialize(DEFAULT_PID_SCHEDULE, () => void this.advanceControl(false));
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

    const generation = this.heaterControl.generation;
    this.controlWriteInFlight = true;
    try {
      if (force || gainsChanged) {
        const command = this.pidCommand(transitionedGains);
        if (
          generation === this.heaterControl.generation &&
          this.controlArmed() &&
          (await this.transmitControl(command))
        ) {
          this.lastGainsSent = transitionedGains;
        }
      }
      if (
        (force || targetChanged) &&
        generation === this.heaterControl.generation &&
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
    if (state === 'terminal') {
      this.seedTerminalFixture();
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
      this.tuningValidation.replaceTuning({
        id: 'demo-live-tune',
        status: 'cooling',
        startedAt: new Date(DEMO_FIXTURE_TIME_MS - 542_000).toISOString(),
        currentTarget: 150,
        currentBreakpointIndex: 1,
        peaksCollected: 5,
        peakGoal: 12,
        rollbackGains: { kp: 18.2, ki: 0.73, kd: 82 },
        results: [],
        endedAt: null,
        error: null,
      });
    }
  }

  private parseDemoState(value: string | null): DemoState | null {
    return value === 'disconnected' ||
      value === 'monitoring' ||
      value === 'streaming' ||
      value === 'simulation' ||
      value === 'tuning' ||
      value === 'terminal' ||
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

  private seedTerminalFixture(): void {
    const entries: TerminalEntry[] = [];
    for (let index = 1; index <= 140; index += 1) {
      entries.push(
        this.entry(
          'terminal',
          index % 3 === 0 ? 'tx' : 'rx',
          index % 3 === 0
            ? `M105 ; deterministic terminal command ${index}`
            : `T0:${180 + (index % 10) / 10} /200.0 @:${120 + (index % 40)}`,
        ),
      );
    }
    this.terminal.set(entries);
    this.commandHistory.set(['M105', 'M115', 'M503']);
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
    this.tuningValidation.consumeTelemetry(event);
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

  private async requestHeaterOff(): Promise<string | null> {
    if (this.api === undefined) {
      this.appendTerminal(this.entry('system', 'tx', 'M104 S0'));
      return null;
    }
    const result = await this.api.serial.heaterOff();
    return result.ok ? null : result.error.message;
  }

  private async completeDemoValidation(targetC: number): Promise<void> {
    const initial = this.telemetry().average;
    const events: TemperatureTelemetry[] = this.demoThermalTrace(240, 1, initial, targetC).map(
      (sample) => ({
        timestamp: new Date(Date.now() + sample.timeSeconds * 1_000).toISOString(),
        average: sample.average,
        target: targetC,
        power: sample.power,
        thermistors: [sample.t1, sample.t2, sample.t3],
        raw: `T0:${sample.average.toFixed(1)} /${targetC.toFixed(1)} @:${sample.power}`,
      }),
    );
    await this.tuningValidation.completeDemoValidation(events);
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
