import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { AfterViewInit, ElementRef, OnDestroy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { SessionCatalogStore } from '../../core/platform/session-catalog.store';
import { IconComponent } from '../../shared/icon';
import { PageHeaderComponent } from '../../shared/page-header';

@Component({
  selector: 'app-terminal',
  imports: [DatePipe, FormsModule, IconComponent, PageHeaderComponent],
  templateUrl: './terminal.html',
  styleUrl: './terminal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalComponent implements AfterViewInit, OnDestroy {
  @ViewChild('terminalOutput') private terminalOutput?: ElementRef<HTMLDivElement>;

  readonly store = inject(WorkbenchStore);
  readonly sessionCatalog = inject(SessionCatalogStore);
  readonly command = signal('');
  readonly historyIndex = signal(-1);
  readonly suggestions = computed(() => {
    const token = this.command().split(/\s|\n/).at(-1)?.toUpperCase() ?? '';
    if (!/^[GMT]\d*$/.test(token)) return [];
    return this.sessionCatalog
      .catalog()
      .entries.filter((entry) => entry.code.startsWith(token))
      .slice(0, 5);
  });
  private outputObserver?: MutationObserver;
  private previousLineWasVisible = true;

  ngAfterViewInit(): void {
    const output = this.terminalOutput?.nativeElement;
    if (output === undefined) return;
    this.previousLineWasVisible = this.isLastOutputVisible(output);
    this.outputObserver = new MutationObserver(() => {
      if (this.previousLineWasVisible) output.scrollTop = output.scrollHeight;
      this.previousLineWasVisible = this.isLastOutputVisible(output);
    });
    this.outputObserver.observe(output, { childList: true, subtree: true });
  }

  ngOnDestroy(): void {
    this.outputObserver?.disconnect();
  }

  rememberOutputPosition(): void {
    const output = this.terminalOutput?.nativeElement;
    if (output !== undefined) this.previousLineWasVisible = this.isLastOutputVisible(output);
  }

  private isLastOutputVisible(output: HTMLElement): boolean {
    const lastLine = output.lastElementChild;
    if (lastLine === null) return true;
    const outputRect = output.getBoundingClientRect();
    const lineRect = lastLine.getBoundingClientRect();
    return lineRect.top >= outputRect.top - 1 && lineRect.bottom <= outputRect.bottom + 1;
  }

  async send(): Promise<void> {
    const sent = await this.store.sendTerminal(this.command());
    if (sent) {
      this.command.set('');
      this.historyIndex.set(-1);
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.send();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const history = this.store.commandHistory();
      const next = Math.min(history.length - 1, this.historyIndex() + 1);
      this.historyIndex.set(next);
      this.command.set(history[next] ?? '');
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = Math.max(-1, this.historyIndex() - 1);
      this.historyIndex.set(next);
      this.command.set(next < 0 ? '' : (this.store.commandHistory()[next] ?? ''));
    }
  }

  useSuggestion(code: string): void {
    const lines = this.command().split('\n');
    lines[lines.length - 1] = code + ' ';
    this.command.set(lines.join('\n'));
  }
}
