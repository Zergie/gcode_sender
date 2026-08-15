import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ThemePreference } from '../../../../shared/contracts';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { IconComponent } from '../../shared/icon';
import { PageHeaderComponent } from '../../shared/page-header';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, IconComponent, PageHeaderComponent],
  templateUrl: './settings.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsComponent {
  readonly store = inject(WorkbenchStore);
  readonly startupMacro = signal('');
  readonly timeoutSeconds = signal(8);
  readonly osNotifications = signal(true);

  constructor() {
    this.startupMacro.set(this.store.settings().startupMacro);
    this.timeoutSeconds.set(this.store.settings().commandTimeoutMs / 1000);
  }

  changeTheme(theme: ThemePreference): void {
    this.store.setTheme(theme);
  }

  selectPort(path: string): void {
    this.store.selectedPort.set(path);
    void this.store.updateSettings({ lastSerialPort: path });
  }

  saveRuntimeSettings(): void {
    void this.store.updateSettings({
      startupMacro: this.startupMacro(),
      commandTimeoutMs: Math.max(1, this.timeoutSeconds()) * 1000,
      lastSerialPort: this.store.selectedPort() || null,
    });
  }

  themeLabel(theme: string): string {
    return theme === 'system' ? 'Follow system' : theme.charAt(0).toUpperCase() + theme.slice(1);
  }
}
