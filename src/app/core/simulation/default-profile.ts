import type { SimulationControllerConfiguration, OvenModelProfile } from './types';

export const DEFAULT_OVEN_PROFILE: OvenModelProfile = Object.freeze({
  version: 1,
  kind: 'dual-zone-shared-actuator',
  name: 'Dual-element toaster oven',
  ambientTemperatureC: 22,
  topHeater: Object.freeze({ watts: 920, efficiency: 0.9 }),
  bottomHeater: Object.freeze({ watts: 920, efficiency: 0.9 }),
  thermal: Object.freeze({
    topZoneThermalMassJPerC: 4_500,
    bottomZoneThermalMassJPerC: 4_800,
    enclosureThermalMassJPerC: 5_000,
    topZoneHeatLossWPerC: 3,
    bottomZoneHeatLossWPerC: 3.2,
    enclosureHeatLossWPerC: 3,
    zoneCouplingWPerC: 4,
    topToEnclosureCouplingWPerC: 0.6,
    bottomToEnclosureCouplingWPerC: 0.6,
  }),
  actuationDeadTimeSeconds: 2,
  sensors: Object.freeze({
    t1LagSeconds: 2,
    t2LagSeconds: 2,
    t3LagSeconds: 5,
    noiseStandardDeviationC: 0.08,
  }),
  solverStepSeconds: 0.25,
  minimumTemperatureC: -20,
  maximumTemperatureC: 300,
});

export const DEFAULT_SIMULATION_CONTROLLER: SimulationControllerConfiguration = Object.freeze({
  mode: 'pid',
  pid: Object.freeze({
    schedule: Object.freeze([
      Object.freeze({
        temperatureC: 100,
        gains: Object.freeze({ kp: 5, ki: 0.08, kd: 18 }),
      }),
      Object.freeze({
        temperatureC: 150,
        gains: Object.freeze({ kp: 7, ki: 0.1, kd: 22 }),
      }),
      Object.freeze({
        temperatureC: 200,
        gains: Object.freeze({ kp: 9, ki: 0.12, kd: 26 }),
      }),
    ]),
    gainTransitionSeconds: 5,
    outputMinimum: 0,
    outputMaximum: 255,
    integralMinimum: 0,
    integralMaximum: 255,
    derivativeFilterSeconds: 2,
  }),
  modelAssistance: Object.freeze({
    heatingRampCPerMinute: 60,
    coolingRampCPerMinute: 120,
    predictionHorizonSeconds: 15,
    maximumTargetLeadC: 15,
    minimumCommandC: 0,
    maximumCommandC: 250,
  }),
});

export function cloneOvenModelProfile(profile: OvenModelProfile): OvenModelProfile {
  return {
    ...profile,
    topHeater: { ...profile.topHeater },
    bottomHeater: { ...profile.bottomHeater },
    thermal: { ...profile.thermal },
    sensors: { ...profile.sensors },
  };
}
