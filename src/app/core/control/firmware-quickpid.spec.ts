import { describe, expect, it } from 'vitest';

import {
  assimilateFirmwareQuickPidObservation,
  createFirmwareQuickPidState,
  quantizeFirmwareHeaterPwm,
  setFirmwareQuickPidTunings,
  stepFirmwareQuickPid,
  truncateFirmwareM104Setpoint,
} from './firmware-quickpid';

describe('firmware QuickPID 3.1.9 parity', () => {
  it('scales display tunings by the fixed 100 ms sample time', () => {
    const state = createFirmwareQuickPidState({
      measurementC: 20,
      tunings: { kp: 25, ki: 1, kd: 110 },
    });

    expect(state.internalGains).toEqual({
      kp: 25,
      ki: Math.fround(0.1),
      kd: 1100,
    });
  });

  it('initializes outputSum from the manual output after loading tunings', () => {
    const state = createFirmwareQuickPidState({
      measurementC: 20,
      output: 37.5,
      tunings: { kp: 2, ki: 0, kd: 0 },
    });

    expect(state.outputSum).toBe(37.5);
  });

  it('computes immediately, then holds output until another 100 ms elapsed', () => {
    let state = createFirmwareQuickPidState({
      measurementC: 20,
      tunings: { kp: 2, ki: 1, kd: 0 },
    });
    const first = stepFirmwareQuickPid(state, {
      setpointC: 30,
      measurementC: 20,
      elapsedSeconds: 0,
    });
    expect(first.computed).toBe(true);
    expect(first.output).toBe(21);
    state = first.state;

    for (let index = 0; index < 3; index += 1) {
      const waiting = stepFirmwareQuickPid(state, {
        setpointC: 30,
        measurementC: 21,
        elapsedSeconds: 0.025,
      });
      expect(waiting.computed).toBe(false);
      expect(waiting.output).toBe(21);
      state = waiting.state;
    }

    const due = stepFirmwareQuickPid(state, {
      setpointC: 30,
      measurementC: 21,
      elapsedSeconds: 0.025,
    });
    expect(due.computed).toBe(true);
    expect(due.output).toBeCloseTo(19.9, 5);
  });

  it('matches the source anti-windup branch and outputSum saturation', () => {
    let state = createFirmwareQuickPidState({
      measurementC: 20,
      tunings: { kp: 25, ki: 1, kd: 110 },
    });
    const saturated = stepFirmwareQuickPid(state, {
      setpointC: 200,
      measurementC: 20,
      elapsedSeconds: 0,
    });

    // QuickPID lines 96 and 103-113: iTerm starts at 18, iTermOut saturates to
    // 255 in the conditional branch, then outputSum and output both clamp to 255.
    expect(saturated.state.terms.integral).toBe(255);
    expect(saturated.state.outputSum).toBe(255);
    expect(saturated.output).toBe(255);
    expect(saturated.pwm8).toBe(255);
    state = saturated.state;

    const fallingError = stepFirmwareQuickPid(state, {
      setpointC: 200,
      measurementC: 190,
      elapsedSeconds: 0.1,
    });
    expect(fallingError.state.terms).toEqual({
      proportional: 250,
      integral: 1,
      derivative: -187000,
    });
    expect(fallingError.state.outputSum).toBe(255);
    expect(fallingError.output).toBe(0);
  });

  it('keeps outputSum across positive gain changes and uses the new gains next compute', () => {
    let state = createFirmwareQuickPidState({
      measurementC: 20,
      tunings: { kp: 2, ki: 1, kd: 0 },
    });
    state = stepFirmwareQuickPid(state, {
      setpointC: 30,
      measurementC: 20,
      elapsedSeconds: 0,
    }).state;
    expect(state.outputSum).toBe(1);

    state = setFirmwareQuickPidTunings(state, { kp: 4, ki: 2, kd: 1 });
    expect(state.outputSum).toBe(1);
    expect(state.internalGains).toEqual({ kp: 4, ki: Math.fround(0.2), kd: 10 });

    const changed = stepFirmwareQuickPid(state, {
      setpointC: 30,
      measurementC: 21,
      elapsedSeconds: 0.1,
    });
    expect(changed.state.terms).toEqual({
      proportional: 36,
      integral: 1.8000000715255737,
      derivative: -10,
    });
    expect(changed.state.outputSum).toBeCloseTo(2.8, 6);
    expect(changed.output).toBe(28.799999237060547);
    expect(changed.pwm8).toBe(28);
  });

  it('clears outputSum whenever SetTunings receives Ki equal to zero', () => {
    let state = createFirmwareQuickPidState({
      measurementC: 20,
      tunings: { kp: 2, ki: 1, kd: 0 },
    });
    state = stepFirmwareQuickPid(state, {
      setpointC: 30,
      measurementC: 20,
      elapsedSeconds: 0,
    }).state;
    expect(state.outputSum).toBe(1);

    const withoutIntegral = setFirmwareQuickPidTunings(state, { kp: 2, ki: 0, kd: 0 });
    expect(withoutIntegral.outputSum).toBe(0);
    expect(withoutIntegral.output).toBe(21);
  });

  it('ignores negative gains exactly as SetTunings does', () => {
    const state = createFirmwareQuickPidState({
      measurementC: 20,
      tunings: { kp: 2, ki: 1, kd: 0 },
    });

    expect(setFirmwareQuickPidTunings(state, { kp: -1, ki: 2, kd: 3 })).toBe(state);
  });

  it('truncates the float output for PWM only after computing it', () => {
    expect(quantizeFirmwareHeaterPwm(28.999)).toBe(28);
    expect(quantizeFirmwareHeaterPwm(-1)).toBe(0);
    expect(quantizeFirmwareHeaterPwm(300)).toBe(255);
  });

  it('truncates M104 and M109 setpoints like a C++ int cast', () => {
    expect(truncateFirmwareM104Setpoint(201.9)).toBe(201);
    expect(truncateFirmwareM104Setpoint(-1.9)).toBe(-1);
  });

  it('assimilates reported output without discarding persistent controller history', () => {
    let state = createFirmwareQuickPidState({
      measurementC: 20,
      tunings: { kp: 2, ki: 1, kd: 0 },
    });
    state = stepFirmwareQuickPid(state, {
      setpointC: 30,
      measurementC: 20,
      elapsedSeconds: 0,
    }).state;

    const observed = assimilateFirmwareQuickPidObservation(state, {
      setpointC: 30,
      measurementC: 22,
      output: 50,
    });

    expect(observed.output).toBe(50);
    expect(observed.outputSum).toBe(34);
    expect(observed.lastInput).toBe(22);
    expect(observed.lastError).toBe(8);
    expect(observed.tunings).toEqual(state.tunings);
    const next = stepFirmwareQuickPid(observed, {
      setpointC: 30,
      measurementC: 22,
      elapsedSeconds: 0.1,
    });
    expect(next.output).toBeCloseTo(50.8, 5);
  });
});
