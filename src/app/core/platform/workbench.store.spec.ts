import { TestBed } from '@angular/core/testing';
import { createJobStartRequest, WorkbenchStore } from './workbench.store';

describe('WorkbenchStore control integration', () => {
  let store: WorkbenchStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [WorkbenchStore] });
    store = TestBed.inject(WorkbenchStore);
  });

  afterEach(() => store.ngOnDestroy());

  it('starts at ambient with target control disarmed and no demo commands', async () => {
    await store.initialize();

    expect(store.connected()).toBe(false);
    expect(store.controlArmed()).toBe(false);
    expect(store.requestedTarget()).toBe(0);
    expect(store.telemetry().average).toBe(22);
    expect(store.terminal()).toEqual([]);
    expect(store.profiles()).toEqual([]);
    expect(store.selectedJob()).toBeNull();
  });

  it('deduplicates overlapping serial-port refreshes', async () => {
    const first = store.refreshPorts();
    const second = store.refreshPorts();

    expect(second).toBe(first);
    expect(store.serialPortsRefreshing()).toBe(true);
    await first;
    expect(store.serialPortsRefreshing()).toBe(false);
    expect(store.ports().map((port) => port.path)).toEqual(['COM4', 'COM7']);
  });

  it('connects in monitoring-only mode until the operator explicitly applies a target', async () => {
    await store.initialize();
    store.selectedPort.set('COM4');
    await store.connect();

    expect(store.controlArmed()).toBe(false);
    expect(store.terminal().map((entry) => entry.line)).toEqual(['M155 S1']);

    store.setMode('model-assisted');
    await store.setTarget(230);
    await Promise.resolve();

    expect(store.controlMode()).toBe('model-assisted');
    expect(store.modelTarget()).toBeLessThan(store.requestedTarget());
    const commands = store
      .terminal()
      .filter((entry) => entry.direction === 'tx')
      .map((entry) => entry.line);
    expect(commands.some((command) => command.startsWith('M301 P'))).toBe(true);
    expect(commands.some((command) => command.startsWith('M104 S'))).toBe(true);
  });

  it('applies a validated PID schedule explicitly and never sends M500', async () => {
    await store.initialize();
    store.selectedPort.set('COM4');
    await store.connect();
    await store.applyPidSchedule([
      { temperatureC: 100, gains: { kp: 10, ki: 0.4, kd: 45 } },
      { temperatureC: 200, gains: { kp: 20, ki: 0.8, kd: 90 } },
    ]);

    const commands = store
      .terminal()
      .filter((entry) => entry.direction === 'tx')
      .map((entry) => entry.line);
    expect(commands.some((command) => command.startsWith('M301 P'))).toBe(true);
    expect(commands).not.toContain('M500');
  });

  it('does not queue target or PID schedule changes behind an exclusive operation', async () => {
    await store.initialize();
    store.selectedPort.set('COM4');
    await store.connect();
    await store.beginExclusive('tuning');
    const initialSchedule = store.pidSchedule();

    await store.setTarget(220);
    const applied = await store.applyPidSchedule([
      { temperatureC: 100, gains: { kp: 11, ki: 0.5, kd: 50 } },
      { temperatureC: 200, gains: { kp: 22, ki: 1, kd: 100 } },
    ]);

    expect(store.requestedTarget()).toBe(0);
    expect(store.controlArmed()).toBe(false);
    expect(applied).toBe(false);
    expect(store.pidSchedule()).toBe(initialSchedule);
  });

  it('routes heater-off through the system path even while tuning owns serial', async () => {
    await store.initialize();
    store.selectedPort.set('COM4');
    await store.connect();
    await store.beginExclusive('tuning');

    await store.stopHeating();

    expect(store.terminal().at(-1)).toMatchObject({
      origin: 'system',
      direction: 'tx',
      line: 'M104 S0',
    });
    expect(store.toast()).toBe('Heater-off confirmed with M104 S0.');
  });

  it('creates an editable heating profile and saves it before a demo run', async () => {
    await store.initialize();
    store.newHeatingProfile();

    expect(store.heatingProfileDraft()?.name).toBe('Untitled heating profile');
    expect(store.heatingProfileDirty()).toBe(true);
    expect(store.heatingProfileValidation().valid).toBe(true);

    store.selectedPort.set('COM4');
    await store.connect();
    const started = await store.runLoadedProgram();

    expect(started).toBe(true);
    expect(store.heatingProfileDirty()).toBe(false);
    expect(store.selectedProgram()?.kind).toBe('heating-profile');
    expect(store.job().status).toBe('streaming');
  });

  it('normalizes fractional edits and inserted stages to codec-safe integers', () => {
    store.newHeatingProfile();
    store.updateHeatingProfilePoint(1, { timeMs: 600_000.6, targetC: 179.6 });
    const inserted = store.addHeatingProfilePoint(0);

    expect(store.heatingProfileDraft()?.points[2]).toEqual({
      timeMs: 600_001,
      targetC: 180,
    });
    expect(store.heatingProfileDraft()?.points[inserted]).toEqual({
      timeMs: 300_001,
      targetC: 103,
    });
    expect(store.heatingProfileValidation().valid).toBe(true);
  });

  it('keeps the fixed first stage when deletion is requested', () => {
    store.newHeatingProfile();
    const before = store.heatingProfileDraft()?.points;

    store.removeHeatingProfilePoint(0);

    expect(store.heatingProfileDraft()?.points).toEqual(before);
  });

  it('gives generated heating commands enough time while leaving generic timeouts unchanged', () => {
    const file = {
      path: 'profile.gcode',
      name: 'profile.gcode',
      sizeBytes: 64,
      modifiedAt: new Date().toISOString(),
      extension: '.gcode' as const,
    };
    const profile = {
      file,
      kind: 'heating-profile' as const,
      profile: {
        version: 1 as const,
        name: 'Profile',
        interpolation: 'linear' as const,
        points: [
          { timeMs: 0, targetC: 20 },
          { timeMs: 60_000, targetC: 180 },
        ],
      },
      metadataWarning: null,
    };

    expect(createJobStartRequest(file, 1, profile, 1_000)).toEqual({
      path: file.path,
      startLine: 1,
      commandTimeoutMs: 8_000,
    });
    expect(
      createJobStartRequest(file, 7, { ...profile, kind: 'gcode', profile: null }, 1_000),
    ).toEqual({ path: file.path, startLine: 7 });
  });

  it('disarms desktop target control before streaming any selected G-code file', async () => {
    await store.initialize();
    store.selectedPort.set('COM4');
    await store.connect();
    await store.setTarget(180);
    const file = {
      path: 'ordinary.gcode',
      name: 'ordinary.gcode',
      sizeBytes: 64,
      modifiedAt: new Date().toISOString(),
      extension: '.gcode' as const,
    };
    store.selectedProgram.set({
      file,
      kind: 'gcode',
      profile: null,
      metadataWarning: null,
    });
    store.selectedJob.set(file);

    await store.startJob();

    expect(store.controlArmed()).toBe(false);
    expect(store.job().file).toEqual(file);
  });
});
