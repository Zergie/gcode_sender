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
  readonly chartPoints = computed(() => {
    const points = this.store.trend();
    const latest = points.at(-1)?.time ?? Date.now();
    const selectedRange = this.range();
    const cutoff =
      selectedRange === '5m'
        ? latest - 5 * 60_000
        : selectedRange === '30m'
          ? latest - 30 * 60_000
          : selectedRange === '2h'
            ? latest - 2 * 60 * 60_000
            : Date.parse(this.store.job().startedAt ?? '') || Number.NEGATIVE_INFINITY;
    return points.filter((point) => point.time >= cutoff);
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
