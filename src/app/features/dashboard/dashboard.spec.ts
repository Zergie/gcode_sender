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

  it('changes the rendered thermal-response series when its time range changes', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    const store = TestBed.inject(WorkbenchStore);
    const now = Date.UTC(2026, 7, 16, 8, 0, 0);
    store.trend.set(
      [
        { minutesAgo: 10, average: 25 },
        { minutesAgo: 5, average: 70 },
        { minutesAgo: 0, average: 120 },
      ].map(({ minutesAgo, average }) => ({
        time: now - minutesAgo * 60_000,
        average,
        t1: average + 1.5,
        t2: average - 1.5,
        t3: 30,
        target: 180,
        modelTarget: 176,
        power: 160,
      })),
    );
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const rangeButton = (label: string): HTMLButtonElement => {
      const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent?.trim().toLowerCase() === label.toLowerCase(),
      );
      expect(button, `missing ${label} range button`).toBeDefined();
      return button!;
    };
    const renderedSeries = (): string =>
      element.querySelector<SVGPathElement>('path.series.average')?.getAttribute('d') ?? '';

    const paths = ['5m', '30m', '2h', 'Job'].map((label) => {
      rangeButton(label).click();
      fixture.detectChanges();
      return renderedSeries();
    });

    expect(paths.every(Boolean)).toBe(true);
    expect(new Set(paths).size, 'each range should render a distinct domain').toBe(4);
  });

  it('does not include pre-job telemetry when the job starts after the latest sample', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    const component = fixture.componentInstance;
    const store = TestBed.inject(WorkbenchStore);
    const latestPointTime = Date.UTC(2026, 7, 16, 8, 0, 0);
    const jobStartedAt = latestPointTime + 1_000;
    store.trend.set([
      {
        time: latestPointTime,
        average: 25,
        t1: 26,
        t2: 24,
        t3: 22,
        target: 0,
        modelTarget: 0,
        power: 0,
      },
    ]);
    store.job.update((job) => ({ ...job, startedAt: new Date(jobStartedAt).toISOString() }));
    component.range.set('Job');
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(component.chartWindow()).toEqual({ start: jobStartedAt, end: jobStartedAt + 1 });
    expect(component.chartPoints()).toEqual([]);
    expect(element.querySelector<SVGPathElement>('path.series.average')?.getAttribute('d')).toBe(
      '',
    );
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
