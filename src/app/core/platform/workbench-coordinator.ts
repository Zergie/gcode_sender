import { Injectable, inject } from '@angular/core';
import { WorkbenchStore } from './workbench.store';

/**
 * Owns application-level workflows that span more than one bounded domain.
 * Route stores should expose domain state and commands; this coordinator is
 * the explicit seam for process bootstrap and connection teardown.
 */
@Injectable({ providedIn: 'root' })
export class WorkbenchCoordinator {
  private readonly workbench = inject(WorkbenchStore);

  initialize(): Promise<void> {
    return this.workbench.initialize();
  }

  async disconnect(): Promise<void> {
    await this.workbench.disconnect();
  }

  shutdown(): void {
    this.workbench.ngOnDestroy();
  }
}
