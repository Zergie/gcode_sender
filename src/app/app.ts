import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
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
    { path: '/tuning', label: 'Tuning & Profiles', icon: 'tuning' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
    { path: '/about', label: 'About', icon: 'about' },
  ] as const;

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
}
