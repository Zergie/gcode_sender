/** The approved human-facing meaning of the stable firmware T3 channel. */
export const T3_TELEMETRY_SEMANTICS = Object.freeze({
  channel: 'T3',
  label: 'T3 enclosure sensor',
  description:
    'Temperature measured by the externally exposed enclosure thermistor; informational only.',
  unknown: 'Temperature unknown',
  range: 'Informational reading',
  scope: 'host-side experiment integrity',
});

export const T3_EXPERIMENT_BOUNDS_C = Object.freeze({
  minimum: -20,
  maximum: 100,
});

export type T3TelemetrySemantics = typeof T3_TELEMETRY_SEMANTICS;
