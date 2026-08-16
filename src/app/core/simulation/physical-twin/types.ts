export const THERMAL_BODY_IDS = [
  'topHeater',
  'bottomHeater',
  'topAir',
  'bottomAir',
  'standardLoad',
  'enclosure',
  't1',
  't2',
  't3',
] as const;

export type ThermalBodyId = (typeof THERMAL_BODY_IDS)[number];

export type ThermalTemperatures = Readonly<Record<ThermalBodyId, number>>;

export interface ThermalTwinGeometry {
  readonly widthM: number;
  readonly depthM: number;
  readonly heightM: number;
}

export interface ThermalBodyConfiguration {
  /** Lumped heat capacity, mass multiplied by specific heat, in joules per kelvin. */
  readonly heatCapacityJPerK: number;
}

export interface HeaterConfiguration {
  readonly body: 'topHeater' | 'bottomHeater';
  /** Electrical power dissipated in the resistive heater body at full shared duty. */
  readonly ratedPowerW: number;
}

export type LinearHeatTransferMechanism = 'conduction' | 'convection' | 'sensor-contact';

export interface LinearHeatLink {
  readonly a: ThermalBodyId;
  readonly b: ThermalBodyId;
  readonly mechanism: LinearHeatTransferMechanism;
  /** Thermal conductance between the two bodies in watts per kelvin. */
  readonly conductanceWPerK: number;
}

export interface RadiationHeatLink {
  readonly a: ThermalBodyId;
  readonly b: ThermalBodyId;
  /** Mutually visible emitting surface area. */
  readonly areaM2: number;
  /** Effective grey-body emissivity of the surface pair, in the closed interval 0..1. */
  readonly emissivity: number;
  /** Fraction of radiation from the area that reaches the other body, in 0..1. */
  readonly viewFactor: number;
}

export interface AmbientBoundaryConfiguration {
  /** Conductive/convective enclosure-to-room conductance. */
  readonly enclosureConductanceWPerK: number;
  readonly enclosureRadiatingAreaM2: number;
  readonly enclosureEmissivity: number;
  /** Volumetric room-air exchange for each chamber half. */
  readonly topAirExchangeM3PerSecond: number;
  readonly bottomAirExchangeM3PerSecond: number;
  /** Conductance from the externally exposed T3 bead and its leads to room air. */
  readonly t3AmbientConductanceWPerK: number;
  readonly airDensityKgPerM3: number;
  readonly airSpecificHeatJPerKgK: number;
}

/**
 * A calibratable physical description of the oven. There are deliberately no
 * response-time, dead-time, noise, or oscillation parameters in this profile.
 */
export interface ThermalTwinProfile {
  readonly version: 1;
  readonly name: string;
  readonly geometry: ThermalTwinGeometry;
  readonly ambientTemperatureC: number;
  readonly solverStepSeconds: number;
  readonly bodies: Readonly<Record<ThermalBodyId, ThermalBodyConfiguration>>;
  readonly heaters: Readonly<{
    top: HeaterConfiguration;
    bottom: HeaterConfiguration;
  }>;
  readonly linearLinks: readonly LinearHeatLink[];
  readonly radiationLinks: readonly RadiationHeatLink[];
  readonly ambient: AmbientBoundaryConfiguration;
}

export interface ThermalTwinInitialConditions {
  readonly profile?: ThermalTwinProfile;
  /** Used for every body not explicitly listed in initialTemperaturesC. */
  readonly initialTemperatureC?: number;
  readonly initialTemperaturesC?: Partial<Record<ThermalBodyId, number>>;
}

export interface ThermalTwinAdvanceCommand {
  /** Must be an integer multiple of the profile's fixed solver step. */
  readonly durationSeconds: number;
  /** One actuator command applied identically to both heater power ratings. */
  readonly duty: number;
}

export interface ThermalEnergyLedger {
  /** Internal energy relative to the arbitrary 0 C reference at twin creation. */
  readonly initialInternalEnergyJ: number;
  /** Internal energy relative to the same 0 C reference. */
  readonly currentInternalEnergyJ: number;
  readonly internalEnergyChangeJ: number;
  readonly electricalInputJ: number;
  /** Positive when heat has left the nine modeled bodies for the room. */
  readonly netHeatToAmbientJ: number;
  /** internal change - electrical input + net heat to ambient. */
  readonly balanceResidualJ: number;
}

export interface ThermalTwinSnapshot {
  readonly timeSeconds: number;
  readonly duty: number;
  readonly temperaturesC: ThermalTemperatures;
  readonly energy: ThermalEnergyLedger;
}

export interface ThermalSensorObservation {
  readonly t1C: number;
  readonly t2C: number;
  readonly t3C: number;
}

export interface ThermalObserverCorrection {
  readonly previousSensorsC: ThermalSensorObservation;
  readonly observedSensorsC: ThermalSensorObservation;
  /** Energy imposed on the three sensor states by estimator correction, not by plant heat flow. */
  readonly imposedInternalEnergyChangeJ: number;
  /**
   * Corrected state at the same simulation time. Its physical energy ledger begins a new epoch:
   * internal change, electrical input, ambient heat, and residual are all zero.
   */
  readonly snapshot: ThermalTwinSnapshot;
}

/** Mutable simulation cursor. fork() is an independent copy at exactly the same state. */
export interface ThermalTwin {
  readonly profile: ThermalTwinProfile;
  snapshot(): ThermalTwinSnapshot;
  advance(command: ThermalTwinAdvanceCommand): ThermalTwinSnapshot;
  assimilateSensorObservation(observation: ThermalSensorObservation): ThermalObserverCorrection;
  fork(): ThermalTwin;
}

export class ThermalTwinValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ThermalTwinValidationError';
  }
}
