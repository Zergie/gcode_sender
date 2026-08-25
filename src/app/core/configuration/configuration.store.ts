import { Injectable, signal } from '@angular/core';
import type {
  AppSettings,
  JsonValue,
  ProfileState,
  ProfileKind,
  StoredProfile,
} from '../../../../shared/contracts';
import { EXECUTION_LIMITS } from '../../../../shared/contracts';
import type { PreparedFirmware } from '../../../../shared/firmware-contracts';
import {
  DEFAULT_OVEN_PROFILE,
  cloneOvenModelProfile,
  type OvenModelProfile,
  type ThermalBodyId,
} from '../simulation';
import { createDefaultVirtualHardware } from '../simulation/simulation-configuration.store';
import type { VirtualHardwareConfiguration } from '../../../../shared/firmware-contracts';
import { prepareFirmwarePins } from '../simulation/firmware-in-loop/pins';
import type { VirtualPinBinding } from '../../../../shared/firmware-contracts';
import {
  validateAndDerivePhysicalModel,
  type PhysicalAirPropertyKey,
  type PhysicalGeometryKey,
  type PhysicalModelEditResult,
} from './physical-model';
import { isStandardLoadEnclosureLink } from './physical-model';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 2,
  theme: 'dark',
  lastSerialPort: null,
  startupMacro: '',
  commandTimeoutMs: 8_000,
  physicalLineLimitBytes: EXECUTION_LIMITS.physicalLineBytes.default,
  artifactLimitBytes: EXECUTION_LIMITS.artifactBytes.default,
  artifactLimitRecords: EXECUTION_LIMITS.artifactRecords.default,
  approvedCatalogHosts: [],
  firmwareInoPath: null,
};

export type VirtualHardwareEditResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly errors: readonly { readonly path: string; readonly message: string }[];
    };

@Injectable({ providedIn: 'root' })
export class ConfigurationStore {
  private readonly settingsState = signal<AppSettings>(DEFAULT_APP_SETTINGS);
  private readonly firmwareState = signal<PreparedFirmware | null>(null);
  private readonly firmwareHardwareState = signal(createDefaultVirtualHardware());
  private readonly firmwareBuildingState = signal(false);
  private readonly physicalModelState = signal(cloneOvenModelProfile(DEFAULT_OVEN_PROFILE));
  private readonly physicalConfigurationRevisionState = signal(0);
  private readonly profilesState = signal<readonly StoredProfile[]>([]);

  readonly settings = this.settingsState.asReadonly();
  readonly firmwareInLoop = this.firmwareState.asReadonly();
  readonly firmwareInLoopHardware = this.firmwareHardwareState.asReadonly();
  readonly firmwareInLoopBuilding = this.firmwareBuildingState.asReadonly();
  readonly ovenModelProfile = this.physicalModelState.asReadonly();
  readonly physicalConfigurationRevision = this.physicalConfigurationRevisionState.asReadonly();
  readonly profiles = this.profilesState.asReadonly();

  setTheme(theme: AppSettings['theme']): void {
    this.settingsState.update((current) => ({ ...current, theme }));
  }

  applySettings(settings: AppSettings): void {
    this.settingsState.set(settings);
  }

  patchSettings(patch: Partial<AppSettings>): void {
    this.settingsState.update((current) => ({ ...current, ...patch }));
  }

  setFirmwareBuildBusy(busy: boolean): void {
    this.firmwareBuildingState.set(busy);
  }

  setFirmware(firmware: PreparedFirmware): void {
    this.firmwareState.set(firmware);
    this.firmwareHardwareState.set(firmware.suggestedHardware);
  }

  setPhysicalModel(profile: OvenModelProfile): void {
    const result = validateAndDerivePhysicalModel(profile);
    if (!result.ok) return;
    this.physicalModelState.set(cloneOvenModelProfile(result.profile));
    this.advancePhysicalConfigurationRevision();
  }

  updatePhysicalModel(
    update: (profile: OvenModelProfile) => OvenModelProfile,
  ): PhysicalModelEditResult {
    return this.applyPhysicalModelEdit(update);
  }

  updateGeometry(key: PhysicalGeometryKey, millimeters: number): PhysicalModelEditResult {
    return this.applyPhysicalModelEdit((profile) => ({
      ...profile,
      geometry: { ...profile.geometry, [key]: Number(millimeters) / 1_000 },
    }));
  }

  updateAirProperty(key: PhysicalAirPropertyKey, value: number): PhysicalModelEditResult {
    return this.applyPhysicalModelEdit((profile) =>
      key === 'ambientTemperatureC'
        ? { ...profile, ambientTemperatureC: Number(value) }
        : { ...profile, ambient: { ...profile.ambient, [key]: Number(value) } },
    );
  }

  updateHeaterPower(
    which: keyof OvenModelProfile['heaters'],
    ratedPowerW: number,
  ): PhysicalModelEditResult {
    return this.applyPhysicalModelEdit((profile) => ({
      ...profile,
      heaters: {
        ...profile.heaters,
        [which]: { ...profile.heaters[which], ratedPowerW: Number(ratedPowerW) },
      },
    }));
  }

  updateBodyHeatCapacity(
    body: Exclude<ThermalBodyId, 'topAir' | 'bottomAir'>,
    heatCapacityJPerK: number,
  ): PhysicalModelEditResult {
    return this.applyPhysicalModelEdit((profile) => ({
      ...profile,
      bodies: {
        ...profile.bodies,
        [body]: { ...profile.bodies[body], heatCapacityJPerK: Number(heatCapacityJPerK) },
      },
    }));
  }

  updateLinearConductance(index: number, conductanceWPerK: number): PhysicalModelEditResult {
    if (!this.physicalModelState().linearLinks[index]) {
      return this.invalidPhysicalEdit(
        `linearLinks.${index}`,
        'The heat-transfer link does not exist.',
      );
    }
    return this.applyPhysicalModelEdit((profile) => ({
      ...profile,
      linearLinks: profile.linearLinks.map((link, linkIndex) =>
        linkIndex === index ? { ...link, conductanceWPerK: Number(conductanceWPerK) } : link,
      ),
    }));
  }

  updateRadiationEmissivity(index: number, emissivity: number): PhysicalModelEditResult {
    return this.updateRadiationLink(index, (link) => ({ ...link, emissivity: Number(emissivity) }));
  }

  updateRadiationViewFactor(index: number, viewFactor: number): PhysicalModelEditResult {
    return this.updateRadiationLink(index, (link) => ({ ...link, viewFactor: Number(viewFactor) }));
  }

  updateRadiationArea(index: number, areaM2: number): PhysicalModelEditResult {
    const link = this.physicalModelState().radiationLinks[index];
    if (!link)
      return this.invalidPhysicalEdit(
        `radiationLinks.${index}`,
        'The radiation link does not exist.',
      );
    if (isStandardLoadEnclosureLink(link.a, link.b)) {
      return this.invalidPhysicalEdit(
        `radiationLinks.${index}.areaM2`,
        'This radiation area is derived from geometry and cannot be edited directly.',
      );
    }
    return this.updateRadiationLink(index, (current) => ({ ...current, areaM2: Number(areaM2) }));
  }

  private updateRadiationLink(
    index: number,
    update: (
      link: OvenModelProfile['radiationLinks'][number],
    ) => OvenModelProfile['radiationLinks'][number],
  ): PhysicalModelEditResult {
    if (!this.physicalModelState().radiationLinks[index]) {
      return this.invalidPhysicalEdit(
        `radiationLinks.${index}`,
        'The radiation link does not exist.',
      );
    }
    return this.applyPhysicalModelEdit((profile) => ({
      ...profile,
      radiationLinks: profile.radiationLinks.map((link, linkIndex) =>
        linkIndex === index ? update(link) : link,
      ),
    }));
  }

  private invalidPhysicalEdit(path: string, message: string): PhysicalModelEditResult {
    return { ok: false, errors: [{ path, message }] };
  }

  private applyPhysicalModelEdit(
    update: (profile: OvenModelProfile) => OvenModelProfile,
  ): PhysicalModelEditResult {
    const result = validateAndDerivePhysicalModel(update(this.physicalModelState()));
    if (result.ok) {
      this.physicalModelState.set(cloneOvenModelProfile(result.profile));
      this.advancePhysicalConfigurationRevision();
    }
    return result;
  }

  private advancePhysicalConfigurationRevision(): void {
    this.physicalConfigurationRevisionState.update((revision) => revision + 1);
  }

  setVirtualHardwareConfiguration(
    hardware: VirtualHardwareConfiguration,
  ): VirtualHardwareEditResult {
    return this.applyVirtualHardwareEdit(hardware);
  }

  replaceVirtualPin(index: number, binding: VirtualPinBinding): VirtualHardwareEditResult {
    return this.applyVirtualHardwareEdit({
      ...this.firmwareInLoopHardware(),
      pins: this.firmwareInLoopHardware().pins.map((current, position) =>
        position === index ? binding : current,
      ),
    });
  }

  addVirtualPin(binding: VirtualPinBinding): VirtualHardwareEditResult {
    return this.applyVirtualHardwareEdit({
      ...this.firmwareInLoopHardware(),
      pins: [...this.firmwareInLoopHardware().pins, binding],
    });
  }

  removeVirtualPin(index: number): VirtualHardwareEditResult {
    return this.applyVirtualHardwareEdit({
      ...this.firmwareInLoopHardware(),
      pins: this.firmwareInLoopHardware().pins.filter((_binding, position) => position !== index),
    });
  }

  updateVirtualPin(
    index: number,
    update: (binding: VirtualPinBinding) => VirtualPinBinding,
  ): VirtualHardwareEditResult {
    const hardware = this.firmwareInLoopHardware();
    const binding = hardware.pins[index];
    if (binding === undefined)
      return this.invalidVirtualHardwareEdit(
        `hardware.pins[${index}]`,
        'The virtual pin does not exist.',
      );
    return this.replaceVirtualPin(index, update(binding));
  }

  updateVirtualThermistor(
    key: 'referenceResistanceOhm' | 'nominalResistanceOhm' | 'nominalTemperatureC' | 'betaK',
    value: number,
  ): VirtualHardwareEditResult {
    const hardware = this.firmwareInLoopHardware();
    return this.applyVirtualHardwareEdit({
      ...hardware,
      pins: hardware.pins.map((binding) =>
        binding.kind === 'thermistor-input'
          ? { ...binding, transfer: { ...binding.transfer, [key]: Number(value) } }
          : binding,
      ),
    });
  }

  updateVirtualEepromSize(sizeBytes: number): VirtualHardwareEditResult {
    return this.applyVirtualHardwareEdit({
      ...this.firmwareInLoopHardware(),
      eeprom: { ...this.firmwareInLoopHardware().eeprom, sizeBytes: Number(sizeBytes) },
    });
  }

  updateVirtualEepromFill(initialFill: 0 | 255): VirtualHardwareEditResult {
    return this.applyVirtualHardwareEdit({
      ...this.firmwareInLoopHardware(),
      eeprom: { ...this.firmwareInLoopHardware().eeprom, initialFill },
    });
  }

  resetVirtualHardwareConfiguration(
    hardware: VirtualHardwareConfiguration,
  ): VirtualHardwareEditResult {
    return this.setVirtualHardwareConfiguration(hardware);
  }

  private applyVirtualHardwareEdit(
    hardware: VirtualHardwareConfiguration,
  ): VirtualHardwareEditResult {
    try {
      prepareFirmwarePins(hardware);
    } catch (error) {
      return this.invalidVirtualHardwareEdit(
        error && typeof error === 'object' && 'path' in error && typeof error.path === 'string'
          ? error.path
          : 'hardware',
        error instanceof Error ? error.message : 'The virtual hardware mapping is invalid.',
      );
    }
    this.firmwareHardwareState.set({
      ...hardware,
      pins: hardware.pins.map((binding) =>
        binding.kind === 'thermistor-input'
          ? { ...binding, transfer: { ...binding.transfer } }
          : { ...binding },
      ),
      eeprom: { ...hardware.eeprom },
    });
    this.advancePhysicalConfigurationRevision();
    return { ok: true };
  }

  private invalidVirtualHardwareEdit(path: string, message: string): VirtualHardwareEditResult {
    return { ok: false, errors: [{ path, message }] };
  }

  replaceProfiles(profiles: readonly StoredProfile[]): void {
    this.profilesState.set(profiles);
  }

  addProfile(profile: StoredProfile): void {
    this.profilesState.update((items) => [profile, ...items]);
  }

  replaceProfile(profile: StoredProfile): void {
    this.profilesState.update((items) => [
      profile,
      ...items.filter((item) => item.id !== profile.id),
    ]);
  }

  removeProfile(id: string): void {
    this.profilesState.update((items) => items.filter((profile) => profile.id !== id));
  }

  createProfile(
    name: string,
    kind: ProfileKind,
    state: ProfileState,
    data: JsonValue,
  ): StoredProfile {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      version: 1,
      kind,
      name: name.trim() || 'Untitled profile',
      state,
      createdAt: now,
      updatedAt: now,
      data,
    };
  }
}
