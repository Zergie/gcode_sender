import { TestBed } from '@angular/core/testing';
import { WorkbenchCoordinator } from './workbench-coordinator';
import { WorkbenchStore } from './workbench.store';

describe('WorkbenchCoordinator', () => {
  it('keeps application lifecycle workflows explicit and delegates them once', async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const shutdown = vi.fn();
    const workbench = {
      initialize,
      disconnect,
      ngOnDestroy: shutdown,
    } as unknown as WorkbenchStore;
    TestBed.configureTestingModule({
      providers: [WorkbenchCoordinator, { provide: WorkbenchStore, useValue: workbench }],
    });

    const coordinator = TestBed.inject(WorkbenchCoordinator);
    await coordinator.initialize();
    await coordinator.disconnect();
    coordinator.shutdown();

    expect(initialize).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
