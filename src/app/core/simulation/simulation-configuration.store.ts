import { Injectable, signal } from '@angular/core';
import {
  FIRMWARE_ADC_BITS,
  type NtcBetaDivider,
  type VirtualHardwareConfiguration,
} from '../../../../shared/firmware-contracts';
import { DEFAULT_OVEN_PROFILE, cloneOvenModelProfile } from './default-profile';

const DEFAULT_NTC_TRANSFER: NtcBetaDivider = {
  kind: 'ntc-beta-divider',
  referenceResistanceOhm: 4_700,
  nominalResistanceOhm: 100_000,
  nominalTemperatureC: 25,
  betaK: 3_950,
  adcBits: FIRMWARE_ADC_BITS,
  topology: 'reference-to-vcc-thermistor-to-ground',
};

export function createDefaultVirtualHardware(): VirtualHardwareConfiguration {
  return {
    version: 1,
    boardProfileId: 'stm32duino-source-compat-v1',
    pins: [
      { kind: 'thermistor-input', pin: 'PA6', sensor: 't1', transfer: { ...DEFAULT_NTC_TRANSFER } },
      { kind: 'thermistor-input', pin: 'PA0', sensor: 't2', transfer: { ...DEFAULT_NTC_TRANSFER } },
      { kind: 'thermistor-input', pin: 'PA5', sensor: 't3', transfer: { ...DEFAULT_NTC_TRANSFER } },
      {
        kind: 'heater-output',
        pin: 'PB9',
        actuator: 'shared-heaters',
        activeLevel: 'high',
        sampling: 'edge-integrated',
      },
      {
        kind: 'indicator-output',
        pin: 'PC13',
        indicatorId: 'status-led',
        label: 'Status LED',
        activeLevel: 'low',
      },
      { kind: 'uart-rx', pin: 'PA10', uartId: 'console' },
      { kind: 'uart-tx', pin: 'PA9', uartId: 'console' },
    ],
    eeprom: { initialFill: 255, sizeBytes: 1_024 },
  };
}

@Injectable({ providedIn: 'root' })
export class SimulationConfigurationStore {
  readonly profile = signal(cloneOvenModelProfile(DEFAULT_OVEN_PROFILE));
  readonly hardware = signal(createDefaultVirtualHardware());
}
