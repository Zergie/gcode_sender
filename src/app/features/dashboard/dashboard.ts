import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { IconComponent } from '../../shared/icon';
import { PageHeaderComponent } from '../../shared/page-header';
import { TrendChartComponent } from '../../shared/trend-chart';

@Component({
  selector: 'app-dashboard',
  imports: [FormsModule, PageHeaderComponent, TrendChartComponent, IconComponent],
  templateUrl: './dashboard.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent {
  readonly store = inject(WorkbenchStore);
  readonly targetDraft = signal(200);
  readonly range = signal('30m');
  readonly chartWindow = computed(() => {
    const points = this.store.trend();
    const latestPointTime = points.at(-1)?.time ?? Date.now();
    const selectedRange = this.range();
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

  constructor() {
    this.targetDraft.set(this.store.requestedTarget());
  }

  applyTarget(): void {
    void this.store.setTarget(this.targetDraft());
  }

  adjustTarget(delta: number): void {
    this.targetDraft.update((value) => Math.max(0, Math.min(250, value + delta)));
  }
}
