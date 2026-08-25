import { TestBed } from '@angular/core/testing';
import { JobsProgramsStore } from './jobs-programs.store';

describe('JobsProgramsStore', () => {
  let store: JobsProgramsStore;
  let disarm: () => void;

  beforeEach(() => {
    disarm = vi.fn() as unknown as () => void;
    TestBed.configureTestingModule({ providers: [JobsProgramsStore] });
    store = TestBed.inject(JobsProgramsStore);
    store.configure({
      busy: () => false,
      connected: () => true,
      disarm,
      refreshSessions: async () => undefined,
      stopHeating: async () => undefined,
      commandTimeoutMs: () => 8_000,
    });
  });

  it('owns profile editing and keeps the draft immutable at the command boundary', async () => {
    store.newHeatingProfile();
    const before = store.heatingProfileDraft();

    store.updateHeatingProfilePoint(1, { timeMs: 600_000.6, targetC: 179.6 });
    const inserted = store.addHeatingProfilePoint(0);

    expect(before?.points[1]).toEqual({ timeMs: 600_000, targetC: 180 });
    expect(store.heatingProfileDirty()).toBe(true);
    expect(store.heatingProfileValidation().valid).toBe(true);
    expect(store.heatingProfileDraft()?.points[inserted]).toEqual({
      timeMs: 300_001,
      targetC: 103,
    });

    const program = await store.saveHeatingProfile();
    expect(program?.kind).toBe('heating-profile');
    expect(store.heatingProfileDirty()).toBe(false);
    expect(store.selectedJob()?.name).toBe('Untitled-heating-profile.gcode');
  });

  it('owns demo job lifecycle and invokes the coordinator safety command before streaming', async () => {
    await store.chooseJob();

    expect(store.selectedJob()).not.toBeNull();
    expect(await store.startJob()).toBe(true);
    expect(disarm).toHaveBeenCalledOnce();
    expect(store.job().status).toBe('streaming');

    await store.pauseOrResumeJob();
    expect(store.job().status).toBe('paused');
    await store.resolveJobTimeout('continue');
    await store.stopJob();
    expect(store.job().status).toBe('stopped');
  });
});
