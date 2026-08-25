import { Injectable, signal, computed, inject } from '@angular/core';
import type { OnDestroy, Signal, WritableSignal } from '@angular/core';
import type {
  GcodeApi,
  HeatingProfile,
  JobFileInfo,
  JobStartRequest,
  JobState,
  JobTimeoutDecision,
  JobTimeoutEvent,
  LoadedGcodeProgram,
} from '../../../../shared/contracts';
import { validateHeatingProfile } from '../../../../shared/heating-profile-document';
import { NotificationStore } from './notification.store';

export interface HeatingProfileValidation {
  readonly valid: boolean;
  readonly error: string | null;
}

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

const MAX_PROFILE_DURATION_MS = 24 * 60 * 60_000;
const MAX_PROFILE_POINTS = 128;
const DEMO_FIXTURE_TIME_MS = Date.UTC(2026, 7, 15, 12, 0, 0);
const DEMO_FIXTURE_TIME_ISO = new Date(DEMO_FIXTURE_TIME_MS).toISOString();

/** Owns programs, editable heating profiles, and the renderer's job lifecycle. */
@Injectable({ providedIn: 'root' })
export class JobsProgramsStore implements OnDestroy {
  private readonly notifications = inject(NotificationStore);
  private readonly api: GcodeApi | undefined =
    typeof window === 'undefined' ? undefined : window.gcode;
  private readonly jobState = signal<JobState>(DEFAULT_JOB);
  private readonly timeoutState = signal<JobTimeoutEvent | null>(null);
  private readonly selectedProgramState = signal<LoadedGcodeProgram | null>(null);
  private readonly selectedJobState = signal<JobFileInfo | null>(null);
  private readonly profileState = signal<HeatingProfile | null>(null);
  private readonly profileDirtyState = signal(false);
  private readonly unsubscribe: Array<() => void> = [];
  private busyPredicate: () => boolean = () => false;
  private connectedPredicate: () => boolean = () => false;
  private disarm: () => void = () => undefined;
  private refreshSessions: () => Promise<void> = async () => undefined;
  private stopHeating: () => Promise<void> = async () => undefined;
  private commandTimeoutMs: () => number = () => 8_000;

  readonly job: Signal<JobState> = this.jobState.asReadonly();
  readonly jobTimeout: Signal<JobTimeoutEvent | null> = this.timeoutState.asReadonly();
  readonly selectedProgram: Signal<LoadedGcodeProgram | null> =
    this.selectedProgramState.asReadonly();
  readonly selectedJob: Signal<JobFileInfo | null> = this.selectedJobState.asReadonly();
  readonly heatingProfileDraft: Signal<HeatingProfile | null> = this.profileState.asReadonly();
  readonly heatingProfileDirty: Signal<boolean> = this.profileDirtyState.asReadonly();
  readonly heatingProfileValidation = computed<HeatingProfileValidation>(() =>
    validateHeatingProfileDraft(this.profileState()),
  );
  /** Temporary compatibility handles for the coordinator's existing test/demo seam. */
  readonly selectedProgramForCompatibility: WritableSignal<LoadedGcodeProgram | null> =
    this.selectedProgramState;
  readonly selectedJobForCompatibility: WritableSignal<JobFileInfo | null> = this.selectedJobState;
  readonly heatingProfileDraftForCompatibility: WritableSignal<HeatingProfile | null> =
    this.profileState;
  readonly heatingProfileDirtyForCompatibility: WritableSignal<boolean> = this.profileDirtyState;
  readonly jobForCompatibility: WritableSignal<JobState> = this.jobState;
  readonly jobTimeoutForCompatibility: WritableSignal<JobTimeoutEvent | null> = this.timeoutState;

  configure(options: {
    busy: () => boolean;
    connected: () => boolean;
    disarm: () => void;
    refreshSessions: () => Promise<void>;
    stopHeating: () => Promise<void>;
    commandTimeoutMs: () => number;
  }): void {
    this.busyPredicate = options.busy;
    this.connectedPredicate = options.connected;
    this.disarm = options.disarm;
    this.refreshSessions = options.refreshSessions;
    this.stopHeating = options.stopHeating;
    this.commandTimeoutMs = options.commandTimeoutMs;
  }

  initialize(): void {
    if (this.api === undefined || this.unsubscribe.length > 0) return;
    this.unsubscribe.push(
      this.api.events.onJobState((state) => {
        this.jobState.set(state);
        if (
          state.status === 'completed' ||
          state.status === 'stopped' ||
          state.status === 'failed'
        ) {
          window.setTimeout(() => void this.refreshSessions(), 750);
        }
      }),
      this.api.events.onJobTimeout((event) => this.timeoutState.set(event)),
    );
  }

  replaceJob(state: JobState): void {
    this.jobState.set(state);
  }

  replaceTimeout(event: JobTimeoutEvent | null): void {
    this.timeoutState.set(event);
  }

  selectProgram(program: LoadedGcodeProgram): void {
    this.selectedProgramState.set(program);
    this.selectedJobState.set(program.file);
    this.profileState.set(
      program.kind === 'heating-profile' && program.profile !== null
        ? cloneHeatingProfile(program.profile)
        : null,
    );
    this.profileDirtyState.set(false);
  }

  async chooseJob(): Promise<void> {
    if (this.busyPredicate())
      return void this.notifications.show(
        'Wait for the active operation to finish before loading another file.',
      );
    if (this.api === undefined) {
      const file: JobFileInfo = {
        path: 'C:\\Jobs\\ordinary-demo.gcode',
        name: 'ordinary-demo.gcode',
        sizeBytes: 42_240,
        modifiedAt: DEMO_FIXTURE_TIME_ISO,
        extension: '.gcode',
      };
      this.selectProgram({ file, kind: 'gcode', profile: null, metadataWarning: null });
      return void this.notifications.show(
        'Demo G-code selected. Native file picking is available in the desktop app.',
      );
    }
    const result = await this.api.jobs.pickFile();
    if (result.ok && result.value !== null) this.selectProgram(result.value);
    else if (!result.ok) this.notifications.show(result.error.message);
  }

  acceptDroppedFile(file: File): void {
    if (this.busyPredicate())
      return void this.notifications.show(
        'Wait for the active operation to finish before loading another file.',
      );
    if (this.api !== undefined)
      return void this.inspectDroppedPath(this.api.jobs.resolveDroppedFile(file));
    const extension = file.name.toLowerCase().match(/(\.gcode|\.gco|\.gc|\.txt)$/)?.[1] as
      JobFileInfo['extension'] | undefined;
    if (extension === undefined)
      return void this.notifications.show('Use a .gcode, .gco, .gc, or .txt file.');
    this.selectProgram({
      file: {
        path: file.name,
        name: file.name,
        sizeBytes: file.size,
        modifiedAt: new Date(file.lastModified).toISOString(),
        extension,
      },
      kind: 'gcode',
      profile: null,
      metadataWarning: null,
    });
  }

  private async inspectDroppedPath(path: string): Promise<void> {
    if (this.api === undefined) return;
    const result = await this.api.jobs.inspectFile(path);
    if (result.ok) this.selectProgram(result.value);
    else this.notifications.show(result.error.message);
  }

  newHeatingProfile(): void {
    if (this.busyPredicate())
      return void this.notifications.show(
        'Wait for the active operation to finish before creating a profile.',
      );
    this.selectedProgramState.set(null);
    this.selectedJobState.set(null);
    this.profileState.set({
      version: 1,
      name: 'Untitled heating profile',
      interpolation: 'linear',
      points: [
        { timeMs: 0, targetC: 25 },
        { timeMs: 10 * 60_000, targetC: 180 },
        { timeMs: 20 * 60_000, targetC: 0 },
      ],
    });
    this.profileDirtyState.set(true);
    this.notifications.show('New heating profile ready to edit.');
  }

  updateHeatingProfileName(name: string): void {
    if (this.busyPredicate()) return;
    this.profileState.update((profile) =>
      profile === null ? null : { ...profile, name: String(name) },
    );
    this.profileDirtyState.set(true);
  }

  updateHeatingProfilePoint(index: number, patch: Partial<HeatingProfile['points'][number]>): void {
    if (this.busyPredicate()) return;
    this.profileState.update((profile) => {
      if (profile === null || index < 0 || index >= profile.points.length) return profile;
      const point = profile.points[index]!;
      const previous = profile.points[index - 1];
      const next = profile.points[index + 1];
      const minimum = index === 0 ? 0 : (previous?.timeMs ?? 0) + 1;
      const maximum = Math.min(
        MAX_PROFILE_DURATION_MS,
        next === undefined ? MAX_PROFILE_DURATION_MS : next.timeMs - 1,
      );
      return {
        ...profile,
        points: profile.points.map((current, pointIndex) =>
          pointIndex !== index
            ? current
            : {
                timeMs:
                  index === 0
                    ? 0
                    : Math.round(
                        Math.min(
                          maximum,
                          Math.max(minimum, Number(patch.timeMs ?? point.timeMs) || minimum),
                        ),
                      ),
                targetC: Math.round(
                  Math.min(250, Math.max(0, Number(patch.targetC ?? point.targetC) || 0)),
                ),
              },
        ),
      };
    });
    this.profileDirtyState.set(true);
  }

  addHeatingProfilePoint(afterIndex: number): number {
    if (this.busyPredicate()) return afterIndex;
    let insertedIndex = afterIndex;
    this.profileState.update((profile) => {
      if (profile === null) return null;
      if (profile.points.length >= MAX_PROFILE_POINTS) {
        this.notifications.show(`Heating profiles support up to ${MAX_PROFILE_POINTS} stages.`);
        return profile;
      }
      const index = Math.max(0, Math.min(profile.points.length - 1, afterIndex));
      const current = profile.points[index]!;
      const next = profile.points[index + 1];
      if (next !== undefined && next.timeMs - current.timeMs < 2) {
        this.notifications.show(
          'Move the neighboring stages apart before inserting another stage.',
        );
        return profile;
      }
      const point =
        next === undefined
          ? {
              timeMs: Math.min(MAX_PROFILE_DURATION_MS, current.timeMs + 5 * 60_000),
              targetC: Math.round(current.targetC),
            }
          : {
              timeMs: Math.round((current.timeMs + next.timeMs) / 2),
              targetC: Math.round((current.targetC + next.targetC) / 2),
            };
      if (point.timeMs <= current.timeMs) {
        this.notifications.show('The profile already reaches the 24-hour duration limit.');
        return profile;
      }
      insertedIndex = index + 1;
      return {
        ...profile,
        points: [
          ...profile.points.slice(0, insertedIndex),
          point,
          ...profile.points.slice(insertedIndex),
        ],
      };
    });
    this.profileDirtyState.set(true);
    return insertedIndex;
  }

  removeHeatingProfilePoint(index: number): void {
    if (this.busyPredicate()) return;
    this.profileState.update((profile) =>
      profile === null || profile.points.length <= 2 || index <= 0
        ? profile
        : { ...profile, points: profile.points.filter((_, pointIndex) => pointIndex !== index) },
    );
    this.profileDirtyState.set(true);
  }

  async saveHeatingProfile(): Promise<LoadedGcodeProgram | null> {
    if (this.busyPredicate()) {
      this.notifications.show('Wait for the active operation to finish before saving a profile.');
      return null;
    }
    const profile = this.profileState();
    const validation = this.heatingProfileValidation();
    if (profile === null || !validation.valid) {
      this.notifications.show(validation.error ?? 'Create a valid heating profile before saving.');
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
      const program = {
        file,
        kind: 'heating-profile' as const,
        profile: cloneHeatingProfile(profile),
        metadataWarning: null,
      };
      this.selectProgram(program);
      this.notifications.show(`${profile.name} saved in the browser demo.`);
      return program;
    }
    const result = await this.api.jobs.saveHeatingProfile(profile);
    if (result.ok && result.value !== null) {
      this.selectProgram(result.value);
      this.notifications.show(`${result.value.profile?.name ?? result.value.file.name} saved.`);
      return result.value;
    }
    if (!result.ok) this.notifications.show(result.error.message);
    return null;
  }

  async runLoadedProgram(startLine = 1): Promise<boolean> {
    if (this.profileState() !== null) {
      const validation = this.heatingProfileValidation();
      if (!validation.valid) {
        this.notifications.show(validation.error ?? 'The heating profile is invalid.');
        return false;
      }
      if (this.profileDirtyState() || this.selectedProgramState() === null)
        if ((await this.saveHeatingProfile()) === null) return false;
    }
    if (this.selectedProgramState() === null) {
      this.notifications.show('Load a G-code file or create a heating profile first.');
      return false;
    }
    return this.startJob(startLine);
  }

  async startJob(startLine = 1): Promise<boolean> {
    const file = this.selectedJobState();
    if (file === null) return false;
    if (!this.connectedPredicate()) {
      this.notifications.show('Connect the controller before starting a job.');
      return false;
    }
    if (this.busyPredicate()) {
      this.notifications.show('Another operation already owns the controller.');
      return false;
    }
    this.disarm();
    if (this.api !== undefined) {
      const request: JobStartRequest = createJobStartRequest(
        file,
        startLine,
        this.selectedProgramState(),
        this.commandTimeoutMs(),
      );
      const result = await this.api.jobs.start(request);
      if (result.ok) {
        this.jobState.set(result.value);
        return true;
      }
      this.notifications.show(result.error.message);
      return false;
    }
    this.jobState.set({
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
    const job = this.jobState();
    if (this.api !== undefined) {
      const result =
        job.status === 'paused'
          ? await this.api.jobs.resume()
          : await this.api.jobs.pauseAfterCurrent();
      if (result.ok) this.jobState.set(result.value);
      else this.notifications.show(result.error.message);
      return;
    }
    this.jobState.update((current) => ({
      ...current,
      status: current.status === 'paused' ? 'streaming' : 'paused',
      pauseRequested: false,
    }));
  }

  async stopJob(): Promise<void> {
    if (this.api !== undefined) {
      const result = await this.api.jobs.stop();
      if (result.ok) {
        this.jobState.set(result.value);
        await this.refreshSessions();
      } else this.notifications.show(result.error.message);
      return;
    }
    this.jobState.update((current) => ({
      ...current,
      status: 'stopped',
      endedAt: new Date().toISOString(),
    }));
    await this.stopHeating();
  }

  async resolveJobTimeout(decision: JobTimeoutDecision): Promise<void> {
    const timeout = this.timeoutState();
    if (timeout === null) return;
    if (this.api !== undefined) {
      const result = await this.api.jobs.resolveTimeout(timeout.decisionId, decision);
      if (result.ok) {
        this.jobState.set(result.value);
        this.timeoutState.set(null);
      } else this.notifications.show(result.error.message);
      return;
    }
    this.timeoutState.set(null);
    this.jobState.update((current) => ({
      ...current,
      status: decision === 'stop' ? 'stopped' : 'streaming',
      endedAt: decision === 'stop' ? new Date().toISOString() : null,
    }));
  }

  seedDemo(program: LoadedGcodeProgram): void {
    this.selectProgram(program);
    this.jobState.set({ ...DEFAULT_JOB, file: program.file });
  }

  ngOnDestroy(): void {
    this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
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

function createJobStartRequest(
  file: JobFileInfo,
  startLine: number,
  program: LoadedGcodeProgram | null,
  commandTimeoutMs: number,
): JobStartRequest {
  return program?.kind === 'heating-profile'
    ? { path: file.path, startLine, commandTimeoutMs: Math.max(commandTimeoutMs, 8_000) }
    : { path: file.path, startLine };
}
