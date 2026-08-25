import { ConfigurationStore } from './configuration.store';
import { DEFAULT_OVEN_PROFILE } from '../simulation';

describe('ConfigurationStore', () => {
  it('exposes settings and physical configuration through intent-named commands', () => {
    const store = new ConfigurationStore();
    const originalProfile = store.ovenModelProfile();

    store.patchSettings({ startupMacro: 'M115', commandTimeoutMs: 4_000 });
    store.updatePhysicalModel((profile) => ({ ...profile, ambientTemperatureC: 30 }));

    expect(store.settings()).toMatchObject({ startupMacro: 'M115', commandTimeoutMs: 4_000 });
    expect(store.ovenModelProfile().ambientTemperatureC).toBe(30);
    expect(originalProfile.ambientTemperatureC).toBe(DEFAULT_OVEN_PROFILE.ambientTemperatureC);
  });

  it('updates virtual hardware without exposing a writable signal', () => {
    const store = new ConfigurationStore();
    const originalPin = store.firmwareInLoopHardware().pins[0]?.pin;

    store.updateVirtualHardware((hardware) => ({
      ...hardware,
      pins: hardware.pins.map((binding, index) =>
        index === 0 ? { ...binding, pin: 'PB1' } : binding,
      ),
    }));

    expect(store.firmwareInLoopHardware().pins[0]?.pin).toBe('PB1');
    expect(originalPin).toBe('PA6');
    expect('set' in store.firmwareInLoopHardware()).toBe(false);
  });

  it('derives identical geometry and air capacities for domain edits', () => {
    const settings = new ConfigurationStore();
    const simulation = new ConfigurationStore();

    expect(settings.updateGeometry('widthM', 160).ok).toBe(true);
    expect(simulation.updateGeometry('widthM', 160).ok).toBe(true);
    expect(settings.updateAirProperty('airDensityKgPerM3', 1.3).ok).toBe(true);
    expect(simulation.updateAirProperty('airDensityKgPerM3', 1.3).ok).toBe(true);

    expect(settings.ovenModelProfile()).toEqual(simulation.ovenModelProfile());
    expect(settings.ovenModelProfile().ambient.enclosureRadiatingAreaM2).toBeGreaterThan(0);
    expect(settings.ovenModelProfile().bodies.topAir.heatCapacityJPerK).toBe(
      settings.ovenModelProfile().bodies.bottomAir.heatCapacityJPerK,
    );
  });

  it('rejects invalid physical edits atomically with a field detail', () => {
    const store = new ConfigurationStore();
    const original = store.ovenModelProfile();

    const result = store.updateGeometry('widthM', 0);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toContain('geometry.widthM');
    expect(store.ovenModelProfile()).toEqual(original);
  });

  it('keeps profile revisions newest-first and supports replacement and removal', () => {
    const store = new ConfigurationStore();
    const first = store.createProfile('First', 'simulation', 'validated', { value: 1 });
    const replacement = { ...first, name: 'Updated' };
    const second = store.createProfile('Second', 'pid-schedule', 'draft', { value: 2 });

    store.addProfile(first);
    store.addProfile(second);
    store.replaceProfile(replacement);

    expect(store.profiles().map(({ name }) => name)).toEqual(['Updated', 'Second']);
    store.removeProfile(second.id);
    expect(store.profiles().map(({ name }) => name)).toEqual(['Updated']);
  });
});
