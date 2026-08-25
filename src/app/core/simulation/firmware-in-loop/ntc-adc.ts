import {
  FIRMWARE_ADC_BITS,
  FIRMWARE_ADC_MAX_VALUE,
  type NtcBetaDivider,
} from '../../../../../shared/firmware-contracts';
import { FirmwareInLoopError } from './types';

const ABSOLUTE_ZERO_C = -273.15;

function requireFinitePositive(value: number, path: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      'must be finite and greater than zero',
      path,
    );
  }
}

export function validateNtcBetaDivider(transfer: NtcBetaDivider, path: string): void {
  if (transfer.kind !== 'ntc-beta-divider') {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      "must use the 'ntc-beta-divider' transfer",
      `${path}.kind`,
    );
  }
  requireFinitePositive(transfer.referenceResistanceOhm, `${path}.referenceResistanceOhm`);
  requireFinitePositive(transfer.nominalResistanceOhm, `${path}.nominalResistanceOhm`);
  if (
    !Number.isFinite(transfer.nominalTemperatureC) ||
    transfer.nominalTemperatureC <= ABSOLUTE_ZERO_C
  ) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      'must be finite and above absolute zero',
      `${path}.nominalTemperatureC`,
    );
  }
  requireFinitePositive(transfer.betaK, `${path}.betaK`);
  if (transfer.adcBits !== FIRMWARE_ADC_BITS) {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      `must be ${FIRMWARE_ADC_BITS} for the supported STM32F1 firmware`,
      `${path}.adcBits`,
    );
  }
  if (transfer.topology !== 'reference-to-vcc-thermistor-to-ground') {
    throw new FirmwareInLoopError(
      'INVALID_GPIO_CONFIGURATION',
      'is not supported by the v1 virtual board',
      `${path}.topology`,
    );
  }
}

/**
 * Inverts the exact divider equation consumed by NTC_Thermistor 2.1.0:
 * R = Rref / (ADCmax / adc - 1), hence adc = ADCmax * Rntc / (Rref + Rntc).
 * The only non-continuous behavior is the physical ADC's integer quantization.
 */
export function temperatureToNtcAdc(temperatureC: number, transfer: NtcBetaDivider): number {
  validateNtcBetaDivider(transfer, 'transfer');
  if (!Number.isFinite(temperatureC) || temperatureC <= ABSOLUTE_ZERO_C) {
    throw new FirmwareInLoopError(
      'INVALID_STEP',
      'Thermistor temperature must be finite and above absolute zero.',
      'sensorsC',
    );
  }
  const temperatureK = temperatureC - ABSOLUTE_ZERO_C;
  const nominalK = transfer.nominalTemperatureC - ABSOLUTE_ZERO_C;
  const resistanceOhm =
    transfer.nominalResistanceOhm * Math.exp(transfer.betaK * (1 / temperatureK - 1 / nominalK));
  const maximumAdc = FIRMWARE_ADC_MAX_VALUE;
  const raw = (maximumAdc * resistanceOhm) / (transfer.referenceResistanceOhm + resistanceOhm);
  return Math.max(0, Math.min(maximumAdc, Math.round(raw)));
}
