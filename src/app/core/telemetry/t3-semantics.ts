/** The approved human-facing meaning of the stable firmware T3 channel. */
export const T3_TELEMETRY_SEMANTICS = Object.freeze({
  channel: 'T3',
  label: 'T3 enclosure sensor',
  description:
    'Temperature measured by the externally exposed enclosure thermistor; informational only.',
  unknown: 'Temperature unknown',
  range: 'Informational reading',
});

export type T3TelemetrySemantics = typeof T3_TELEMETRY_SEMANTICS;
