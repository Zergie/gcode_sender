import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { TuningComponent } from './tuning';
import { WorkbenchStore } from '../../core/platform/workbench.store';

describe('TuningComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [TuningComponent] }).compileComponents();
  });

  it('opens the shared firmware picker from the simulation banner', () => {
    const fixture = TestBed.createComponent(TuningComponent);
    const store = TestBed.inject(WorkbenchStore);
    const chooseFirmwareIno = vi.spyOn(store, 'chooseFirmwareIno').mockResolvedValue(false);
    fixture.detectChanges();

    const button = [...fixture.nativeElement.querySelectorAll('button')].find(
      (candidate: HTMLButtonElement) => candidate.textContent?.trim() === 'Choose .ino',
    ) as HTMLButtonElement | undefined;
    expect(button).toBeDefined();
    button!.click();

    expect(chooseFirmwareIno).toHaveBeenCalledOnce();
    fixture.destroy();
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

  it('overwrites a PID profile by name without changing the selected profile', async () => {
    const store = TestBed.inject(WorkbenchStore);
    const active = await store.saveProfile(
      'Active schedule',
      'pid-schedule',
      'applied',
      store.pidSchedule(),
    );
    const original = await store.saveProfile(
      'Selected schedule',
      'pid-schedule',
      'draft',
      store.pidSchedule(),
    );
    expect(original).not.toBeNull();
    const fixture = TestBed.createComponent(TuningComponent);
    const component = fixture.componentInstance;
    component.selectedProfileId.set(active!.id);
    component.loadProfile(original!);
    const firstBreakpoint = component.breakpoints()[0]!;
    component.updateBreakpoint(firstBreakpoint.id, 'kp', 99);
    fixture.detectChanges();

    await component.save();
    fixture.detectChanges();

    const matchingProfiles = store.profiles().filter(({ name }) => name === 'Selected schedule');
    expect(matchingProfiles).toHaveLength(1);
    expect(matchingProfiles[0]?.id).toBe(original?.id);
    expect(matchingProfiles[0]?.state).toBe('draft');
    expect(
      (matchingProfiles[0]?.data as unknown as readonly { gains: { kp: number } }[])[0]?.gains.kp,
    ).toBe(99);
    expect(component.selectedProfileId()).toBe(active?.id);
    expect(fixture.nativeElement.textContent).not.toContain('New PID profile');
    fixture.destroy();
  });

  it('creates a new PID profile when Save cannot find its name', async () => {
    const store = TestBed.inject(WorkbenchStore);
    const fixture = TestBed.createComponent(TuningComponent);
    const component = fixture.componentInstance;
    component.selectedProfileId.set(null);
    component.profileName.set('New schedule');
    fixture.detectChanges();

    await component.save();

    expect(store.profiles().filter(({ name }) => name === 'New schedule')).toHaveLength(1);
    expect(component.selectedProfileId()).toBeNull();
    fixture.destroy();
  });

  it('marks the named profile selected only after its gains are applied', async () => {
    const store = TestBed.inject(WorkbenchStore);
    const profile = await store.saveProfile(
      'Applied schedule',
      'pid-schedule',
      'draft',
      store.pidSchedule(),
    );
    const fixture = TestBed.createComponent(TuningComponent);
    const component = fixture.componentInstance;
    component.selectedProfileId.set(null);
    component.section.set('schedule');
    vi.spyOn(store, 'applyPidSchedule').mockResolvedValue(true);

    await component.applyProfile(profile!);
    fixture.detectChanges();

    const applied = store.profiles().find(({ name }) => name === 'Applied schedule');
    expect(applied?.state).toBe('applied');
    expect(component.selectedProfileId()).toBe(applied?.id);
    expect(fixture.nativeElement.querySelector('.profile-card.selected')).not.toBeNull();
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
