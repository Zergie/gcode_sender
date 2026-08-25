import { TestBed } from '@angular/core/testing';
import { HeaterControlStore } from './heater-control.store';
import { NotificationStore } from './notification.store';

describe('HeaterControlStore', () => {
  let store: HeaterControlStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [HeaterControlStore] });
    store = TestBed.inject(HeaterControlStore);
  });

  afterEach(() => store.ngOnDestroy());

  it('keeps target intent disarmed until a connected controller accepts it', async () => {
    const advance = async (): Promise<void> => undefined;

    await store.applyTarget(180, false, false, advance);

    expect(store.requestedTarget()).toBe(180);
    expect(store.controlArmed()).toBe(false);
    expect(TestBed.inject(NotificationStore).toast()).toContain('Connect the controller');
  });

  it('rejects target and schedule mutations while an exclusive activity is busy', async () => {
    await store.applyTarget(180, true, true, async () => undefined);
    const initialSchedule = store.pidSchedule();
    const applied = await store.applyPidSchedule(
      [{ temperatureC: 100, gains: { kp: 10, ki: 0.4, kd: 45 } }],
      true,
      true,
    );

    expect(store.controlArmed()).toBe(false);
    expect(store.pidSchedule()).toBe(initialSchedule);
    expect(applied).toBe(false);
  });

  it('disarms and resets both requested and firmware targets through one command', async () => {
    await store.applyTarget(180, true, false, async () => undefined);
    await store.stopHeating(false, async () => null);

    expect(store.requestedTarget()).toBe(0);
    expect(store.modelTarget()).toBe(0);
    expect(store.controlArmed()).toBe(false);
  });
});
