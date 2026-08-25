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

    store.updateVirtualPin(0, (binding) => ({ ...binding, pin: 'PB1' }));

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

  it('centralizes heater and independently editable body-property commands', () => {
    const settings = new ConfigurationStore();
    const simulation = new ConfigurationStore();

    expect(settings.updateHeaterPower('top', 1_100).ok).toBe(true);
    expect(simulation.updateHeaterPower('top', 1_100).ok).toBe(true);
    expect(settings.updateBodyHeatCapacity('standardLoad', 850).ok).toBe(true);
    expect(simulation.updateBodyHeatCapacity('standardLoad', 850).ok).toBe(true);

    expect(settings.ovenModelProfile()).toEqual(simulation.ovenModelProfile());
    expect(settings.updateBodyHeatCapacity('standardLoad', 0).ok).toBe(false);
    expect(settings.ovenModelProfile().bodies.standardLoad.heatCapacityJPerK).toBe(850);
  });

  it('centralizes calibratable links and protects geometry-derived radiation areas', () => {
    const settings = new ConfigurationStore();
    const simulation = new ConfigurationStore();

    expect(settings.updateLinearConductance(0, 0.123).ok).toBe(true);
    expect(simulation.updateLinearConductance(0, 0.123).ok).toBe(true);
    expect(settings.updateRadiationEmissivity(0, 0.72).ok).toBe(true);
    expect(simulation.updateRadiationEmissivity(0, 0.72).ok).toBe(true);
    expect(settings.updateRadiationViewFactor(0, 0.61).ok).toBe(true);
    expect(simulation.updateRadiationViewFactor(0, 0.61).ok).toBe(true);

    expect(settings.ovenModelProfile()).toEqual(simulation.ovenModelProfile());

    const derivedIndex = settings
      .ovenModelProfile()
      .radiationLinks.findIndex(
        (link) =>
          (link.a === 'standardLoad' && link.b === 'enclosure') ||
          (link.a === 'enclosure' && link.b === 'standardLoad'),
      );
    const previousArea = settings.ovenModelProfile().radiationLinks[derivedIndex]?.areaM2;
    const revision = settings.physicalConfigurationRevision();
    const rejected = settings.updateRadiationArea(derivedIndex, 0.001);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.errors[0]?.path).toContain('areaM2');
    expect(settings.ovenModelProfile().radiationLinks[derivedIndex]?.areaM2).toBe(previousArea);
    expect(settings.physicalConfigurationRevision()).toBe(revision);
  });

  it('rejects invalid link indexes and values atomically', () => {
    const store = new ConfigurationStore();
    const original = store.ovenModelProfile();
    const revision = store.physicalConfigurationRevision();

    expect(store.updateLinearConductance(99, 1).ok).toBe(false);
    expect(store.updateRadiationEmissivity(0, 1.5).ok).toBe(false);
    expect(store.ovenModelProfile()).toEqual(original);
    expect(store.physicalConfigurationRevision()).toBe(revision);
  });

  it('advances the physical revision once for committed edits and not for rejected edits', () => {
    const store = new ConfigurationStore();

    expect(store.physicalConfigurationRevision()).toBe(0);
    expect(store.updateGeometry('widthM', 160).ok).toBe(true);
    expect(store.physicalConfigurationRevision()).toBe(1);

    expect(store.updateGeometry('widthM', 0).ok).toBe(false);
    expect(store.physicalConfigurationRevision()).toBe(1);
    expect(store.ovenModelProfile().geometry.widthM).toBe(0.16);

    store.updateVirtualEepromFill(0);
    expect(store.physicalConfigurationRevision()).toBe(2);
  });

  it('rejects invalid virtual hardware atomically and reports the field', () => {
    const store = new ConfigurationStore();
    const original = store.firmwareInLoopHardware();
    const revision = store.physicalConfigurationRevision();

    const result = store.updateVirtualPin(0, (binding) => ({ ...binding, pin: 'PZ99' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toContain('pins.PZ99');
    expect(store.firmwareInLoopHardware()).toEqual(original);
    expect(store.physicalConfigurationRevision()).toBe(revision);
  });

  it('uses one atomic command for equivalent virtual hardware edits', () => {
    const settings = new ConfigurationStore();
    const simulation = new ConfigurationStore();

    expect(settings.updateVirtualEepromSize(2_048).ok).toBe(true);
    expect(simulation.updateVirtualEepromSize(2_048).ok).toBe(true);
    expect(settings.updateVirtualThermistor('betaK', 4_100).ok).toBe(true);
    expect(simulation.updateVirtualThermistor('betaK', 4_100).ok).toBe(true);

    expect(settings.firmwareInLoopHardware()).toEqual(simulation.firmwareInLoopHardware());
    expect(settings.physicalConfigurationRevision()).toBe(2);
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
