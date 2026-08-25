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
import { DEFAULT_OVEN_PROFILE, cloneOvenModelProfile, type OvenModelProfile } from '../simulation';
import { createDefaultVirtualHardware } from '../simulation/simulation-configuration.store';
import type { VirtualHardwareConfiguration } from '../../../../shared/firmware-contracts';

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

@Injectable({ providedIn: 'root' })
export class ConfigurationStore {
  private readonly settingsState = signal<AppSettings>(DEFAULT_APP_SETTINGS);
  private readonly firmwareState = signal<PreparedFirmware | null>(null);
  private readonly firmwareHardwareState = signal(createDefaultVirtualHardware());
  private readonly firmwareBuildingState = signal(false);
  private readonly physicalModelState = signal(cloneOvenModelProfile(DEFAULT_OVEN_PROFILE));
  private readonly profilesState = signal<readonly StoredProfile[]>([]);

  readonly settings = this.settingsState.asReadonly();
  readonly firmwareInLoop = this.firmwareState.asReadonly();
  readonly firmwareInLoopHardware = this.firmwareHardwareState.asReadonly();
  readonly firmwareInLoopBuilding = this.firmwareBuildingState.asReadonly();
  readonly ovenModelProfile = this.physicalModelState.asReadonly();
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
    this.physicalModelState.set(cloneOvenModelProfile(profile));
  }

  updatePhysicalModel(update: (profile: OvenModelProfile) => OvenModelProfile): void {
    this.physicalModelState.update((profile) => cloneOvenModelProfile(update(profile)));
  }

  setVirtualHardware(hardware: VirtualHardwareConfiguration): void {
    this.firmwareHardwareState.set(hardware);
  }

  updateVirtualHardware(
    update: (hardware: VirtualHardwareConfiguration) => VirtualHardwareConfiguration,
  ): void {
    this.firmwareHardwareState.update(update);
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
