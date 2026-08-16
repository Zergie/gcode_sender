/**
 * Deterministic model of the QuickPID 3.1.9 configuration used by the heater MCU.
 *
 * This intentionally mirrors the firmware's controller, including its unusual
 * iAwCondition calculation. It is not a general-purpose PID implementation.
 */

export const FIRMWARE_QUICK_PID_SAMPLE_MICROSECONDS = 100_000;
export const FIRMWARE_QUICK_PID_SAMPLE_SECONDS = 0.1;
export const FIRMWARE_HEATER_OUTPUT_MINIMUM = 0;
export const FIRMWARE_HEATER_OUTPUT_MAXIMUM = 255;

export interface FirmwareQuickPidTunings {
  readonly kp: number;
  readonly ki: number;
  readonly kd: number;
}

export interface FirmwareQuickPidTerms {
  readonly proportional: number;
  readonly integral: number;
  readonly derivative: number;
}

export interface FirmwareQuickPidState {
  /** User-facing gains, before QuickPID's sample-time scaling. */
  readonly tunings: FirmwareQuickPidTunings;
  /** QuickPID's internal gains: kp, Ki * 0.1 and Kd / 0.1. */
  readonly internalGains: FirmwareQuickPidTunings;
  /** QuickPID's internal integral accumulator. */
  readonly outputSum: number;
  /** Last floating-point controller output, before the MCU's integer PWM cast. */
  readonly output: number;
  /** Terms produced by the most recent controller computation. */
  readonly terms: FirmwareQuickPidTerms;
  readonly lastError: number;
  readonly lastInput: number;
  /** Elapsed simulated time since the most recent successful Compute call. */
  readonly elapsedMicroseconds: number;
}

export interface FirmwareQuickPidInitialization {
  readonly measurementC: number;
  readonly output?: number;
  readonly tunings?: FirmwareQuickPidTunings;
}

export interface FirmwareQuickPidStepInput {
  readonly setpointC: number;
  readonly measurementC: number;
  /** Time elapsed since the previous call. Zero is valid for the initial call. */
  readonly elapsedSeconds: number;
}

export interface FirmwareQuickPidStepResult {
  readonly state: FirmwareQuickPidState;
  /** Matches QuickPID::Compute(): false while the 100 ms sample period has not elapsed. */
  readonly computed: boolean;
  /** Floating-point QuickPID output. */
  readonly output: number;
  /** Value written by `(uint32_t)heaterPower` to the MCU's 8-bit timer compare. */
  readonly pwm8: number;
}

export interface FirmwareQuickPidObservation {
  readonly setpointC: number;
  readonly measurementC: number;
  /** Firmware-reported controller output on its native 0..255 scale. */
  readonly output: number;
}

const ZERO_TUNINGS: FirmwareQuickPidTunings = { kp: 0, ki: 0, kd: 0 };
const ZERO_TERMS: FirmwareQuickPidTerms = {
  proportional: 0,
  integral: 0,
  derivative: 0,
};
const FIRMWARE_QUICK_PID_SAMPLE_SECONDS_FLOAT32 = Math.fround(FIRMWARE_QUICK_PID_SAMPLE_SECONDS);

function float32(value: number): number {
  return Math.fround(value);
}

function constrain(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite.`);
  }
}

function normalizeTunings(tunings: FirmwareQuickPidTunings): FirmwareQuickPidTunings {
  requireFinite(tunings.kp, 'kp');
  requireFinite(tunings.ki, 'ki');
  requireFinite(tunings.kd, 'kd');
  return {
    kp: float32(tunings.kp),
    ki: float32(tunings.ki),
    kd: float32(tunings.kd),
  };
}

/**
 * Creates the state after the firmware's QuickPID constructor and
 * `SetMode(automatic)` initialization have run. As in QuickPID, the first call
 * to Compute is immediately due.
 */
export function createFirmwareQuickPidState(
  initialization: FirmwareQuickPidInitialization,
): FirmwareQuickPidState {
  requireFinite(initialization.measurementC, 'measurementC');
  requireFinite(initialization.output ?? 0, 'output');

  const initialInput = float32(initialization.measurementC);
  const initialOutput = float32(initialization.output ?? 0);
  const state: FirmwareQuickPidState = {
    tunings: ZERO_TUNINGS,
    internalGains: ZERO_TUNINGS,
    outputSum: constrain(
      initialOutput,
      FIRMWARE_HEATER_OUTPUT_MINIMUM,
      FIRMWARE_HEATER_OUTPUT_MAXIMUM,
    ),
    output: initialOutput,
    terms: ZERO_TERMS,
    lastError: 0,
    lastInput: initialInput,
    // QuickPID's constructor sets lastTime = micros() - sampleTimeUs.
    elapsedMicroseconds: FIRMWARE_QUICK_PID_SAMPLE_MICROSECONDS,
  };

  const tunedState = setFirmwareQuickPidTunings(state, initialization.tunings ?? ZERO_TUNINGS);
  // In the firmware, tunings are loaded while QuickPID is still manual. The
  // subsequent SetMode(automatic) calls Initialize and restores outputSum from
  // the current output, even when the loaded Ki is zero.
  return { ...tunedState, outputSum: state.outputSum };
}

/**
 * Mirrors QuickPID::SetTunings for the firmware's fixed modes. Negative gains
 * are ignored, while Ki == 0 clears outputSum even if the gain was already zero.
 */
export function setFirmwareQuickPidTunings(
  state: FirmwareQuickPidState,
  requestedTunings: FirmwareQuickPidTunings,
): FirmwareQuickPidState {
  const tunings = normalizeTunings(requestedTunings);
  if (tunings.kp < 0 || tunings.ki < 0 || tunings.kd < 0) {
    return state;
  }

  return {
    ...state,
    tunings,
    internalGains: {
      kp: tunings.kp,
      ki: float32(tunings.ki * FIRMWARE_QUICK_PID_SAMPLE_SECONDS_FLOAT32),
      kd: float32(tunings.kd / FIRMWARE_QUICK_PID_SAMPLE_SECONDS_FLOAT32),
    },
    outputSum: tunings.ki === 0 ? 0 : state.outputSum,
  };
}

/**
 * Advances the firmware PID clock. Calling this more often than every 100 ms is
 * supported: the previous output is held until the next computation is due.
 */
export function stepFirmwareQuickPid(
  state: FirmwareQuickPidState,
  input: FirmwareQuickPidStepInput,
): FirmwareQuickPidStepResult {
  requireFinite(input.setpointC, 'setpointC');
  requireFinite(input.measurementC, 'measurementC');
  requireFinite(input.elapsedSeconds, 'elapsedSeconds');
  if (input.elapsedSeconds < 0) {
    throw new RangeError('elapsedSeconds must be non-negative.');
  }

  const elapsedMicroseconds = state.elapsedMicroseconds + input.elapsedSeconds * 1_000_000;
  if (elapsedMicroseconds < FIRMWARE_QUICK_PID_SAMPLE_MICROSECONDS) {
    const waitingState = { ...state, elapsedMicroseconds };
    return {
      state: waitingState,
      computed: false,
      output: waitingState.output,
      pwm8: quantizeFirmwareHeaterPwm(waitingState.output),
    };
  }

  // QuickPID 3.1.9 Compute(), with the firmware defaults fixed to:
  // direct, pOnError, dOnMeas and iAwCondition.
  const setpoint = float32(input.setpointC);
  const measurement = float32(input.measurementC);
  const dInput = float32(measurement - state.lastInput);
  const error = float32(setpoint - measurement);
  const dError = float32(error - state.lastError);

  const peTerm = float32(state.internalGains.kp * error);
  const proportional = peTerm;
  let integral = float32(state.internalGains.ki * error);
  const derivative = float32(-state.internalGains.kd * dInput);

  const iTermOut = float32(peTerm + float32(state.internalGains.ki * float32(integral + error)));
  const antiWindupActive =
    (iTermOut > FIRMWARE_HEATER_OUTPUT_MAXIMUM && dError > 0) ||
    (iTermOut < FIRMWARE_HEATER_OUTPUT_MINIMUM && dError < 0);
  if (antiWindupActive && state.internalGains.ki !== 0) {
    integral = constrain(iTermOut, -FIRMWARE_HEATER_OUTPUT_MAXIMUM, FIRMWARE_HEATER_OUTPUT_MAXIMUM);
  }

  const outputSum = constrain(
    float32(state.outputSum + integral),
    FIRMWARE_HEATER_OUTPUT_MINIMUM,
    FIRMWARE_HEATER_OUTPUT_MAXIMUM,
  );
  const output = constrain(
    float32(float32(outputSum + peTerm) + derivative),
    FIRMWARE_HEATER_OUTPUT_MINIMUM,
    FIRMWARE_HEATER_OUTPUT_MAXIMUM,
  );
  const nextState: FirmwareQuickPidState = {
    ...state,
    outputSum,
    output,
    terms: { proportional, integral, derivative },
    lastError: error,
    lastInput: measurement,
    // QuickPID assigns lastTime = now and discards any overrun beyond the sample period.
    elapsedMicroseconds: 0,
  };

  return {
    state: nextState,
    computed: true,
    output,
    pwm8: quantizeFirmwareHeaterPwm(output),
  };
}

/**
 * Corrects a host-side QuickPID state estimate from one M105 observation.
 *
 * The firmware does not expose its integral accumulator. We retain the
 * persistent derivative/error history and solve the QuickPID output equation
 * for the accumulator that is consistent with the observed output. This is an
 * explicit observer correction used only for live twin forecasts; it is not a
 * firmware behavior or an invented plant dynamic.
 */
export function assimilateFirmwareQuickPidObservation(
  state: FirmwareQuickPidState,
  observation: FirmwareQuickPidObservation,
): FirmwareQuickPidState {
  requireFinite(observation.setpointC, 'setpointC');
  requireFinite(observation.measurementC, 'measurementC');
  requireFinite(observation.output, 'output');

  const measurement = float32(observation.measurementC);
  const error = float32(float32(observation.setpointC) - measurement);
  const proportional = float32(state.internalGains.kp * error);
  const derivative = float32(-state.internalGains.kd * float32(measurement - state.lastInput));
  const output = float32(
    constrain(observation.output, FIRMWARE_HEATER_OUTPUT_MINIMUM, FIRMWARE_HEATER_OUTPUT_MAXIMUM),
  );
  const outputSum = constrain(
    float32(output - proportional - derivative),
    FIRMWARE_HEATER_OUTPUT_MINIMUM,
    FIRMWARE_HEATER_OUTPUT_MAXIMUM,
  );

  return {
    ...state,
    outputSum,
    output,
    terms: {
      proportional,
      integral: outputSum,
      derivative,
    },
    lastError: error,
    lastInput: measurement,
    // M105 samples a currently applied output; begin a fresh observed phase.
    elapsedMicroseconds: 0,
  };
}

/** Mirrors the firmware's `(uint32_t)heaterPower` conversion into an 8-bit timer compare. */
export function quantizeFirmwareHeaterPwm(output: number): number {
  requireFinite(output, 'output');
  return Math.trunc(
    constrain(output, FIRMWARE_HEATER_OUTPUT_MINIMUM, FIRMWARE_HEATER_OUTPUT_MAXIMUM),
  );
}

/** Mirrors the `(int)GCode.GetWordValue('S')` assignment used by M104 and M109. */
export function truncateFirmwareM104Setpoint(value: number): number {
  requireFinite(value, 'value');
  return Math.trunc(value);
}
