import { TestBed } from '@angular/core/testing';
import { DashboardComponent } from './dashboard';
import { WorkbenchStore } from '../../core/platform/workbench.store';

describe('DashboardComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [DashboardComponent] }).compileComponents();
  });

  it('clamps setpoint adjustments to the supported range', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.componentInstance.targetDraft.set(249);
    fixture.componentInstance.adjustTarget(5);
    expect(fixture.componentInstance.targetDraft()).toBe(250);
    fixture.componentInstance.targetDraft.set(1);
    fixture.componentInstance.adjustTarget(-5);
    expect(fixture.componentInstance.targetDraft()).toBe(0);
  });

  it('renders all four physical/derived temperature channels', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    const content = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(content).toContain('T0');
    expect(content).toContain('T1');
    expect(content).toContain('T2');
    expect(content).toContain('T3');
    expect(TestBed.inject(WorkbenchStore).telemetry().thermistors).toHaveLength(3);
  });

  it('does not present ambient placeholders as live telemetry while disconnected', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    const content = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(content).toContain('Awaiting telemetry');
    expect(TestBed.inject(WorkbenchStore).telemetryLive()).toBe(false);
  });

  it('opens the shared serial-port chooser from the disconnected notice', async () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();

    const connect = fixture.nativeElement.querySelector(
      '.notice-banner.warning button',
    ) as HTMLButtonElement;
    connect.click();
    await fixture.whenStable();

    const store = TestBed.inject(WorkbenchStore);
    expect(store.serialPortDialogOpen()).toBe(true);
    expect(store.ports().map((port) => port.path)).toEqual(['COM4', 'COM7']);
  });
});
