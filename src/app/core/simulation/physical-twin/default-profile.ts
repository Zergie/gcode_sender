import type { ThermalTwinProfile } from './types';

const WIDTH_M = 0.08;
const DEPTH_M = 0.22;
const HEIGHT_M = 0.06;
const CHAMBER_VOLUME_M3 = WIDTH_M * DEPTH_M * HEIGHT_M;
const ENCLOSURE_AREA_M2 = 2 * (WIDTH_M * DEPTH_M + WIDTH_M * HEIGHT_M + DEPTH_M * HEIGHT_M);

const AIR_DENSITY_KG_PER_M3 = 1.204;
const AIR_SPECIFIC_HEAT_J_PER_KG_K = 1_005;
const HALF_CHAMBER_AIR_CAPACITY_J_PER_K =
  (CHAMBER_VOLUME_M3 * AIR_DENSITY_KG_PER_M3 * AIR_SPECIFIC_HEAT_J_PER_KG_K) / 2;

/**
 * Initial physical parameters for the 80 x 220 x 60 mm v1 chamber geometry.
 * The material quantities below are starting estimates, not fitted waveform knobs:
 *
 * - each low-mass heater coil: 0.020 kg metal-equivalent at 500 J/(kg K)
 * - standard load: 0.80 kg aluminium-equivalent at 900 J/(kg K)
 * - enclosure and attached structure: 4.60 kg steel-equivalent at 500 J/(kg K)
 * - thermistor bodies: 0.12 J/K each, with their response arising from contact conductance
 *
 * Heater developed area, enclosure leakage, and thermal bridges were initialized against the
 * deterministic v1 100% heat/cool reference. They retain ordinary physical units and are the
 * parameters to replace when measurements of the real oven become available.
 */
export const DEFAULT_THERMAL_TWIN_PROFILE: ThermalTwinProfile = Object.freeze({
  version: 1,
  name: '80 x 220 x 60 mm dual-heater oven with standard load',
  geometry: Object.freeze({
    widthM: WIDTH_M,
    depthM: DEPTH_M,
    heightM: HEIGHT_M,
  }),
  ambientTemperatureC: 22,
  solverStepSeconds: 0.05,
  bodies: Object.freeze({
    topHeater: Object.freeze({ heatCapacityJPerK: 0.02 * 500 }),
    bottomHeater: Object.freeze({ heatCapacityJPerK: 0.02 * 500 }),
    topAir: Object.freeze({ heatCapacityJPerK: HALF_CHAMBER_AIR_CAPACITY_J_PER_K }),
    bottomAir: Object.freeze({ heatCapacityJPerK: HALF_CHAMBER_AIR_CAPACITY_J_PER_K }),
    standardLoad: Object.freeze({ heatCapacityJPerK: 0.8 * 900 }),
    enclosure: Object.freeze({ heatCapacityJPerK: 4.6 * 500 }),
    t1: Object.freeze({ heatCapacityJPerK: 0.12 }),
    t2: Object.freeze({ heatCapacityJPerK: 0.12 }),
    t3: Object.freeze({ heatCapacityJPerK: 0.12 }),
  }),
  heaters: Object.freeze({
    // Two equal halves of the v1 heater's approximately 1.8 kW useful electrical dissipation.
    top: Object.freeze({ body: 'topHeater', ratedPowerW: 900 }),
    bottom: Object.freeze({ body: 'bottomHeater', ratedPowerW: 900 }),
  }),
  linearLinks: Object.freeze([
    Object.freeze({
      a: 'topHeater',
      b: 'topAir',
      mechanism: 'convection',
      // 0.7 W/K over 0.04 m2 is a 17.5 W/(m2 K) mixed-convection coefficient.
      conductanceWPerK: 0.7,
    }),
    Object.freeze({
      a: 'bottomHeater',
      b: 'bottomAir',
      mechanism: 'convection',
      conductanceWPerK: 0.7,
    }),
    Object.freeze({
      a: 'topAir',
      b: 'bottomAir',
      mechanism: 'convection',
      conductanceWPerK: 0.12,
    }),
    Object.freeze({
      a: 'topAir',
      b: 'standardLoad',
      mechanism: 'convection',
      conductanceWPerK: 0.088,
    }),
    Object.freeze({
      a: 'bottomAir',
      b: 'standardLoad',
      mechanism: 'convection',
      conductanceWPerK: 0.088,
    }),
    Object.freeze({
      a: 'topAir',
      b: 'enclosure',
      mechanism: 'convection',
      conductanceWPerK: 0.143,
    }),
    Object.freeze({
      a: 'bottomAir',
      b: 'enclosure',
      mechanism: 'convection',
      conductanceWPerK: 0.143,
    }),
    Object.freeze({
      a: 'standardLoad',
      b: 'enclosure',
      mechanism: 'conduction',
      conductanceWPerK: 0.5,
    }),
    Object.freeze({
      a: 'topAir',
      b: 't1',
      mechanism: 'sensor-contact',
      conductanceWPerK: 0.06,
    }),
    Object.freeze({
      a: 'bottomAir',
      b: 't2',
      mechanism: 'sensor-contact',
      conductanceWPerK: 0.06,
    }),
    Object.freeze({
      a: 'enclosure',
      b: 't3',
      mechanism: 'sensor-contact',
      conductanceWPerK: 0.024,
    }),
  ]),
  radiationLinks: Object.freeze([
    Object.freeze({
      a: 'topHeater',
      b: 'standardLoad',
      // Developed coil area; it is larger than the element's projected area.
      areaM2: 0.04,
      emissivity: 0.85,
      viewFactor: 0.2,
    }),
    Object.freeze({
      a: 'topHeater',
      b: 'enclosure',
      areaM2: 0.04,
      emissivity: 0.85,
      viewFactor: 0.7,
    }),
    Object.freeze({
      a: 'bottomHeater',
      b: 'standardLoad',
      areaM2: 0.04,
      emissivity: 0.85,
      viewFactor: 0.2,
    }),
    Object.freeze({
      a: 'bottomHeater',
      b: 'enclosure',
      areaM2: 0.04,
      emissivity: 0.85,
      viewFactor: 0.7,
    }),
    Object.freeze({
      a: 'standardLoad',
      b: 'enclosure',
      areaM2: 2 * WIDTH_M * DEPTH_M,
      emissivity: 0.8,
      viewFactor: 0.8,
    }),
  ]),
  ambient: Object.freeze({
    enclosureConductanceWPerK: 2,
    enclosureRadiatingAreaM2: ENCLOSURE_AREA_M2,
    enclosureEmissivity: 0.8,
    // Equivalent leakage/ventilation flow of the historically very small, open chamber.
    topAirExchangeM3PerSecond: 0.0014,
    bottomAirExchangeM3PerSecond: 0.0014,
    // Exposed safety bead and lead-wire path to room air; paired with 0.024 W/K to enclosure.
    t3AmbientConductanceWPerK: 0.12,
    airDensityKgPerM3: AIR_DENSITY_KG_PER_M3,
    airSpecificHeatJPerKgK: AIR_SPECIFIC_HEAT_J_PER_KG_K,
  }),
});
