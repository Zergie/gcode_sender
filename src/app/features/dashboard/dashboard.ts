import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { HeatingProfilePoint } from '../../../../shared/contracts';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { IconComponent } from '../../shared/icon';
import { PageHeaderComponent } from '../../shared/page-header';
import { TrendChartComponent, type ProfilePointEdit } from '../../shared/trend-chart';

type DashboardRange = '5m' | '30m' | '2h' | 'Job' | 'Profile';

const ACTIVE_JOB_STATUSES = new Set([
  'preparing',
  'streaming',
  'pause-pending',
  'paused',
  'awaiting-decision',
  'stopping',
]);

@Component({
  selector: 'app-dashboard',
  imports: [FormsModule, PageHeaderComponent, TrendChartComponent, IconComponent],
  templateUrl: './dashboard.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent {
  readonly store = inject(WorkbenchStore);
  readonly targetDraft = signal(200);
  readonly range = signal<DashboardRange>('30m');
  readonly selectedProfilePointIndex = signal(0);
  private lastLoadedProfileKey: string | null = null;

  readonly profile = computed(() => this.store.heatingProfileDraft());
  readonly profileDurationMs = computed(() => this.profile()?.points.at(-1)?.timeMs ?? 0);
  readonly profileAnchor = computed(() => {
    const program = this.store.selectedProgram();
    const job = this.store.job();
    const startedAt = Date.parse(job.startedAt ?? '');
    if (program !== null && job.file?.path === program.file.path && Number.isFinite(startedAt)) {
      return startedAt;
    }
    return this.store.trend().at(-1)?.time ?? Date.now();
  });
  readonly profilePlayheadMs = computed(() => {
    const program = this.store.selectedProgram();
    const job = this.store.job();
    return program !== null &&
      job.file?.path === program.file.path &&
      ACTIVE_JOB_STATUSES.has(job.status)
      ? (job.progress?.elapsedMs ?? 0)
      : null;
  });
  readonly selectedProfilePoint = computed<HeatingProfilePoint | null>(() => {
    const points = this.profile()?.points;
    if (points === undefined || points.length === 0) return null;
    return points[Math.min(this.selectedProfilePointIndex(), points.length - 1)] ?? null;
  });
  readonly rangeOptions = computed<readonly DashboardRange[]>(() =>
    this.profile() === null ? ['5m', '30m', '2h', 'Job'] : ['5m', '30m', '2h', 'Job', 'Profile'],
  );
  readonly chartWindow = computed(() => {
    const points = this.store.trend();
    const latestPointTime = points.at(-1)?.time ?? Date.now();
    const selectedRange = this.range();
    if (selectedRange === 'Profile' && this.profile() !== null) {
      const start = this.profileAnchor();
      return { start, end: start + Math.max(this.profileDurationMs(), 1) };
    }
    const jobStartedAt = Date.parse(this.store.job().startedAt ?? '');
    if (selectedRange === 'Job') {
      const start = Number.isFinite(jobStartedAt)
        ? jobStartedAt
        : (points.at(0)?.time ?? latestPointTime - 1);
      return { start, end: Math.max(latestPointTime, start + 1) };
    }
    const start =
      selectedRange === '5m'
        ? latestPointTime - 5 * 60_000
        : selectedRange === '30m'
          ? latestPointTime - 30 * 60_000
          : latestPointTime - 2 * 60 * 60_000;
    return { start, end: latestPointTime };
  });
  readonly chartPoints = computed(() => {
    const window = this.chartWindow();
    return this.store
      .trend()
      .filter((point) => point.time >= window.start && point.time <= window.end);
  });
  readonly profileEditingLocked = computed(() => this.store.busy());
  readonly jobActive = computed(() => ACTIVE_JOB_STATUSES.has(this.store.job().status));
  readonly runDisabledReason = computed(() => {
    const profile = this.profile();
    if (profile === null && this.store.selectedProgram() === null) {
      return 'Load a G-code file or create a heating profile first.';
    }
    if (profile !== null && !this.store.heatingProfileValidation().valid) {
      return this.store.heatingProfileValidation().error ?? 'Fix the profile before running.';
    }
    if (!this.store.connected()) return 'Connect the controller before running.';
    if (this.store.busy()) return 'The controller is busy with an active operation.';
    return null;
  });
  readonly programStatus = computed(() => {
    if (this.store.busy() && this.jobActive()) {
      return this.store.job().status;
    }
    if (this.profile() !== null) {
      if (!this.store.heatingProfileValidation().valid) return 'needs attention';
      return this.store.heatingProfileDirty() ? 'unsaved' : 'ready';
    }
    return this.store.selectedProgram() === null ? 'empty' : 'ready';
  });
  readonly programName = computed(
    () => this.profile()?.name || this.store.selectedProgram()?.file.name || 'No program loaded',
  );

  constructor() {
    this.targetDraft.set(this.store.requestedTarget());
    effect(() => {
      const profile = this.profile();
      const key =
        profile === null
          ? null
          : (this.store.selectedProgram()?.file.path ?? '__new-heating-profile__');
      if (key !== null && key !== this.lastLoadedProfileKey) {
        this.lastLoadedProfileKey = key;
        this.selectedProfilePointIndex.set(0);
        this.range.set('Profile');
      }
      if (profile === null && this.range() === 'Profile') this.range.set('30m');
    });
  }

  applyTarget(): void {
    void this.store.setTarget(this.targetDraft());
  }

  adjustTarget(delta: number): void {
    this.targetDraft.update((value) => Math.max(0, Math.min(250, value + delta)));
  }

  newHeatingProfile(): void {
    this.store.newHeatingProfile();
    this.selectedProfilePointIndex.set(0);
    this.range.set('Profile');
  }

  async loadGcode(): Promise<void> {
    await this.store.chooseJob();
    if (this.profile() !== null) this.range.set('Profile');
  }

  saveProfile(): void {
    void this.store.saveHeatingProfile();
  }

  runProgram(): void {
    void this.store.runLoadedProgram();
  }

  selectProfilePoint(index: number): void {
    this.selectedProfilePointIndex.set(index);
  }

  updateProfilePoint(edit: ProfilePointEdit): void {
    this.selectedProfilePointIndex.set(edit.index);
    this.store.updateHeatingProfilePoint(edit.index, edit);
  }

  updateSelectedTimeSeconds(value: number): void {
    this.store.updateHeatingProfilePoint(this.selectedProfilePointIndex(), {
      timeMs: Number(value) * 1_000,
    });
  }

  updateSelectedTarget(value: number): void {
    this.store.updateHeatingProfilePoint(this.selectedProfilePointIndex(), {
      targetC: Number(value),
    });
  }

  addProfilePoint(): void {
    this.selectedProfilePointIndex.set(
      this.store.addHeatingProfilePoint(this.selectedProfilePointIndex()),
    );
  }

  removeProfilePoint(index = this.selectedProfilePointIndex()): void {
    this.store.removeHeatingProfilePoint(index);
    if (index > 0) this.selectedProfilePointIndex.set(index - 1);
  }

  formatDuration(valueMs: number): string {
    const totalSeconds = Math.max(0, Math.round(valueMs / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
      ? `${hours}h ${minutes.toString().padStart(2, '0')}m`
      : `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
}
