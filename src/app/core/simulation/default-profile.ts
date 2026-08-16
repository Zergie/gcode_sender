import { createPidSchedule } from '../control';
import type { PidSchedule } from '../control';
import type { SimulationControllerConfiguration, OvenModelProfile } from './types';

const DEFAULT_HEATER_RESPONSE_TIME_SECONDS = 45;

export const STANDARD_LOAD_PID_SCHEDULE: PidSchedule = createPidSchedule([
  { temperatureC: 100, gains: { kp: 15.8, ki: 0.52, kd: 68 } },
  { temperatureC: 150, gains: { kp: 18.2, ki: 0.73, kd: 82 } },
  { temperatureC: 200, gains: { kp: 21.6, ki: 0.91, kd: 96 } },
]);

export const DEFAULT_OVEN_PROFILE: OvenModelProfile = Object.freeze({
  version: 1,
  kind: 'dual-zone-shared-actuator',
  name: 'Dual-element toaster oven',
  ambientTemperatureC: 22,
  topHeater: Object.freeze({
    watts: 920,
    efficiency: 0.9,
    responseTimeSeconds: DEFAULT_HEATER_RESPONSE_TIME_SECONDS,
  }),
  bottomHeater: Object.freeze({
    watts: 920,
    efficiency: 0.9,
    responseTimeSeconds: DEFAULT_HEATER_RESPONSE_TIME_SECONDS,
  }),
  thermal: Object.freeze({
    topZoneThermalMassJPerC: 2_250,
    bottomZoneThermalMassJPerC: 2_400,
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
    schedule: STANDARD_LOAD_PID_SCHEDULE,
    gainTransitionSeconds: 5,
    outputMinimum: 0,
    outputMaximum: 255,
    integralMinimum: 0,
    integralMaximum: 255,
    derivativeFilterSeconds: 2,
  }),
  modelAssistance: Object.freeze({
    heatingRampCPerMinute: 15,
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
    topHeater: {
      ...profile.topHeater,
      responseTimeSeconds:
        profile.topHeater.responseTimeSeconds ?? DEFAULT_HEATER_RESPONSE_TIME_SECONDS,
    },
    bottomHeater: {
      ...profile.bottomHeater,
      responseTimeSeconds:
        profile.bottomHeater.responseTimeSeconds ?? DEFAULT_HEATER_RESPONSE_TIME_SECONDS,
    },
    thermal: { ...profile.thermal },
    sensors: { ...profile.sensors },
  };
}
