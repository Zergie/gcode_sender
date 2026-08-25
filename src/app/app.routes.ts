import type { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'dashboard',
    title: 'Dashboard',
    loadComponent: () =>
      import('./features/dashboard/dashboard').then((module) => module.DashboardComponent),
  },
  {
    path: 'terminal',
    title: 'Terminal',
    loadComponent: () =>
      import('./features/terminal/terminal').then((module) => module.TerminalComponent),
  },
  {
    path: 'jobs',
    title: 'Jobs',
    loadComponent: () => import('./features/jobs/jobs').then((module) => module.JobsComponent),
  },
  {
    path: 'simulation',
    title: 'Simulation & Tuning',
    loadComponent: () =>
      import('./features/tuning/tuning').then((module) => module.TuningComponent),
  },
  { path: 'tuning', pathMatch: 'full', redirectTo: 'simulation' },
  {
    path: 'settings',
    title: 'Settings',
    loadComponent: () =>
      import('./features/settings/settings').then((module) => module.SettingsComponent),
  },
  {
    path: 'about',
    title: 'About',
    loadComponent: () => import('./features/about/about').then((module) => module.AboutComponent),
  },
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: '**', redirectTo: 'dashboard' },
];
