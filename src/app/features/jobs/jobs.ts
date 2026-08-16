import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, TitleCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { IconComponent } from '../../shared/icon';
import { PageHeaderComponent } from '../../shared/page-header';

@Component({
  selector: 'app-jobs',
  imports: [DatePipe, TitleCasePipe, FormsModule, IconComponent, PageHeaderComponent],
  templateUrl: './jobs.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobsComponent {
  readonly store = inject(WorkbenchStore);
  readonly dragging = signal(false);
  readonly restartLine = signal(1);
  readonly recentJobs = computed(() =>
    this.store
      .sessions()
      .filter((session) => session.kind === 'job')
      .slice(0, 5)
      .map((session) => {
        const data = session.data as unknown as { status?: string };
        return {
          id: session.id,
          name: session.title,
          endedAt: session.endedAt,
          result: data.status ?? 'completed',
          duration: this.formatDuration(
            Date.parse(session.endedAt) - Date.parse(session.startedAt),
          ),
        };
      }),
  );

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    if (event.currentTarget === event.target) this.dragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files.item(0);
    if (file !== null && file !== undefined) this.store.acceptDroppedFile(file);
  }

  start(): void {
    void this.store.runLoadedProgram(Math.max(1, Math.round(this.restartLine())));
  }

  formatBytes(value: number): string {
    return value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  formatDuration(value: number | null): string {
    if (value === null) return '—';
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.floor((value % 60_000) / 1_000);
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
}
