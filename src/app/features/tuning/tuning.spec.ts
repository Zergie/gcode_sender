import { TestBed } from '@angular/core/testing';
import { TuningComponent } from './tuning';
import { WorkbenchStore } from '../../core/platform/workbench.store';

describe('TuningComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [TuningComponent] }).compileComponents();
  });

  it('guards duplicate breakpoint edits without throwing during rendering', () => {
    const fixture = TestBed.createComponent(TuningComponent);
    const component = fixture.componentInstance;
    const second = component.breakpoints()[1];
    expect(second).toBeDefined();

    component.updateBreakpoint(second!.id, 'temperatureC', 100);
    fixture.detectChanges();

    expect(component.validatedSchedule().schedule).toBeNull();
    expect(component.validatedSchedule().error).toContain('strictly increasing');
    fixture.destroy();
  });

  it('applies every completed tuning row as the active PID schedule', async () => {
    const fixture = TestBed.createComponent(TuningComponent);
    const component = fixture.componentInstance;
    const store = TestBed.inject(WorkbenchStore);
    store.liveTuning.update((state) => ({
      ...state,
      status: 'completed',
      results: [100, 150, 200].map((target, index) => ({
        target,
        peaks: [],
        candidates: [
          {
            method: 'klipper-ziegler-nichols' as const,
            gains: { kp: 10 + index, ki: 0.5 + index * 0.1, kd: 40 + index },
            ku: 20,
            tuSeconds: 30,
          },
          {
            method: 'conservative' as const,
            gains: { kp: 8 + index, ki: 0.3, kd: 30 },
            ku: 20,
            tuSeconds: 30,
          },
        ],
      })),
    }));

    await component.applyTuneResult();

    expect(store.pidSchedule().map((row) => row.temperatureC)).toEqual([100, 150, 200]);
    expect(store.pidSchedule().map((row) => row.gains.kp)).toEqual([10, 11, 12]);
    expect(store.profiles()[0]?.state).toBe('applied');
    fixture.destroy();
  });

  it('keeps the live temperature unknown until connected telemetry arrives', () => {
    const fixture = TestBed.createComponent(TuningComponent);
    const component = fixture.componentInstance;
    const store = TestBed.inject(WorkbenchStore);
    component.section.set('autotune');
    component.tunePhase.set('running');

    fixture.detectChanges();
    const temperatureValue = (): string =>
      (
        fixture.nativeElement.querySelector(
          '.tune-live-stats > div:nth-child(2) strong',
        ) as HTMLElement
      ).textContent ?? '';
    expect(temperatureValue()).toContain('Unknown');
    expect(fixture.nativeElement.textContent).not.toContain('22.0 °C');

    store.connection.set({
      status: 'connected',
      portPath: 'COM3',
      baudRate: 115200,
      firmware: null,
      connectedAt: new Date(0).toISOString(),
      error: null,
    });
    store.hasTelemetry.set(true);
    store.telemetry.update((telemetry) => ({ ...telemetry, average: 48.25 }));
    fixture.detectChanges();

    expect(temperatureValue()).toContain('48.3 °C');
    fixture.destroy();
  });
});
