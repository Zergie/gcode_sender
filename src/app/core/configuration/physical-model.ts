import { validateOvenModelProfile } from '../simulation';
import { cloneOvenModelProfile, type OvenModelProfile } from '../simulation';
import type { AmbientBoundaryConfiguration, ThermalTwinGeometry } from '../simulation';

export interface PhysicalModelValidationDetail {
  readonly path: string;
  readonly message: string;
}

export type PhysicalModelEditResult =
  | { readonly ok: true; readonly profile: OvenModelProfile }
  | { readonly ok: false; readonly errors: readonly PhysicalModelValidationDetail[] };

/** Rebuilds every value that is implied by geometry or chamber-air properties. */
export function derivePhysicalModel(profile: OvenModelProfile): OvenModelProfile {
  const candidate = cloneOvenModelProfile(profile);
  const { widthM, depthM, heightM } = candidate.geometry;
  const enclosureRadiatingAreaM2 = 2 * (widthM * depthM + widthM * heightM + depthM * heightM);
  const standardLoadRadiatingAreaM2 = 2 * widthM * depthM;
  const halfAirCapacityJPerK =
    (widthM *
      depthM *
      heightM *
      candidate.ambient.airDensityKgPerM3 *
      candidate.ambient.airSpecificHeatJPerKgK) /
    2;

  return {
    ...candidate,
    ambient: { ...candidate.ambient, enclosureRadiatingAreaM2 },
    bodies: {
      ...candidate.bodies,
      topAir: { heatCapacityJPerK: halfAirCapacityJPerK },
      bottomAir: { heatCapacityJPerK: halfAirCapacityJPerK },
    },
    radiationLinks: candidate.radiationLinks.map((link) =>
      isStandardLoadEnclosureLink(link.a, link.b)
        ? { ...link, areaM2: standardLoadRadiatingAreaM2 }
        : link,
    ),
  };
}

export function validateAndDerivePhysicalModel(
  candidate: OvenModelProfile,
): PhysicalModelEditResult {
  const derived = derivePhysicalModel(candidate);
  try {
    validateOvenModelProfile(derived);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: error instanceof Error && 'path' in error ? String(error.path) : 'profile',
          message: error instanceof Error ? error.message : 'The physical model is invalid.',
        },
      ],
    };
  }
  return { ok: true, profile: derived };
}

export function isStandardLoadEnclosureLink(
  a: OvenModelProfile['radiationLinks'][number]['a'],
  b: OvenModelProfile['radiationLinks'][number]['b'],
): boolean {
  return (a === 'standardLoad' && b === 'enclosure') || (a === 'enclosure' && b === 'standardLoad');
}

export type PhysicalGeometryKey = keyof ThermalTwinGeometry;
export type PhysicalAirPropertyKey =
  | keyof Pick<AmbientBoundaryConfiguration, 'airDensityKgPerM3' | 'airSpecificHeatJPerKgK'>
  | 'ambientTemperatureC';
