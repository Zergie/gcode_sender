import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import type { OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { StoredProfile } from '../../../../shared/contracts';
import {
  createPidSchedule,
  interpolatePidGains,
  validateTargetShaperConfiguration,
  type ModelAssistedTargetConfiguration,
  type PidBreakpoint,
  type PidSchedule,
} from '../../core/control';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import {
  cloneOvenModelProfile,
  validateOvenModelProfile,
  type OvenModelProfile,
} from '../../core/simulation';
import { IconComponent } from '../../shared/icon';
import { PageHeaderComponent } from '../../shared/page-header';
import { SimulationComponent } from '../simulation/simulation';

interface EditableBreakpoint {
  readonly id: number;
  readonly temperatureC: number;
  readonly kp: number;
  readonly ki: number;
  readonly kd: number;
}

type TunePhase = 'setup' | 'running' | 'results';

@Component({
  selector: 'app-tuning',
  imports: [DatePipe, FormsModule, IconComponent, PageHeaderComponent, SimulationComponent],
  templateUrl: './tuning.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TuningComponent implements OnDestroy {
  readonly embedded = input(false);
  readonly store = inject(WorkbenchStore);
  readonly section = signal<'simulation' | 'schedule' | 'autotune' | 'profiles'>('simulation');
  readonly breakpoints = signal<readonly EditableBreakpoint[]>(
    this.store.pidSchedule().map((row, index) => ({
      id: index + 1,
      temperatureC: row.temperatureC,
      kp: row.gains.kp,
      ki: row.gains.ki,
      kd: row.gains.kd,
    })),
  );
  readonly profileName = signal('Standard load PID');
  readonly profileSearch = signal('');
  readonly tunePhase = signal<TunePhase>('setup');
  readonly tuneTargets = signal<readonly number[]>([100, 150, 200]);
  readonly supervised = signal(false);
  readonly tuneTargetIndex = signal(0);
  readonly peaks = signal(0);
  readonly tuneProgress = signal(0);
  readonly tuneMessage = signal('Ready to snapshot the current PID values.');
  private demoTuneTimer: ReturnType<typeof setInterval> | undefined;
  private nextId = this.breakpoints().length + 1;

  readonly validatedSchedule = computed<{ schedule: PidSchedule | null; error: string | null }>(
    () => {
      const rows = this.breakpointSchedule();
      if (rows.some((row) => row.temperatureC < 0 || row.temperatureC > 250)) {
        return { schedule: null, error: 'Breakpoint temperatures must be between 0 and 250 °C.' };
      }
      try {
        return { schedule: createPidSchedule(rows), error: null };
      } catch (error) {
        return {
          schedule: null,
          error: error instanceof Error ? error.message : 'The PID schedule is invalid.',
        };
      }
    },
  );
  readonly effectiveGains = computed(() => {
    const schedule = this.validatedSchedule().schedule;
    return schedule === null
      ? this.store.activePidGains()
      : interpolatePidGains(schedule, this.store.requestedTarget());
  });
  readonly tuneTargetsValid = computed(() => {
    const targets = this.tuneTargets();
    return targets.every(
      (target, index) =>
        Number.isFinite(target) &&
        target >= 1 &&
        target <= 250 &&
        (index === 0 || target > (targets[index - 1] ?? Number.NEGATIVE_INFINITY)),
    );
  });
  readonly scheduleRange = computed(() => {
    const schedule = this.validatedSchedule().schedule;
    const first = schedule?.[0]?.temperatureC;
    const last = schedule?.at(-1)?.temperatureC;
    return first === undefined || last === undefined ? '—' : `${first}–${last} °C`;
  });
  readonly currentTuneTarget = computed(
    () =>
      this.store.liveTuning().currentTarget ??
      this.tuneTargets()[this.tuneTargetIndex()] ??
      this.tuneTargets().at(-1) ??
      0,
  );
  readonly tunedRows = computed(() => {
    const liveResults = this.store.liveTuning().results;
    if (liveResults.length > 0) {
      return liveResults.map((result) => {
        const quick = result.candidates.find(
          (candidate) => candidate.method === 'klipper-ziegler-nichols',
        );
        const conservative = result.candidates.find(
          (candidate) => candidate.method === 'conservative',
        );
        return {
          temperature: result.target,
          kp: quick?.gains.kp ?? 0,
          ki: quick?.gains.ki ?? 0,
          kd: quick?.gains.kd ?? 0,
          conservativeKp: conservative?.gains.kp ?? 0,
          conservativeKi: conservative?.gains.ki ?? 0,
          conservativeKd: conservative?.gains.kd ?? 0,
        };
      });
    }
    if (this.store.demoState() === null) return [];
    return this.tuneTargets().map((temperature, index) => ({
      temperature,
      kp: 17.9 + index * 3.1,
      ki: 0.66 + index * 0.17,
      kd: 74.2 + index * 11.8,
      conservativeKp: 15.2 + index * 2.6,
      conservativeKi: 0.48 + index * 0.12,
      conservativeKd: 61.4 + index * 9.2,
    }));
  });

  readonly visibleProfiles = computed(() => {
    const query = this.profileSearch().trim().toLowerCase();
    return this.store
      .profiles()
      .filter(
        (profile) =>
          query.length === 0 ||
          profile.name.toLowerCase().includes(query) ||
          profile.kind.toLowerCase().includes(query),
      );
  });
  readonly resultPeakSummary = computed(() => {
    const results = this.store.liveTuning().results;
    if (results.length === 0) return this.store.demoState() === null ? 'No data' : '12 / 12 each';
    const minimum = Math.min(...results.map((result) => result.peaks.length));
    return `${minimum} / ${this.store.liveTuning().peakGoal} minimum`;
  });
  readonly resultKuSpread = computed(() => {
    const values = this.store
      .liveTuning()
      .results.map(
        (result) =>
          result.candidates.find((candidate) => candidate.method === 'klipper-ziegler-nichols')?.ku,
      )
      .filter((value): value is number => value !== undefined);
    if (values.length < 2) return this.store.demoState() === null ? 'Single target' : 'Demo trace';
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const spread = ((Math.max(...values) - Math.min(...values)) / Math.max(average, 1e-9)) * 100;
    return `${spread.toFixed(1)}% span`;
  });

  constructor() {
    if (!this.store.isDesktop() && this.store.demoState() === 'tuning') {
      this.section.set('autotune');
      this.tunePhase.set('running');
      this.tuneTargetIndex.set(1);
      this.peaks.set(5);
      this.tuneProgress.set(47);
      this.tuneMessage.set('DEMO · Cooling toward target − 5 °C; verifying @ output near 0.');
    }
    effect(() => {
      if (!this.store.isDesktop()) return;
      const state = this.store.liveTuning();
      if (state.status === 'idle') return;
      if (state.status === 'completed') {
        this.tunePhase.set('results');
        this.tuneProgress.set(100);
        this.tuneMessage.set('Twelve peaks captured at every target. Draft gains are ready.');
        return;
      }
      if (state.status === 'cancelled' || state.status === 'failed') {
        this.tunePhase.set('setup');
        this.tuneMessage.set(state.error?.message ?? 'Tune cancelled; rollback completed.');
        return;
      }
      this.tunePhase.set('running');
      this.tuneTargetIndex.set(state.currentBreakpointIndex);
      this.peaks.set(state.peaksCollected);
      const totalPeaks = Math.max(1, this.tuneTargets().length * state.peakGoal);
      this.tuneProgress.set(
        ((state.currentBreakpointIndex * state.peakGoal + state.peaksCollected) / totalPeaks) * 100,
      );
      const messages: Record<string, string> = {
        snapshotting: 'Reading and verifying rollback gains with M503…',
        heating: 'Heating toward the calibration target; verifying @ output near 255.',
        cooling: 'Cooling toward target − 5 °C; verifying @ output near 0.',
        'rolling-back': 'Restoring the captured firmware gains and requesting heater off…',
      };
      this.tuneMessage.set(messages[state.status] ?? state.status);
    });
  }

  ngOnDestroy(): void {
    this.stopDemoTune();
  }

  updateBreakpoint(id: number, key: keyof Omit<EditableBreakpoint, 'id'>, value: number): void {
    this.breakpoints.update((rows) =>
      rows.map((row) => (row.id === id ? { ...row, [key]: Number(value) } : row)),
    );
  }

  addBreakpoint(): void {
    const last = this.breakpoints().at(-1);
    this.breakpoints.update((rows) => [
      ...rows,
      {
        id: this.nextId++,
        temperatureC: Math.min(250, (last?.temperatureC ?? 50) + 25),
        kp: last?.kp ?? 10,
        ki: last?.ki ?? 0.5,
        kd: last?.kd ?? 50,
      },
    ]);
  }

  removeBreakpoint(id: number): void {
    if (this.breakpoints().length <= 1) return;
    this.breakpoints.update((rows) => rows.filter((row) => row.id !== id));
  }

  async applySchedule(): Promise<void> {
    const schedule = this.validatedSchedule().schedule;
    if (schedule === null) {
      this.store.notify(this.validatedSchedule().error ?? 'The PID schedule is invalid.');
      return;
    }
    const applied = await this.store.applyPidSchedule(schedule);
    if (!applied) return;
    await this.store.saveProfile(this.profileName(), 'pid-schedule', 'applied', schedule);
    this.store.notify('Interpolated gains applied to volatile firmware state. M500 was not sent.');
  }

  async saveDraft(): Promise<void> {
    const schedule = this.validatedSchedule().schedule;
    if (schedule === null) {
      this.store.notify(this.validatedSchedule().error ?? 'The PID schedule is invalid.');
      return;
    }
    await this.store.saveProfile(this.profileName(), 'pid-schedule', 'draft', schedule);
  }

  updateTuneTarget(index: number, value: number): void {
    this.tuneTargets.update((targets) =>
      targets.map((target, targetIndex) =>
        targetIndex === index ? Math.max(1, Math.min(250, Number(value))) : target,
      ),
    );
  }

  addTuneTarget(): void {
    const last = this.tuneTargets().at(-1) ?? 100;
    this.tuneTargets.update((targets) => [...targets, Math.min(250, last + 25)]);
  }

  removeTuneTarget(index: number): void {
    if (this.tuneTargets().length <= 1) return;
    this.tuneTargets.update((targets) => targets.filter((_, targetIndex) => targetIndex !== index));
  }

  async startLiveTune(): Promise<void> {
    if (!this.store.connected() || !this.supervised() || !this.tuneTargetsValid()) return;
    const started = await this.store.startLiveTuning(this.tuneTargets());
    if (!started) return;
    this.tunePhase.set('running');
    this.tuneTargetIndex.set(0);
    this.peaks.set(0);
    this.tuneProgress.set(2);
    this.tuneMessage.set('Reading rollback gains with M503…');
    if (this.store.isDesktop()) {
      this.tuneMessage.set(
        'Desktop coordinator is reading and verifying rollback gains with M503…',
      );
      return;
    }
    const snapshotRequested = await this.store.sendTuningCommand('M503');
    if (!snapshotRequested) {
      await this.abortTune('Could not request rollback gains.');
      return;
    }
    this.startDemoTune();
  }

  async abortTune(reason = 'Tune aborted by operator.'): Promise<void> {
    this.stopDemoTune();
    await this.store.cancelLiveTuning();
    this.tunePhase.set('setup');
    this.tuneMessage.set(reason);
    this.store.notify(reason);
  }

  async applyTuneResult(): Promise<void> {
    const schedule = this.tunedSchedule();
    if (schedule === null) return;
    const applied = await this.store.applyPidSchedule(schedule);
    if (!applied) return;
    await this.store.saveProfile('Live tune · Standard load', 'pid-schedule', 'applied', schedule);
    this.store.notify('The complete tuned schedule is active in volatile firmware state.');
  }

  async keepTuneDraft(): Promise<void> {
    const schedule = this.tunedSchedule();
    if (schedule === null) return;
    await this.store.saveProfile('Live tune · Standard load', 'pid-schedule', 'draft', schedule);
    this.store.notify('The complete tuned schedule was kept as a draft.');
  }

  async runValidation(): Promise<void> {
    const schedule = this.tunedSchedule();
    const target = schedule?.at(-1)?.temperatureC;
    if (schedule === null || target === undefined) return;
    await this.store.startBoundedValidation(target, schedule);
  }

  loadProfile(profile: StoredProfile): void {
    if (profile.kind === 'pid-schedule') {
      const schedule = this.profileSchedule(profile);
      if (schedule === null) return;
      this.breakpoints.set(
        schedule.map((row) => ({
          id: this.nextId++,
          temperatureC: row.temperatureC,
          kp: row.gains.kp,
          ki: row.gains.ki,
          kd: row.gains.kd,
        })),
      );
      this.profileName.set(profile.name);
      this.section.set('schedule');
      this.store.notify(`${profile.name} loaded into the PID editor.`);
      return;
    }
    if (profile.kind === 'simulation') {
      const data = profile.data as unknown as {
        profile?: OvenModelProfile;
        modelAssistance?: ModelAssistedTargetConfiguration;
      };
      try {
        if (data.profile === undefined || data.modelAssistance === undefined) throw new Error();
        const profile = cloneOvenModelProfile(data.profile);
        validateOvenModelProfile(profile);
        validateTargetShaperConfiguration(data.modelAssistance);
        this.store.useModelAssistedControl(profile, data.modelAssistance);
      } catch {
        this.store.notify('This simulation profile is not compatible with model version 1.');
      }
      return;
    }
    this.store.notify('Machine profiles are retained for reference and are not editable yet.');
  }

  profileNote(profile: StoredProfile): string {
    if (profile.kind === 'pid-schedule') {
      const schedule = this.profileSchedule(profile);
      return schedule === null
        ? 'Invalid PID schedule data'
        : `${schedule.length} breakpoint${schedule.length === 1 ? '' : 's'} · Standard load`;
    }
    if (profile.kind === 'simulation') return 'Dual-zone oven model · model assistance';
    return 'STM32 oven controller';
  }

  removeProfile(profile: StoredProfile): void {
    if (window.confirm(`Delete profile revision “${profile.name}”?`)) {
      void this.store.removeProfile(profile.id);
    }
  }

  exportAllProfiles(): void {
    void this.store.exportProfiles(this.store.profiles().map((profile) => profile.id));
  }

  private breakpointSchedule(): readonly PidBreakpoint[] {
    return [...this.breakpoints()]
      .sort((a, b) => a.temperatureC - b.temperatureC)
      .map((row) => ({
        temperatureC: row.temperatureC,
        gains: { kp: row.kp, ki: row.ki, kd: row.kd },
      }));
  }

  private tunedSchedule(): PidSchedule | null {
    const rows = this.tunedRows();
    if (rows.length === 0) {
      this.store.notify('No completed tuning results are available.');
      return null;
    }
    try {
      return createPidSchedule(
        rows.map((row) => ({
          temperatureC: row.temperature,
          gains: { kp: row.kp, ki: row.ki, kd: row.kd },
        })),
      );
    } catch (error) {
      this.store.notify(error instanceof Error ? error.message : 'The tuning result is invalid.');
      return null;
    }
  }

  private profileSchedule(profile: StoredProfile): PidSchedule | null {
    try {
      return createPidSchedule(profile.data as unknown as PidSchedule);
    } catch {
      return null;
    }
  }

  private startDemoTune(): void {
    this.tuneMessage.set('DEMO · Relay cycle heating; verifying @ output near 255.');
    this.demoTuneTimer = setInterval(() => {
      const nextPeaks = this.peaks() + 1;
      this.peaks.set(nextPeaks);
      const index = this.tuneTargetIndex();
      this.tuneProgress.set(((index * 12 + nextPeaks) / (this.tuneTargets().length * 12)) * 100);
      this.tuneMessage.set(
        nextPeaks % 2 === 0
          ? 'DEMO · Cooling toward target − 5 °C; verifying @ output near 0.'
          : 'DEMO · Heating toward calibration target; verifying @ output near 255.',
      );
      if (nextPeaks >= 12) {
        if (index + 1 < this.tuneTargets().length) {
          this.tuneTargetIndex.set(index + 1);
          this.peaks.set(0);
        } else {
          this.stopDemoTune();
          this.tuneProgress.set(100);
          this.tunePhase.set('results');
          this.tuneMessage.set('DEMO · 12 peaks captured at every target. Draft gains are ready.');
          void this.store.cancelLiveTuning();
        }
      }
    }, 260);
  }

  private stopDemoTune(): void {
    if (this.demoTuneTimer !== undefined) {
      clearInterval(this.demoTuneTimer);
      this.demoTuneTimer = undefined;
    }
  }
}
