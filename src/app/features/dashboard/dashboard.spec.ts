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
    const store = TestBed.inject(WorkbenchStore);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const content = element.textContent ?? '';
    const values = [...element.querySelectorAll<HTMLElement>('.metric-value')];

    expect(content).toContain('Awaiting telemetry');
    expect(content).not.toContain('22.0');
    expect(values).toHaveLength(4);
    expect(values.every((value) => value.classList.contains('unknown'))).toBe(true);
    expect(values.every((value) => value.textContent?.includes('—'))).toBe(true);
    expect(store.telemetryLive()).toBe(false);

    store.connection.update((connection) => ({ ...connection, status: 'connected' }));
    fixture.detectChanges();
    expect(store.telemetryLive()).toBe(false);
    expect(
      [...element.querySelectorAll<HTMLElement>('.metric-value')].every((value) =>
        value.classList.contains('unknown'),
      ),
    ).toBe(true);
  });

  it('shows live temperatures after the first connected telemetry sample', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    const store = TestBed.inject(WorkbenchStore);
    store.connection.update((connection) => ({ ...connection, status: 'connected' }));
    store.telemetry.set({
      timestamp: new Date().toISOString(),
      average: 73.2,
      target: 90,
      power: 64,
      thermistors: [74.1, 72.3, 38.6],
      raw: 'T0:73.2 /90 @:64 T1:74.1 T2:72.3 T3:38.6',
    });
    store.hasTelemetry.set(true);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const values = [...element.querySelectorAll<HTMLElement>('.metric-value')];
    expect(values.map((value) => value.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '73.2°C',
      '74.1°C',
      '72.3°C',
      '38.6°C',
    ]);
    expect(values.every((value) => !value.classList.contains('unknown'))).toBe(true);
  });

  it('hides model-only targets and heater wattage in PID mode', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    const store = TestBed.inject(WorkbenchStore);
    store.setMode('pid');
    fixture.detectChanges();

    const content = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(content).not.toContain('Model target');
    expect(content).not.toContain('920 W');
    expect(fixture.nativeElement.querySelector('.series.model')).toBeNull();
    expect(fixture.nativeElement.querySelector('.heater-pair')).toBeNull();
    expect(content).toContain('TOP SENSOR');
    expect(content).toContain('BOTTOM SENSOR');
  });

  it('retains model targets and heater wattage in model-assisted mode', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();

    const content = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(content).toContain('Model target');
    expect(content).toContain('920 W');
    expect(fixture.nativeElement.querySelector('.series.model')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.heater-pair')).not.toBeNull();
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
