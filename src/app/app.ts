import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import type { OnInit } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { ThemePreference } from '../../shared/contracts';
import { WorkbenchStore } from './core/platform/workbench.store';
import { IconComponent } from './shared/icon';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  readonly store = inject(WorkbenchStore);
  readonly collapsed = signal(typeof window !== 'undefined' && window.innerWidth <= 1020);
  readonly navigation = [
    { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { path: '/terminal', label: 'Terminal', icon: 'terminal' },
    { path: '/jobs', label: 'Jobs', icon: 'jobs' },
    { path: '/simulation', label: 'Simulation', icon: 'simulation' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
    { path: '/about', label: 'About', icon: 'about' },
  ] as const;
  private previouslyFocusedElement: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const open = this.store.serialPortDialogOpen();
      if (typeof document === 'undefined') return;
      if (open) {
        this.previouslyFocusedElement =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        queueMicrotask(() => document.querySelector<HTMLElement>('.serial-port-dialog')?.focus());
      } else if (this.previouslyFocusedElement !== null) {
        const focusTarget = this.previouslyFocusedElement;
        this.previouslyFocusedElement = null;
        queueMicrotask(() => focusTarget.focus());
      }
    });
  }

  ngOnInit(): void {
    document.documentElement.dataset['sidebar'] = this.collapsed() ? 'collapsed' : 'expanded';
    void this.store.initialize();
  }

  collapseSidebar(): void {
    this.collapsed.update((value) => !value);
    document.documentElement.dataset['sidebar'] = this.collapsed() ? 'collapsed' : 'expanded';
  }

  cycleTheme(): void {
    const next: ThemePreference = this.store.resolvedTheme() === 'dark' ? 'light' : 'dark';
    this.store.setTheme(next);
  }

  handleSerialPortDialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.store.dismissSerialPortDialog();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = event.currentTarget as HTMLElement;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialog.focus();
    } else if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialog)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
