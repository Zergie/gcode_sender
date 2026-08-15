import { deriveRelayPidGains } from './gain-calculation';
import { isCompletePidSnapshot, parseM105Telemetry, parseM503SnapshotLine } from './parsers';
import { TuningDomainError } from './tuning-error';
import type {
  CalibrationDraft,
  CalibrationEffect,
  CalibrationEvent,
  CalibrationFault,
  CalibrationFaultCode,
  CalibrationLimits,
  CalibrationOptions,
  CalibrationState,
  CalibrationTransition,
  M105Telemetry,
  OutstandingCommand,
  PeakTracker,
  PidGains,
  RelayPeak,
  ResolvedCalibrationOptions,
  TerminalIntent,
} from './types';

const TARGET_DELTA_C = 5;
const REQUIRED_PEAK_COUNT = 12;
const ABSOLUTE_MAXIMUM_TEMPERATURE_C = 250;
const MAXIMUM_EXPERIMENT_DURATION_MS = 4 * 60 * 60 * 1000;

const DEFAULT_LIMITS: CalibrationLimits = Object.freeze({
  maximumTemperatureC: 250,
  maximumDurationMs: 45 * 60 * 1000,
  telemetryTimeoutMs: 5_000,
  maximumSensorSpreadC: 30,
  t3MinimumC: -20,
  t3MaximumC: 100,
  actuatorGraceMs: 2_500,
  maximumActuatorViolations: 2,
  highOutputMinimum: 240,
  lowOutputMaximum: 15,
  minimumPeakSwingC: 0.25,
  maximumSamples: 20_000,
});

type AckPurpose = OutstandingCommand['purpose'];

function finitePositive(value: number, path: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TuningDomainError(
      'INVALID_CONFIGURATION',
      `${path} must be finite and greater than zero.`,
      path,
    );
  }
}

export function resolveCalibrationOptions(options: CalibrationOptions): ResolvedCalibrationOptions {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  finitePositive(options.targetC, 'targetC');
  if (!Number.isInteger(options.targetC)) {
    throw new TuningDomainError(
      'INVALID_CONFIGURATION',
      'targetC must be a whole degree because the supported firmware truncates M104 targets.',
      'targetC',
    );
  }
  if (
    options.targetC <= TARGET_DELTA_C ||
    options.targetC > limits.maximumTemperatureC ||
    limits.maximumTemperatureC > ABSOLUTE_MAXIMUM_TEMPERATURE_C
  ) {
    throw new TuningDomainError(
      'INVALID_CONFIGURATION',
      'The target must be above 5 °C, within the operator limit, and never exceed 250 °C.',
      'targetC',
    );
  }

  const relayKp = options.relayKp ?? 255;
  const telemetryPollMs = options.telemetryPollMs ?? 1_000;
  finitePositive(relayKp, 'relayKp');
  finitePositive(telemetryPollMs, 'telemetryPollMs');
  finitePositive(limits.maximumTemperatureC, 'limits.maximumTemperatureC');
  finitePositive(limits.maximumDurationMs, 'limits.maximumDurationMs');
  finitePositive(limits.telemetryTimeoutMs, 'limits.telemetryTimeoutMs');
  finitePositive(limits.maximumSensorSpreadC, 'limits.maximumSensorSpreadC');
  finitePositive(limits.actuatorGraceMs, 'limits.actuatorGraceMs');
  finitePositive(limits.minimumPeakSwingC, 'limits.minimumPeakSwingC');
  finitePositive(limits.maximumSamples, 'limits.maximumSamples');

  if (limits.maximumDurationMs > MAXIMUM_EXPERIMENT_DURATION_MS) {
    throw new TuningDomainError(
      'INVALID_CONFIGURATION',
      'maximumDurationMs cannot exceed four hours.',
      'limits.maximumDurationMs',
    );
  }
  if (!Number.isInteger(limits.maximumActuatorViolations) || limits.maximumActuatorViolations < 0) {
    throw new TuningDomainError(
      'INVALID_CONFIGURATION',
      'maximumActuatorViolations must be a non-negative integer.',
      'limits.maximumActuatorViolations',
    );
  }
  if (!Number.isInteger(limits.maximumSamples) || limits.maximumSamples < REQUIRED_PEAK_COUNT) {
    throw new TuningDomainError(
      'INVALID_CONFIGURATION',
      'maximumSamples must be an integer of at least 12.',
      'limits.maximumSamples',
    );
  }
  if (
    !Number.isFinite(limits.t3MinimumC) ||
    !Number.isFinite(limits.t3MaximumC) ||
    limits.t3MinimumC >= limits.t3MaximumC
  ) {
    throw new TuningDomainError(
      'INVALID_CONFIGURATION',
      'The T3 limits must be finite and ordered.',
      'limits.t3MinimumC',
    );
  }
  if (
    !Number.isFinite(limits.highOutputMinimum) ||
    !Number.isFinite(limits.lowOutputMaximum) ||
    limits.lowOutputMaximum < 0 ||
    limits.highOutputMinimum > 255 ||
    limits.lowOutputMaximum >= limits.highOutputMinimum
  ) {
    throw new TuningDomainError(
      'INVALID_CONFIGURATION',
      'Actuator thresholds must define non-overlapping low/high ranges inside 0..255.',
      'limits.highOutputMinimum',
    );
  }

  return Object.freeze({
    targetC: options.targetC,
    lowTargetC: options.targetC - TARGET_DELTA_C,
    relayKp,
    telemetryPollMs,
    requiredPeakCount: REQUIRED_PEAK_COUNT,
    limits: Object.freeze(limits),
  });
}

export function createCalibrationState(options: CalibrationOptions): CalibrationState {
  return {
    phase: 'idle',
    options: resolveCalibrationOptions(options),
    snapshot: {},
    relayMayBeConfigured: false,
    peaks: [],
    samples: [],
    consecutiveActuatorViolations: 0,
    commandSequence: 0,
    outstandingCommands: [],
  };
}

function formatNumber(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '');
}

function pidCommand(gains: PidGains): string {
  return `M301 P${formatNumber(gains.kp)} I${formatNumber(gains.ki)} D${formatNumber(gains.kd)}`;
}

function sendWithoutAck(
  state: CalibrationState,
  command: string,
  purpose: 'snapshot' | 'poll-telemetry' | 'confirm-zero',
): CalibrationTransition {
  const commandId = state.commandSequence + 1;
  return {
    state: { ...state, commandSequence: commandId },
    effects: [
      {
        type: 'send-gcode',
        commandId,
        command,
        purpose,
        expectsAcknowledgement: false,
      },
    ],
  };
}

function sendWithAck(
  state: CalibrationState,
  command: string,
  purpose: AckPurpose,
  atMs: number,
): CalibrationTransition {
  const commandId = state.commandSequence + 1;
  const outstanding: OutstandingCommand = { id: commandId, command, purpose, sentAtMs: atMs };
  return {
    state: {
      ...state,
      commandSequence: commandId,
      outstandingCommands: [...state.outstandingCommands, outstanding],
      actionStartedAtMs: atMs,
    },
    effects: [
      {
        type: 'send-gcode',
        commandId,
        command,
        purpose,
        expectsAcknowledgement: true,
      },
    ],
  };
}

function withEffects(
  transition: CalibrationTransition,
  ...effects: readonly CalibrationEffect[]
): CalibrationTransition {
  return { state: transition.state, effects: [...transition.effects, ...effects] };
}

function makeFault(code: CalibrationFaultCode, message: string, atMs: number): CalibrationFault {
  return { code, message, scope: 'experiment-integrity', atMs };
}

function isTerminal(phase: CalibrationState['phase']): boolean {
  return phase === 'completed' || phase === 'cancelled' || phase === 'faulted';
}

function isTerminating(phase: CalibrationState['phase']): boolean {
  return ['disarming-relay', 'setting-zero-target', 'confirming-zero', 'restoring-gains'].includes(
    phase,
  );
}

function finishTerminal(state: CalibrationState): CalibrationTransition {
  const intent = state.terminalIntent;
  if (intent === undefined) {
    return { state, effects: [] };
  }
  const phase = intent.outcome;
  return {
    state: {
      ...state,
      phase,
      fault: intent.fault,
      outstandingCommands: [],
      actionStartedAtMs: undefined,
    },
    effects: [
      {
        type: 'notice',
        level:
          intent.outcome === 'completed'
            ? 'info'
            : intent.outcome === 'cancelled'
              ? 'warning'
              : 'error',
        code: intent.fault?.code ?? intent.outcome.toUpperCase(),
        message:
          intent.outcome === 'completed'
            ? 'Calibration draft is ready; no gains were applied or persisted.'
            : (intent.fault?.message ?? intent.reason ?? 'Calibration cancelled.'),
      },
    ],
  };
}

function beginTermination(
  state: CalibrationState,
  intent: TerminalIntent,
  atMs: number,
): CalibrationTransition {
  if (isTerminal(state.phase)) {
    return { state, effects: [] };
  }
  if (isTerminating(state.phase)) {
    return {
      state: { ...state, terminalIntent: intent },
      effects: [
        {
          type: 'notice',
          level: 'warning',
          code: 'STOPPING',
          message: 'The best-effort stop sequence is already in progress.',
        },
      ],
    };
  }
  if (!state.relayMayBeConfigured) {
    return finishTerminal({ ...state, terminalIntent: intent });
  }
  const prepared: CalibrationState = {
    ...state,
    phase: 'disarming-relay',
    terminalIntent: intent,
    consecutiveActuatorViolations: 0,
  };
  const transition = sendWithAck(prepared, 'M301 P0 I0 D0', 'disarm-relay', atMs);
  return withEffects(transition, {
    type: 'notice',
    level: intent.outcome === 'faulted' ? 'error' : 'info',
    code: intent.fault?.code ?? 'STOPPING',
    message:
      'Stopping the host-side experiment with best-effort commands; firmware remains the safety authority.',
  });
}

function fail(
  state: CalibrationState,
  code: CalibrationFaultCode,
  message: string,
  atMs: number,
): CalibrationTransition {
  return beginTermination(
    state,
    { outcome: 'faulted', fault: makeFault(code, message, atMs) },
    atMs,
  );
}

function removeOutstanding(
  state: CalibrationState,
  commandId: number,
): { readonly state: CalibrationState; readonly command?: OutstandingCommand } {
  const command = state.outstandingCommands.find((candidate) => candidate.id === commandId);
  if (command === undefined) {
    return { state };
  }
  return {
    state: {
      ...state,
      outstandingCommands: state.outstandingCommands.filter(
        (candidate) => candidate.id !== commandId,
      ),
    },
    command,
  };
}

function enterRunning(state: CalibrationState, atMs: number): CalibrationTransition {
  const running: CalibrationState = {
    ...state,
    phase: 'running',
    lastTelemetryAtMs: atMs,
    nextPollAtMs: atMs + state.options.telemetryPollMs,
    tracker: {
      direction: 'heating',
      directionChangedAtMs: atMs,
      completedCoolingSegment: false,
    },
  };
  return sendWithoutAck(running, 'M105', 'poll-telemetry');
}

function acknowledge(
  state: CalibrationState,
  commandId: number,
  atMs: number,
): CalibrationTransition {
  const removed = removeOutstanding(state, commandId);
  const command = removed.command;
  if (command === undefined) {
    return { state, effects: [] };
  }
  const next = removed.state;
  switch (command.purpose) {
    case 'configure-relay': {
      const prepared = { ...next, phase: 'setting-initial-target' as const };
      return sendWithAck(
        prepared,
        `M104 S${formatNumber(state.options.targetC)}`,
        'set-initial-target',
        atMs,
      );
    }
    case 'set-initial-target':
      return enterRunning(next, atMs);
    case 'disarm-relay': {
      const prepared = { ...next, phase: 'setting-zero-target' as const };
      return sendWithAck(prepared, 'M104 S0', 'set-zero-target', atMs);
    }
    case 'set-zero-target': {
      const confirming: CalibrationState = {
        ...next,
        phase: 'confirming-zero',
        lastTelemetryAtMs: atMs,
        nextPollAtMs: atMs + next.options.telemetryPollMs,
        actionStartedAtMs: atMs,
      };
      return sendWithoutAck(confirming, 'M105', 'confirm-zero');
    }
    case 'restore-gains':
      return finishTerminal(next);
    case 'switch-high':
    case 'switch-low':
      return { state: next, effects: [] };
  }
}

function firstOutstandingId(state: CalibrationState): number | undefined {
  return state.outstandingCommands[0]?.id;
}

function snapshotLine(
  state: CalibrationState,
  line: string,
  atMs: number,
): CalibrationTransition | undefined {
  if (state.phase !== 'snapshotting') {
    return undefined;
  }
  const parsed = parseM503SnapshotLine(line);
  if (parsed === undefined) {
    return undefined;
  }
  const existing = state.snapshot[parsed.key];
  if (existing !== undefined && existing !== parsed.value) {
    return fail(
      state,
      'PID_SNAPSHOT_UNAVAILABLE',
      `M503 returned conflicting ${parsed.key} values; tuning was not started.`,
      atMs,
    );
  }
  const snapshot = { ...state.snapshot, [parsed.key]: parsed.value };
  if (!isCompletePidSnapshot(snapshot)) {
    return { state: { ...state, snapshot }, effects: [] };
  }
  const originalGains = { ...snapshot };
  const configuring: CalibrationState = {
    ...state,
    phase: 'configuring-relay',
    snapshot,
    originalGains,
    relayMayBeConfigured: true,
  };
  return sendWithAck(
    configuring,
    pidCommand({ kp: state.options.relayKp, ki: 0, kd: 0 }),
    'configure-relay',
    atMs,
  );
}

function appendSample(state: CalibrationState, sample: M105Telemetry): CalibrationState {
  const samples = [...state.samples, sample];
  const overflow = samples.length - state.options.limits.maximumSamples;
  return { ...state, samples: overflow > 0 ? samples.slice(overflow) : samples };
}

function telemetryFault(
  state: CalibrationState,
  sample: M105Telemetry,
): { readonly code: CalibrationFaultCode; readonly message: string } | undefined {
  const values = [
    sample.atMs,
    sample.t0C,
    sample.t1C,
    sample.t2C,
    sample.t3C,
    sample.reportedTargetC,
    sample.output,
  ];
  if (
    !values.every(Number.isFinite) ||
    sample.atMs < 0 ||
    sample.output < 0 ||
    sample.output > 255
  ) {
    return { code: 'INVALID_TELEMETRY', message: 'M105 telemetry contains invalid values.' };
  }
  if (state.lastTelemetryAtMs !== undefined && sample.atMs <= state.lastTelemetryAtMs) {
    return {
      code: 'NON_MONOTONIC_TELEMETRY',
      message: 'M105 telemetry timestamps must be strictly increasing.',
    };
  }
  const { limits } = state.options;
  if (Math.max(sample.t0C, sample.t1C, sample.t2C) > limits.maximumTemperatureC) {
    return {
      code: 'MAXIMUM_TEMPERATURE',
      message: 'The operator-defined experiment temperature limit was exceeded.',
    };
  }
  if (Math.abs(sample.t1C - sample.t2C) > limits.maximumSensorSpreadC) {
    return {
      code: 'SENSOR_SPREAD',
      message: 'T1/T2 spread exceeded the operator-defined experiment limit.',
    };
  }
  if (sample.t3C < limits.t3MinimumC || sample.t3C > limits.t3MaximumC) {
    return {
      code: 'T3_OUT_OF_BOUNDS',
      message: 'T3 exceeded the operator-defined experiment bounds.',
    };
  }
  return undefined;
}

function trackerWithSample(tracker: PeakTracker, sample: M105Telemetry): PeakTracker {
  const extreme = tracker.extremeTemperatureC;
  const isMoreExtreme =
    extreme === undefined ||
    (tracker.direction === 'heating' ? sample.t0C < extreme : sample.t0C > extreme);
  return isMoreExtreme
    ? { ...tracker, extremeTemperatureC: sample.t0C, extremeAtMs: sample.atMs }
    : tracker;
}

function makePeak(tracker: PeakTracker): RelayPeak | undefined {
  if (tracker.extremeTemperatureC === undefined || tracker.extremeAtMs === undefined) {
    return undefined;
  }
  return {
    kind: tracker.direction === 'heating' ? 'low' : 'high',
    temperatureC: tracker.extremeTemperatureC,
    atMs: tracker.extremeAtMs,
  };
}

function completeDraft(
  state: CalibrationState,
  peaks: readonly RelayPeak[],
  atMs: number,
): CalibrationTransition {
  if (state.originalGains === undefined) {
    return fail(
      state,
      'PID_SNAPSHOT_UNAVAILABLE',
      'Rollback gains were lost before results could be calculated.',
      atMs,
    );
  }
  let suggested;
  try {
    suggested = deriveRelayPidGains(peaks, state.options.limits.minimumPeakSwingC);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Relay oscillation could not be analyzed.';
    return fail(state, 'INSUFFICIENT_OSCILLATION', message, atMs);
  }
  const draft: CalibrationDraft = {
    status: 'draft',
    source: 'klipper-style-relay-autotune',
    createdAtMs: atMs,
    targetC: state.options.targetC,
    originalGains: state.originalGains,
    suggested,
    peaks,
    sampleCount: state.samples.length,
    notes: [
      'Draft only: explicit validation and apply actions are separate.',
      'No M500 persistence command was sent.',
      'Firmware watchdogs and protections remain the safety authority.',
    ],
  };
  const transition = beginTermination({ ...state, peaks, draft }, { outcome: 'completed' }, atMs);
  return withEffects(transition, { type: 'draft-ready', draft });
}

function runningTelemetry(state: CalibrationState, sample: M105Telemetry): CalibrationTransition {
  const tracker = state.tracker;
  if (tracker === undefined) {
    return fail(state, 'INVALID_TELEMETRY', 'Relay tracker was not initialized.', sample.atMs);
  }
  const fault = telemetryFault(state, sample);
  if (fault !== undefined) {
    return fail(state, fault.code, fault.message, sample.atMs);
  }

  let next = appendSample(
    {
      ...state,
      lastTelemetryAtMs: sample.atMs,
      nextPollAtMs: sample.atMs + state.options.telemetryPollMs,
    },
    sample,
  );
  const tracked = trackerWithSample(tracker, sample);
  const crossingHigh = tracked.direction === 'heating' && sample.t0C >= state.options.targetC;
  const crossingLow = tracked.direction === 'cooling' && sample.t0C <= state.options.lowTargetC;

  const outsideGrace =
    sample.atMs - tracked.directionChangedAtMs >= state.options.limits.actuatorGraceMs;
  const actuatorMatches =
    tracked.direction === 'heating'
      ? sample.output >= state.options.limits.highOutputMinimum
      : sample.output <= state.options.limits.lowOutputMaximum;
  const violations =
    outsideGrace && !crossingHigh && !crossingLow && !actuatorMatches
      ? next.consecutiveActuatorViolations + 1
      : 0;
  next = { ...next, tracker: tracked, consecutiveActuatorViolations: violations };
  if (violations > state.options.limits.maximumActuatorViolations) {
    return fail(
      next,
      'ACTUATOR_MISMATCH',
      tracked.direction === 'heating'
        ? 'Relay heating did not remain near output 255.'
        : 'Relay cooling did not remain near output 0.',
      sample.atMs,
    );
  }

  if (!crossingHigh && !crossingLow) {
    return { state: next, effects: [] };
  }

  const peak = makePeak(tracked);
  let peaks = next.peaks;
  if (crossingLow && peak !== undefined) {
    peaks = [...peaks, peak];
  } else if (crossingHigh && tracked.completedCoolingSegment && peak !== undefined) {
    peaks = [...peaks, peak];
  }

  if (peaks.length >= next.options.requiredPeakCount) {
    return completeDraft(next, peaks.slice(0, next.options.requiredPeakCount), sample.atMs);
  }

  const direction = crossingHigh ? 'cooling' : 'heating';
  const switched: CalibrationState = {
    ...next,
    peaks,
    consecutiveActuatorViolations: 0,
    tracker: {
      direction,
      directionChangedAtMs: sample.atMs,
      extremeTemperatureC: sample.t0C,
      extremeAtMs: sample.atMs,
      completedCoolingSegment: tracked.completedCoolingSegment || crossingLow,
    },
  };
  return sendWithAck(
    switched,
    `M104 S${formatNumber(crossingHigh ? next.options.lowTargetC : next.options.targetC)}`,
    crossingHigh ? 'switch-low' : 'switch-high',
    sample.atMs,
  );
}

function confirmingZeroTelemetry(
  state: CalibrationState,
  sample: M105Telemetry,
): CalibrationTransition {
  const invalid = telemetryFault(state, sample);
  if (invalid !== undefined && invalid.code === 'NON_MONOTONIC_TELEMETRY') {
    return fail(state, invalid.code, invalid.message, sample.atMs);
  }
  const next = appendSample(
    {
      ...state,
      lastTelemetryAtMs: sample.atMs,
      nextPollAtMs: sample.atMs + state.options.telemetryPollMs,
    },
    sample,
  );
  if (Math.abs(sample.reportedTargetC) > 0.01 || sample.output > 0) {
    return { state: next, effects: [] };
  }
  if (next.originalGains === undefined) {
    return finishTerminal(next);
  }
  const restoring: CalibrationState = { ...next, phase: 'restoring-gains' };
  return sendWithAck(restoring, pidCommand(next.originalGains), 'restore-gains', sample.atMs);
}

function handleTelemetry(state: CalibrationState, sample: M105Telemetry): CalibrationTransition {
  if (state.phase === 'running') {
    return runningTelemetry(state, sample);
  }
  if (state.phase === 'confirming-zero') {
    return confirmingZeroTelemetry(state, sample);
  }
  return { state, effects: [] };
}

function handleRejected(
  state: CalibrationState,
  commandId: number,
  message: string,
  atMs: number,
): CalibrationTransition {
  const removed = removeOutstanding(state, commandId);
  const command = removed.command;
  if (command === undefined) {
    return { state, effects: [] };
  }
  if (command.purpose === 'disarm-relay') {
    const prepared = { ...removed.state, phase: 'setting-zero-target' as const };
    return withEffects(sendWithAck(prepared, 'M104 S0', 'set-zero-target', atMs), {
      type: 'notice',
      level: 'warning',
      code: 'COMMAND_REJECTED',
      message,
    });
  }
  if (command.purpose === 'set-zero-target') {
    const confirming: CalibrationState = {
      ...removed.state,
      phase: 'confirming-zero',
      actionStartedAtMs: atMs,
      lastTelemetryAtMs: atMs,
      nextPollAtMs: atMs + state.options.telemetryPollMs,
    };
    return withEffects(sendWithoutAck(confirming, 'M105', 'confirm-zero'), {
      type: 'notice',
      level: 'warning',
      code: 'COMMAND_REJECTED',
      message,
    });
  }
  if (command.purpose === 'restore-gains') {
    return finishTerminal({
      ...removed.state,
      terminalIntent: {
        outcome: 'faulted',
        fault: makeFault(
          'RESTORE_FAILED',
          `Original PID gains were not restored: ${message}`,
          atMs,
        ),
      },
    });
  }
  return fail(
    removed.state,
    'COMMAND_REJECTED',
    `Firmware rejected ${command.command}: ${message}`,
    atMs,
  );
}

function tick(state: CalibrationState, atMs: number): CalibrationTransition {
  const startedAtMs = state.startedAtMs;
  if (
    startedAtMs !== undefined &&
    ['snapshotting', 'configuring-relay', 'setting-initial-target', 'running'].includes(
      state.phase,
    ) &&
    atMs - startedAtMs > state.options.limits.maximumDurationMs
  ) {
    return fail(state, 'DURATION_LIMIT', 'Calibration exceeded the operator duration limit.', atMs);
  }
  if (
    state.phase === 'snapshotting' &&
    startedAtMs !== undefined &&
    atMs - startedAtMs > state.options.limits.telemetryTimeoutMs
  ) {
    return fail(
      state,
      'PID_SNAPSHOT_UNAVAILABLE',
      'M503 did not provide Kp, Ki, and Kd; tuning was refused.',
      atMs,
    );
  }
  if (state.phase === 'running' || state.phase === 'confirming-zero') {
    if (
      state.lastTelemetryAtMs !== undefined &&
      atMs - state.lastTelemetryAtMs > state.options.limits.telemetryTimeoutMs
    ) {
      if (state.phase === 'confirming-zero') {
        return finishTerminal({
          ...state,
          terminalIntent: {
            outcome: 'faulted',
            fault: makeFault(
              'ZERO_CONFIRMATION_TIMEOUT',
              'Target/output zero was not confirmed, so original gains were not restored.',
              atMs,
            ),
          },
        });
      }
      return fail(state, 'TELEMETRY_TIMEOUT', 'M105 telemetry timed out.', atMs);
    }
    if (state.nextPollAtMs !== undefined && atMs >= state.nextPollAtMs) {
      const polling = {
        ...state,
        nextPollAtMs: atMs + state.options.telemetryPollMs,
      };
      return sendWithoutAck(
        polling,
        'M105',
        state.phase === 'confirming-zero' ? 'confirm-zero' : 'poll-telemetry',
      );
    }
  }

  const timedOut = state.outstandingCommands.find(
    (command) => atMs - command.sentAtMs > state.options.limits.telemetryTimeoutMs,
  );
  if (timedOut !== undefined) {
    if (timedOut.purpose === 'disarm-relay' || timedOut.purpose === 'set-zero-target') {
      return handleRejected(
        state,
        timedOut.id,
        'Command acknowledgement timed out; continuing the best-effort stop sequence.',
        atMs,
      );
    }
    if (timedOut.purpose === 'restore-gains') {
      return handleRejected(state, timedOut.id, 'Restore acknowledgement timed out.', atMs);
    }
    return fail(state, 'COMMAND_TIMEOUT', `${timedOut.command} acknowledgement timed out.`, atMs);
  }
  return { state, effects: [] };
}

export function transitionCalibration(
  state: CalibrationState,
  event: CalibrationEvent,
): CalibrationTransition {
  switch (event.type) {
    case 'start': {
      if (state.phase !== 'idle') {
        return { state, effects: [] };
      }
      const snapshotting: CalibrationState = {
        ...state,
        phase: 'snapshotting',
        startedAtMs: event.atMs,
        actionStartedAtMs: event.atMs,
      };
      return sendWithoutAck(snapshotting, 'M503', 'snapshot');
    }
    case 'protocol-line': {
      const telemetry = parseM105Telemetry(event.line, event.atMs);
      if (telemetry !== undefined) {
        return handleTelemetry(state, telemetry);
      }
      const snapshot = snapshotLine(state, event.line, event.atMs);
      if (snapshot !== undefined) {
        return snapshot;
      }
      if (/^\s*ok\b/i.test(event.line)) {
        const commandId = firstOutstandingId(state);
        return commandId === undefined
          ? { state, effects: [] }
          : acknowledge(state, commandId, event.atMs);
      }
      if (/^\s*(?:error|unknown|failed)/i.test(event.line)) {
        const commandId = firstOutstandingId(state);
        return commandId === undefined
          ? { state, effects: [] }
          : handleRejected(state, commandId, event.line.trim(), event.atMs);
      }
      return { state, effects: [] };
    }
    case 'telemetry':
      return handleTelemetry(state, event.sample);
    case 'command-accepted':
      return acknowledge(state, event.commandId, event.atMs);
    case 'command-rejected':
      return handleRejected(state, event.commandId, event.message, event.atMs);
    case 'snapshot-complete':
      return state.phase === 'snapshotting' && !isCompletePidSnapshot(state.snapshot)
        ? fail(
            state,
            'PID_SNAPSHOT_UNAVAILABLE',
            'M503 did not provide Kp, Ki, and Kd; tuning was refused.',
            event.atMs,
          )
        : { state, effects: [] };
    case 'tick':
      return tick(state, event.atMs);
    case 'cancel':
      return beginTermination(
        state,
        { outcome: 'cancelled', reason: event.reason ?? 'Calibration cancelled by operator.' },
        event.atMs,
      );
    case 'disconnected':
      return fail(
        state,
        'DISCONNECTED',
        'The desktop connection was lost; any resulting firmware behavior is outside this experiment.',
        event.atMs,
      );
  }
}

/** Convenience wrapper for hosts that keep the current immutable state. */
export class LivePidCalibration {
  private current: CalibrationState;

  constructor(options: CalibrationOptions) {
    this.current = createCalibrationState(options);
  }

  get state(): CalibrationState {
    return this.current;
  }

  dispatch(event: CalibrationEvent): readonly CalibrationEffect[] {
    const transition = transitionCalibration(this.current, event);
    this.current = transition.state;
    return transition.effects;
  }
}
