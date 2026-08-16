import { createPidSchedule } from '../control';
import type { PidSchedule } from '../control';
import { DEFAULT_THERMAL_TWIN_PROFILE } from './physical-twin';
import type { SimulationControllerConfiguration, OvenModelProfile } from './types';

export const STANDARD_LOAD_PID_SCHEDULE: PidSchedule = createPidSchedule([
  { temperatureC: 100, gains: { kp: 15.8, ki: 0.52, kd: 68 } },
  { temperatureC: 150, gains: { kp: 18.2, ki: 0.73, kd: 82 } },
  { temperatureC: 200, gains: { kp: 21.6, ki: 0.91, kd: 96 } },
]);

export const DEFAULT_OVEN_PROFILE: OvenModelProfile = Object.freeze({
  ...DEFAULT_THERMAL_TWIN_PROFILE,
  kind: 'physical-thermal-rc',
  minimumTemperatureC: -20,
  maximumTemperatureC: 300,
});

export const DEFAULT_SIMULATION_CONTROLLER: SimulationControllerConfiguration = Object.freeze({
  mode: 'pid',
  pid: Object.freeze({
    schedule: STANDARD_LOAD_PID_SCHEDULE,
    gainTransitionSeconds: 5,
  }),
  modelAssistance: Object.freeze({
    predictionHorizonSeconds: 15,
    maximumTargetLeadC: 15,
    minimumCommandC: 0,
    maximumCommandC: 250,
  }),
});

export function cloneOvenModelProfile(profile: OvenModelProfile): OvenModelProfile {
  const candidate = profile as unknown;
  if (isLegacyProfile(candidate)) {
    const migrated = cloneOvenModelProfile(DEFAULT_OVEN_PROFILE);
    const name =
      typeof candidate['name'] === 'string' && candidate['name'].trim()
        ? candidate['name']
        : migrated.name;
    const ambientTemperatureC = finiteOr(
      candidate['ambientTemperatureC'],
      migrated.ambientTemperatureC,
    );
    return {
      ...migrated,
      name,
      ambientTemperatureC,
      heaters: {
        top: {
          ...migrated.heaters.top,
          ratedPowerW: legacyHeaterWatts(candidate['topHeater'], migrated.heaters.top.ratedPowerW),
        },
        bottom: {
          ...migrated.heaters.bottom,
          ratedPowerW: legacyHeaterWatts(
            candidate['bottomHeater'],
            migrated.heaters.bottom.ratedPowerW,
          ),
        },
      },
    };
  }

  return {
    ...profile,
    geometry: { ...profile.geometry },
    bodies: Object.fromEntries(
      Object.entries(profile.bodies).map(([body, configuration]) => [body, { ...configuration }]),
    ) as OvenModelProfile['bodies'],
    heaters: {
      top: { ...profile.heaters.top },
      bottom: { ...profile.heaters.bottom },
    },
    linearLinks: profile.linearLinks.map((link) => ({ ...link })),
    radiationLinks: profile.radiationLinks.map((link) => ({ ...link })),
    ambient: { ...profile.ambient },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLegacyProfile(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value['kind'] === 'dual-zone-shared-actuator';
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function legacyHeaterWatts(value: unknown, fallback: number): number {
  return isRecord(value) ? finiteOr(value['watts'], fallback) : fallback;
}
