// @vitest-environment jsdom

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobTimeoutEvent } from '../../../../shared/contracts';
import { WorkbenchStore } from './workbench.store';

describe('WorkbenchStore operator workflow characterization', () => {
  let store: WorkbenchStore;

  beforeEach(() => {
    window.history.replaceState({}, '', '/?state=monitoring');
    TestBed.configureTestingModule({ providers: [WorkbenchStore] });
    store = TestBed.inject(WorkbenchStore);
  });

  afterEach(() => {
    store?.ngOnDestroy();
    window.history.replaceState({}, '', '/');
    vi.useRealTimers();
  });

  it('characterizes job start disarming, pause/resume, timeout continuation, and stop safety', async () => {
    await store.initialize();
    expect(store.connected()).toBe(true);
    expect(store.selectedJob()).not.toBeNull();

    store.controlArmed.set(true);
    expect(await store.startJob()).toBe(true);
    expect(store.controlArmed()).toBe(false);
    expect(store.job().status).toBe('streaming');

    await store.pauseOrResumeJob();
    expect(store.job().status).toBe('paused');
    await store.pauseOrResumeJob();
    expect(store.job().status).toBe('streaming');

    const timeout: JobTimeoutEvent = {
      decisionId: 'demo-timeout',
      jobId: store.job().id ?? 'demo-job',
      sourceLine: 12,
      command: 'G1 X10',
      timeoutMs: 8_000,
      timestamp: '2026-08-25T12:00:00.000Z',
    };
    store.jobTimeout.set(timeout);
    await store.resolveJobTimeout('continue');
    expect(store.jobTimeout()).toBeNull();
    expect(store.job().status).toBe('streaming');

    await store.stopJob();
    expect(store.job().status).toBe('stopped');
    expect(store.controlArmed()).toBe(false);
    expect(store.terminal().at(-1)?.line).toBe('M104 S0');
    expect(store.toast()).toBe('Heater-off confirmed with M104 S0.');
  });

  it('characterizes tuning cancellation and validation finalization through the public boundary', async () => {
    await store.initialize();

    expect(await store.startLiveTuning([120, 160])).toBe(true);
    expect(store.activity().active).toBe('tuning');
    expect(store.liveTuning().status).toBe('snapshotting');
    await store.cancelLiveTuning();
    expect(store.liveTuning().status).toBe('cancelled');
    expect(store.activity().active).toBeNull();

    vi.useFakeTimers();
    expect(await store.startBoundedValidation(150, store.pidSchedule())).toBe(true);
    expect(store.validation().status).toBe('running');
    expect(store.activity().active).toBe('validation');

    await vi.advanceTimersByTimeAsync(350);

    expect(store.validation().status).toBe('completed');
    expect(store.validation().sampleCount).toBe(241);
    expect(store.validation().metrics).not.toBeNull();
    expect(store.activity().active).toBeNull();
    expect(store.terminal().at(-1)?.line).toBe('M104 S0');
    expect(store.sessions()[0]?.kind).toBe('tuning');
    expect((store.sessions()[0]?.data as { type?: string }).type).toBe('bounded-validation');
  });

  it('keeps profile, terminal, and simulation persistence representations readable in demo mode', async () => {
    await store.initialize();

    const profile = await store.saveProfile('Operator profile', 'simulation', 'validated', {
      targetC: 180,
      mode: 'pid',
    });
    expect(profile).toMatchObject({
      version: 1,
      kind: 'simulation',
      name: 'Operator profile',
      state: 'validated',
      data: { targetC: 180, mode: 'pid' },
    });

    const terminalSessionId = await store.saveTerminalSession();
    const simulationSessionId = await store.saveSimulationSession({
      resultRevision: 3,
      variants: ['standard'],
    });

    expect(terminalSessionId).toBeTruthy();
    expect(simulationSessionId).toBeTruthy();
    expect(store.profiles()[0]).toEqual(profile);
    expect(
      store
        .sessions()
        .slice(0, 2)
        .map((session) => session.kind),
    ).toEqual(['simulation', 'terminal']);
    expect(
      store
        .sessions()
        .slice(0, 2)
        .every((session) => session.version === 1),
    ).toBe(true);
    expect(
      store
        .sessions()
        .slice(0, 2)
        .every((session) => session.endedAt >= session.startedAt),
    ).toBe(true);
  });

  it('updates a same-named profile in place and rejects renaming another profile to it', async () => {
    await store.initialize();
    const first = await store.saveProfile('Operator profile', 'simulation', 'draft', {
      targetC: 180,
    });
    expect(first).not.toBeNull();
    const countAfterFirstSave = store.profiles().length;

    const updated = await store.saveProfile(' operator PROFILE ', 'simulation', 'validated', {
      targetC: 200,
    });

    expect(updated?.id).toBe(first?.id);
    expect(updated).toMatchObject({ name: 'operator PROFILE', data: { targetC: 200 } });
    expect(store.profiles()).toHaveLength(countAfterFirstSave);

    const other = await store.saveProfile('Second profile', 'simulation', 'draft', {
      targetC: 150,
    });
    const rejected = await store.saveProfile(
      'OPERATOR PROFILE',
      'simulation',
      'draft',
      { targetC: 160 },
      other?.id,
    );

    expect(rejected).toBeNull();
    expect(store.profiles().find(({ id }) => id === other?.id)?.name).toBe('Second profile');
  });
});
