import type { FirmwareInfo, TemperatureTelemetry } from './contracts';

export type ParsedFirmwareLine =
  | { readonly kind: 'telemetry'; readonly value: TemperatureTelemetry }
  | { readonly kind: 'firmware'; readonly value: FirmwareInfo }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ok' }
  | { readonly kind: 'setting'; readonly name: string; readonly value: string }
  | { readonly kind: 'message'; readonly value: string };

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)`;
const M105_PATTERN = new RegExp(
  String.raw`^T0:(${NUMBER})\s+\/(${NUMBER})\s+@:(${NUMBER})\s+T1:(${NUMBER})\s+T2:(${NUMBER})\s+T3:(${NUMBER})$`,
);

const M115_MARKERS = [
  'FIRMWARE_NAME:',
  'SOURCE_CODE_URL:',
  'G_CODE_URL:',
  'PROTOCOL_VERSION:',
  'MACHINE_TYPE:',
  'UUID:',
] as const;

const SETTINGS_PATTERN = /^([^:]+):\s*(.+)$/;
const PROTOCOL_ERROR_PATTERN = /^(?:Unknown (?:G |M )?command!|Parameter .+ is required!)$/i;

export function parseM105(
  line: string,
  timestamp = new Date().toISOString(),
): TemperatureTelemetry | null {
  const match = M105_PATTERN.exec(line.trim());
  if (match === null) {
    return null;
  }

  const values = match.slice(1).map(Number);
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const [average, target, power, thermistor1, thermistor2, thermistor3] = values as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  return {
    timestamp,
    average,
    target,
    power,
    thermistors: [thermistor1, thermistor2, thermistor3],
    raw: line,
  };
}

export function parseM115(line: string): FirmwareInfo | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(M115_MARKERS[0])) {
    return null;
  }

  const positions = M115_MARKERS.map((marker) => ({ marker, index: trimmed.indexOf(marker) }));
  if (positions.some(({ index }) => index < 0)) {
    return null;
  }

  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index]!.index <= positions[index - 1]!.index) {
      return null;
    }
  }

  const values = new Map<string, string>();
  positions.forEach(({ marker, index }, positionIndex) => {
    const start = index + marker.length;
    const end = positions[positionIndex + 1]?.index ?? trimmed.length;
    values.set(marker, trimmed.slice(start, end).trim());
  });

  const firmwareName = values.get('FIRMWARE_NAME:') ?? '';
  if (firmwareName.length === 0) {
    return null;
  }

  return {
    raw: line,
    firmwareName,
    ...optionalField('sourceCodeUrl', values.get('SOURCE_CODE_URL:')),
    ...optionalField('gcodeCatalogUrl', values.get('G_CODE_URL:')),
    ...optionalField('protocolVersion', values.get('PROTOCOL_VERSION:')),
    ...optionalField('machineType', values.get('MACHINE_TYPE:')),
    ...optionalField('uuid', values.get('UUID:')),
  };
}

function optionalField<K extends keyof FirmwareInfo>(
  key: K,
  value: string | undefined,
): Partial<Pick<FirmwareInfo, K>> {
  return value === undefined || value.length === 0
    ? {}
    : ({ [key]: value } as Partial<Pick<FirmwareInfo, K>>);
}

export function parseFirmwareLine(
  line: string,
  timestamp = new Date().toISOString(),
): ParsedFirmwareLine {
  const trimmed = line.trim();
  const telemetry = parseM105(trimmed, timestamp);
  if (telemetry !== null) {
    return { kind: 'telemetry', value: telemetry };
  }

  const firmware = parseM115(trimmed);
  if (firmware !== null) {
    return { kind: 'firmware', value: firmware };
  }

  if (/^ERROR:/i.test(trimmed)) {
    return { kind: 'error', message: trimmed.slice(trimmed.indexOf(':') + 1).trim() };
  }

  if (PROTOCOL_ERROR_PATTERN.test(trimmed)) {
    return { kind: 'error', message: trimmed };
  }

  if (/^ok$/i.test(trimmed)) {
    return { kind: 'ok' };
  }

  const settings = SETTINGS_PATTERN.exec(trimmed);
  if (settings !== null && isFirmwareSetting(settings[1] ?? '')) {
    return { kind: 'setting', name: settings[1]!.trim(), value: settings[2]!.trim() };
  }

  return { kind: 'message', value: trimmed };
}

function isFirmwareSetting(name: string): boolean {
  return /^(?:kp|ki|kd|Heater Check Time|Heater Temperatur Gain|Heater Temperatur Hysteresis|Heater Temperatur Range [0-2])$/i.test(
    name.trim(),
  );
}

export type CommandCompletionKind = 'ok' | 'telemetry' | 'firmware' | 'settings' | 'response';

export function expectedCompletion(command: string): CommandCompletionKind {
  const code = command
    .trim()
    .toUpperCase()
    .match(/^([GMT]\d+(?:\.\d+)?)/)?.[1];
  switch (code) {
    case 'M105':
      return 'telemetry';
    case 'M115':
      return 'firmware';
    case 'M503':
      return 'settings';
    default:
      return 'ok';
  }
}

export function isCompletionForCommand(command: string, response: ParsedFirmwareLine): boolean {
  if (response.kind === 'error') {
    return true;
  }

  switch (expectedCompletion(command)) {
    case 'telemetry':
      return response.kind === 'telemetry';
    case 'firmware':
      return response.kind === 'firmware';
    case 'settings':
      return response.kind === 'setting' && /^Heater Temperatur Range 2$/i.test(response.name);
    case 'response':
      return response.kind !== 'message' || response.value.length > 0;
    case 'ok':
      return response.kind === 'ok';
  }
}
