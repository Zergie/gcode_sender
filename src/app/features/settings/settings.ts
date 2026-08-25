import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ThemePreference } from '../../../../shared/contracts';
import type { NtcBetaDivider, VirtualPinBinding } from '../../../../shared/firmware-contracts';
import type {
  AmbientBoundaryConfiguration,
  RadiationHeatLink,
  ThermalBodyId,
  ThermalTwinGeometry,
} from '../../core/simulation';
import { createDefaultVirtualHardware } from '../../core/simulation/simulation-configuration.store';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { SessionCatalogStore } from '../../core/platform/session-catalog.store';
import { ConfigurationStore } from '../../core/configuration/configuration.store';
import { IconComponent } from '../../shared/icon';
import { PageHeaderComponent } from '../../shared/page-header';

type FirmwarePinRole =
  | 'heater-output'
  | 'thermistor-t1'
  | 'thermistor-t2'
  | 'thermistor-t3'
  | 'indicator-output'
  | 'uart-rx'
  | 'uart-tx'
  | 'digital-input'
  | 'analog-input'
  | 'ignored-output';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, IconComponent, PageHeaderComponent],
  templateUrl: './settings.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsComponent {
  readonly thermalBodyIds: readonly ThermalBodyId[] = [
    'topHeater',
    'bottomHeater',
    'topAir',
    'bottomAir',
    'standardLoad',
    'enclosure',
    't1',
    't2',
    't3',
  ];
  readonly firmwarePinRoles: ReadonlyArray<{ value: FirmwarePinRole; label: string }> = [
    { value: 'heater-output', label: 'Shared heater' },
    { value: 'thermistor-t1', label: 'Thermistor T1' },
    { value: 'thermistor-t2', label: 'Thermistor T2' },
    { value: 'thermistor-t3', label: 'Thermistor T3' },
    { value: 'indicator-output', label: 'LED / indicator' },
    { value: 'uart-rx', label: 'Serial RX' },
    { value: 'uart-tx', label: 'Serial TX' },
    { value: 'digital-input', label: 'Digital input' },
    { value: 'analog-input', label: 'Analog input' },
    { value: 'ignored-output', label: 'Ignored output' },
  ];
  readonly store = inject(WorkbenchStore);
  readonly sessionCatalog = inject(SessionCatalogStore);
  readonly configuration = inject(ConfigurationStore);
  readonly startupMacro = signal('');
  readonly timeoutSeconds = signal(8);
  readonly physicalLineLimitBytes = signal(64 * 1024);
  readonly artifactLimitBytes = signal(4 * 1024 * 1024);
  readonly artifactLimitRecords = signal(10_000);
  readonly osNotifications = signal(true);

  constructor() {
    this.startupMacro.set(this.store.settings().startupMacro);
    this.timeoutSeconds.set(this.store.settings().commandTimeoutMs / 1000);
    this.physicalLineLimitBytes.set(this.store.settings().physicalLineLimitBytes);
    this.artifactLimitBytes.set(this.store.settings().artifactLimitBytes);
    this.artifactLimitRecords.set(this.store.settings().artifactLimitRecords);
  }

  changeTheme(theme: ThemePreference): void {
    this.store.setTheme(theme);
  }

  selectPort(path: string): void {
    this.store.selectedPort.set(path);
    void this.store.updateSettings({ lastSerialPort: path });
  }

  saveRuntimeSettings(): void {
    void this.store.updateSettings({
      startupMacro: this.startupMacro(),
      commandTimeoutMs: Math.max(1, this.timeoutSeconds()) * 1000,
      lastSerialPort: this.store.selectedPort() || null,
      physicalLineLimitBytes: this.physicalLineLimitBytes(),
      artifactLimitBytes: this.artifactLimitBytes(),
      artifactLimitRecords: this.artifactLimitRecords(),
    });
  }

  themeLabel(theme: string): string {
    return theme === 'system' ? 'Follow system' : theme.charAt(0).toUpperCase() + theme.slice(1);
  }

  async chooseFirmware(): Promise<void> {
    await this.store.chooseFirmwareIno();
  }

  updateHeaterPower(which: 'top' | 'bottom', watts: number): void {
    this.configuration.updatePhysicalModel((profile) => ({
      ...profile,
      heaters: {
        ...profile.heaters,
        [which]: { ...profile.heaters[which], ratedPowerW: Number(watts) },
      },
    }));
  }

  updateAmbientTemperature(temperatureC: number): void {
    this.showPhysicalEditResult(
      this.configuration.updateAirProperty('ambientTemperatureC', temperatureC),
    );
  }

  updateFirmwarePin(index: number, pin: string): void {
    this.configuration.updateVirtualHardware((hardware) => ({
      ...hardware,
      pins: hardware.pins.map((binding, position) =>
        position === index ? { ...binding, pin: pin.toUpperCase().trim() } : binding,
      ),
    }));
  }

  updateFirmwarePolarity(index: number, activeLevel: 'high' | 'low'): void {
    this.configuration.updateVirtualHardware((hardware) => ({
      ...hardware,
      pins: hardware.pins.map((binding, position) =>
        position === index &&
        (binding.kind === 'heater-output' || binding.kind === 'indicator-output')
          ? { ...binding, activeLevel }
          : position === index && binding.kind === 'digital-input'
            ? { ...binding, level: activeLevel === 'high' }
            : binding,
      ),
    }));
  }

  firmwarePinRole(binding: VirtualPinBinding): FirmwarePinRole {
    return binding.kind === 'thermistor-input' ? `thermistor-${binding.sensor}` : binding.kind;
  }

  firmwareNtc(): NtcBetaDivider {
    return (
      this.configuration
        .firmwareInLoopHardware()
        .pins.find(
          (binding): binding is Extract<VirtualPinBinding, { kind: 'thermistor-input' }> =>
            binding.kind === 'thermistor-input',
        )?.transfer ??
      (
        createDefaultVirtualHardware().pins[0] as Extract<
          VirtualPinBinding,
          { kind: 'thermistor-input' }
        >
      ).transfer
    );
  }

  updateFirmwareRole(index: number, role: FirmwarePinRole): void {
    const pin = this.configuration.firmwareInLoopHardware().pins[index]?.pin ?? '';
    const ntc =
      this.configuration
        .firmwareInLoopHardware()
        .pins.find(
          (binding): binding is Extract<VirtualPinBinding, { kind: 'thermistor-input' }> =>
            binding.kind === 'thermistor-input',
        )?.transfer ??
      createDefaultVirtualHardware().pins.find(
        (binding): binding is Extract<VirtualPinBinding, { kind: 'thermistor-input' }> =>
          binding.kind === 'thermistor-input',
      )!.transfer;
    let binding: VirtualPinBinding;
    switch (role) {
      case 'heater-output':
        binding = {
          kind: role,
          pin,
          actuator: 'shared-heaters',
          activeLevel: 'high',
          sampling: 'edge-integrated',
        };
        break;
      case 'thermistor-t1':
      case 'thermistor-t2':
      case 'thermistor-t3':
        binding = {
          kind: 'thermistor-input',
          pin,
          sensor: role.slice(-2) as 't1' | 't2' | 't3',
          transfer: { ...ntc },
        };
        break;
      case 'indicator-output':
        binding = {
          kind: role,
          pin,
          indicatorId: `indicator-${pin.toLowerCase() || index + 1}`,
          label: 'Indicator',
          activeLevel: 'high',
        };
        break;
      case 'uart-rx':
      case 'uart-tx':
        binding = { kind: role, pin, uartId: 'console' };
        break;
      case 'digital-input':
        binding = { kind: role, pin, level: false };
        break;
      case 'analog-input':
        binding = { kind: role, pin, rawValue: 0 };
        break;
      case 'ignored-output':
        binding = { kind: role, pin, reason: 'Not connected in the virtual oven' };
        break;
    }
    this.replaceFirmwareBinding(index, binding);
  }

  addFirmwarePin(): void {
    const used = new Set(this.configuration.firmwareInLoopHardware().pins.map(({ pin }) => pin));
    const pin = ['A', 'B', 'C']
      .flatMap((bank) => Array.from({ length: 16 }, (_, number) => `P${bank}${number}`))
      .find((candidate) => !used.has(candidate));
    if (pin === undefined) return;
    this.configuration.updateVirtualHardware((hardware) => ({
      ...hardware,
      pins: [...hardware.pins, { kind: 'digital-input', pin, level: false }],
    }));
  }

  removeFirmwarePin(index: number): void {
    this.configuration.updateVirtualHardware((hardware) => ({
      ...hardware,
      pins: hardware.pins.filter((_binding, position) => position !== index),
    }));
  }

  updateAnalogValue(index: number, rawValue: number): void {
    const binding = this.configuration.firmwareInLoopHardware().pins[index];
    if (binding?.kind === 'analog-input')
      this.replaceFirmwareBinding(index, { ...binding, rawValue: Number(rawValue) });
  }

  updateNtc(key: keyof Omit<NtcBetaDivider, 'kind' | 'topology' | 'adcBits'>, value: number): void {
    this.configuration.updateVirtualHardware((hardware) => ({
      ...hardware,
      pins: hardware.pins.map((binding) =>
        binding.kind === 'thermistor-input'
          ? { ...binding, transfer: { ...binding.transfer, [key]: Number(value) } }
          : binding,
      ),
    }));
  }

  updateEepromFill(initialFill: 0 | 255): void {
    this.configuration.updateVirtualHardware((hardware) => ({
      ...hardware,
      eeprom: { ...hardware.eeprom, initialFill: Number(initialFill) === 0 ? 0 : 255 },
    }));
  }

  private replaceFirmwareBinding(index: number, replacement: VirtualPinBinding): void {
    this.configuration.updateVirtualHardware((hardware) => ({
      ...hardware,
      pins: hardware.pins.map((binding, position) => (position === index ? replacement : binding)),
    }));
  }

  resetFirmwareMapping(): void {
    this.configuration.setVirtualHardware(
      this.configuration.firmwareInLoop()?.suggestedHardware ?? createDefaultVirtualHardware(),
    );
  }

  updateEepromSize(sizeBytes: number): void {
    this.configuration.updateVirtualHardware((hardware) => ({
      ...hardware,
      eeprom: { ...hardware.eeprom, sizeBytes: Number(sizeBytes) },
    }));
  }

  updateGeometry(key: keyof ThermalTwinGeometry, millimeters: number): void {
    this.showPhysicalEditResult(this.configuration.updateGeometry(key, millimeters));
  }

  updateBodyCapacity(body: ThermalBodyId, heatCapacityJPerK: number): void {
    this.configuration.updatePhysicalModel((profile) => ({
      ...profile,
      bodies: {
        ...profile.bodies,
        [body]: { ...profile.bodies[body], heatCapacityJPerK: Number(heatCapacityJPerK) },
      },
    }));
  }

  updateLinearConductance(index: number, conductanceWPerK: number): void {
    this.configuration.updatePhysicalModel((profile) => ({
      ...profile,
      linearLinks: profile.linearLinks.map((link, position) =>
        position === index ? { ...link, conductanceWPerK: Number(conductanceWPerK) } : link,
      ),
    }));
  }

  updateRadiation(
    index: number,
    key: keyof Pick<RadiationHeatLink, 'areaM2' | 'emissivity' | 'viewFactor'>,
    value: number,
  ): void {
    this.configuration.updatePhysicalModel((profile) => ({
      ...profile,
      radiationLinks: profile.radiationLinks.map((link, position) =>
        position === index ? { ...link, [key]: Number(value) } : link,
      ),
    }));
  }

  updateAmbient(key: keyof AmbientBoundaryConfiguration, value: number): void {
    if (key === 'airDensityKgPerM3' || key === 'airSpecificHeatJPerKgK') {
      this.showPhysicalEditResult(this.configuration.updateAirProperty(key, value));
    } else {
      this.configuration.updatePhysicalModel((profile) => ({
        ...profile,
        ambient: { ...profile.ambient, [key]: Number(value) },
      }));
    }
  }

  private showPhysicalEditResult(result: {
    readonly ok: boolean;
    readonly errors?: readonly { readonly path: string; readonly message: string }[];
  }): void {
    if (!result.ok) {
      this.store.notify(
        result.errors?.map((error) => `${error.path}: ${error.message}`).join('; ') ??
          'The physical model is invalid.',
      );
    }
  }

  firmwareRoleLabel(kind: string): string {
    return kind.replaceAll('-', ' ');
  }
}
