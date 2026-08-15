import { describe, expect, it } from 'vitest';

import {
  createCalibrationState,
  LivePidCalibration,
  resolveCalibrationOptions,
  transitionCalibration,
} from './machine';
import type { CalibrationEffect, CalibrationOptions, M105Telemetry } from './types';

type SendEffect = Extract<CalibrationEffect, { readonly type: 'send-gcode' }>;

function sends(effects: readonly CalibrationEffect[]): SendEffect[] {
  return effects.filter((effect): effect is SendEffect => effect.type === 'send-gcode');
}

function sentFor(
  effects: readonly CalibrationEffect[],
  purpose: SendEffect['purpose'],
): SendEffect {
  const effect = sends(effects).find((candidate) => candidate.purpose === purpose);
  if (effect === undefined) {
    throw new Error(`Expected ${purpose} command.`);
  }
  return effect;
}

function bootToRunning(options: CalibrationOptions = { targetC: 150 }): {
  readonly machine: LivePidCalibration;
  readonly commands: string[];
} {
  const machine = new LivePidCalibration(options);
  const commands: string[] = [];
  const capture = (effects: readonly CalibrationEffect[]): readonly CalibrationEffect[] => {
    commands.push(...sends(effects).map((effect) => effect.command));
    return effects;
  };

  expect(sentFor(capture(machine.dispatch({ type: 'start', atMs: 0 })), 'snapshot').command).toBe(
    'M503',
  );
  machine.dispatch({ type: 'protocol-line', atMs: 10, line: 'kp: 25' });
  machine.dispatch({ type: 'protocol-line', atMs: 20, line: 'ki: 1' });
  const configure = sentFor(
    capture(machine.dispatch({ type: 'protocol-line', atMs: 30, line: 'kd: 110' })),
    'configure-relay',
  );
  expect(configure.command).toBe('M301 P255 I0 D0');
  const initialTarget = sentFor(
    capture(
      machine.dispatch({
        type: 'command-accepted',
        atMs: 40,
        commandId: configure.commandId,
      }),
    ),
    'set-initial-target',
  );
  expect(initialTarget.command).toBe('M104 S150');
  expect(
    sentFor(
      capture(
        machine.dispatch({
          type: 'command-accepted',
          atMs: 50,
          commandId: initialTarget.commandId,
        }),
      ),
      'poll-telemetry',
    ).command,
  ).toBe('M105');
  expect(machine.state.phase).toBe('running');
  return { machine, commands };
}

function telemetry(
  atMs: number,
  temperatureC: number,
  reportedTargetC: number,
  output: number,
): M105Telemetry {
  return {
    atMs,
    t0C: temperatureC,
    t1C: temperatureC + 0.4,
    t2C: temperatureC - 0.4,
    t3C: 30,
    reportedTargetC,
    output,
  };
}

describe('live PID calibration state machine', () => {
  it('refuses to tune when M503 cannot provide every rollback gain', () => {
    const machine = new LivePidCalibration({ targetC: 150 });
    machine.dispatch({ type: 'start', atMs: 0 });
    machine.dispatch({ type: 'protocol-line', atMs: 10, line: 'kp: 25' });
    machine.dispatch({ type: 'protocol-line', atMs: 20, line: 'ki: 1' });
    const effects = machine.dispatch({ type: 'snapshot-complete', atMs: 30 });

    expect(machine.state.phase).toBe('faulted');
    expect(machine.state.fault?.code).toBe('PID_SNAPSHOT_UNAVAILABLE');
    expect(sends(effects)).toHaveLength(0);
    expect(machine.state.relayMayBeConfigured).toBe(false);
  });

  it('collects 12 alternating extrema and produces only a draft', () => {
    const { machine, commands } = bootToRunning({
      targetC: 150,
      limits: { actuatorGraceMs: 100 },
    });
    let atMs = 1_000;
    const dispatchSample = (
      temperatureC: number,
      targetC: number,
      output: number,
    ): readonly CalibrationEffect[] => {
      const effects = machine.dispatch({
        type: 'telemetry',
        sample: telemetry(atMs, temperatureC, targetC, output),
      });
      commands.push(...sends(effects).map((effect) => effect.command));
      for (const effect of sends(effects)) {
        if (effect.purpose === 'switch-high' || effect.purpose === 'switch-low') {
          machine.dispatch({
            type: 'command-accepted',
            atMs: atMs + 1,
            commandId: effect.commandId,
          });
        }
      }
      atMs += 1_000;
      return effects;
    };

    dispatchSample(151, 150, 255); // Finish warm-up; it is deliberately not a peak.
    let finalEffects: readonly CalibrationEffect[] = [];
    for (let cycle = 0; cycle < 6; cycle += 1) {
      dispatchSample(157, 145, 0);
      dispatchSample(144, 145, 0); // high peak
      dispatchSample(142, 150, 255);
      finalEffects = dispatchSample(151, 150, 255); // low peak
    }

    expect(machine.state.peaks).toHaveLength(12);
    expect(machine.state.peaks.map((peak) => peak.kind)).toEqual([
      'high',
      'low',
      'high',
      'low',
      'high',
      'low',
      'high',
      'low',
      'high',
      'low',
      'high',
      'low',
    ]);
    expect(machine.state.draft?.status).toBe('draft');
    expect(machine.state.draft?.suggested.quickPid.kp).toBeGreaterThan(0);
    expect(machine.state.phase).toBe('disarming-relay');
    expect(finalEffects.some((effect) => effect.type === 'draft-ready')).toBe(true);
    expect(sentFor(finalEffects, 'disarm-relay').command).toBe('M301 P0 I0 D0');
    expect(commands.some((command) => command.startsWith('M500'))).toBe(false);
  });

  it('restores the snapshot only after target and output zero are observed', () => {
    const { machine } = bootToRunning();
    const disarm = sentFor(
      machine.dispatch({ type: 'cancel', atMs: 1_000, reason: 'Operator stopped.' }),
      'disarm-relay',
    );
    const zeroTarget = sentFor(
      machine.dispatch({
        type: 'command-accepted',
        atMs: 1_010,
        commandId: disarm.commandId,
      }),
      'set-zero-target',
    );
    expect(zeroTarget.command).toBe('M104 S0');
    machine.dispatch({
      type: 'command-accepted',
      atMs: 1_020,
      commandId: zeroTarget.commandId,
    });

    const stillPowered = machine.dispatch({
      type: 'telemetry',
      sample: telemetry(1_100, 140, 0, 1),
    });
    expect(sends(stillPowered).some((effect) => effect.purpose === 'restore-gains')).toBe(false);
    expect(machine.state.phase).toBe('confirming-zero');

    const restore = sentFor(
      machine.dispatch({ type: 'telemetry', sample: telemetry(1_200, 140, 0, 0) }),
      'restore-gains',
    );
    expect(restore.command).toBe('M301 P25 I1 D110');
    machine.dispatch({
      type: 'command-accepted',
      atMs: 1_210,
      commandId: restore.commandId,
    });
    expect(machine.state.phase).toBe('cancelled');
  });

  it('aborts experiment integrity on actuator, sensor-spread, and T3 violations', () => {
    const actuator = bootToRunning({
      targetC: 150,
      limits: { actuatorGraceMs: 1, maximumActuatorViolations: 0 },
    }).machine;
    const actuatorEffects = actuator.dispatch({
      type: 'telemetry',
      sample: telemetry(100, 100, 150, 100),
    });
    expect(actuator.state.terminalIntent?.fault?.code).toBe('ACTUATOR_MISMATCH');
    expect(sentFor(actuatorEffects, 'disarm-relay').command).toBe('M301 P0 I0 D0');

    const spread = bootToRunning({
      targetC: 150,
      limits: { maximumSensorSpreadC: 5 },
    }).machine;
    const spreadSample = { ...telemetry(100, 100, 150, 255), t1C: 110, t2C: 90 };
    spread.dispatch({ type: 'telemetry', sample: spreadSample });
    expect(spread.state.terminalIntent?.fault?.code).toBe('SENSOR_SPREAD');

    const enclosure = bootToRunning({
      targetC: 150,
      limits: { t3MaximumC: 40 },
    }).machine;
    enclosure.dispatch({
      type: 'telemetry',
      sample: { ...telemetry(100, 100, 150, 255), t3C: 41 },
    });
    expect(enclosure.state.terminalIntent?.fault?.code).toBe('T3_OUT_OF_BOUNDS');
  });

  it('polls deterministically and faults on missing telemetry or duration limit', () => {
    const timeout = bootToRunning({
      targetC: 150,
      telemetryPollMs: 100,
      limits: { telemetryTimeoutMs: 500 },
    }).machine;
    expect(sentFor(timeout.dispatch({ type: 'tick', atMs: 150 }), 'poll-telemetry').command).toBe(
      'M105',
    );
    timeout.dispatch({ type: 'tick', atMs: 551 });
    expect(timeout.state.terminalIntent?.fault?.code).toBe('TELEMETRY_TIMEOUT');

    const duration = bootToRunning({
      targetC: 150,
      limits: { maximumDurationMs: 100 },
    }).machine;
    duration.dispatch({ type: 'tick', atMs: 101 });
    expect(duration.state.terminalIntent?.fault?.code).toBe('DURATION_LIMIT');
  });

  it('enforces the 250 C ceiling and whole-degree firmware targets', () => {
    expect(() => resolveCalibrationOptions({ targetC: 251 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(() => resolveCalibrationOptions({ targetC: 150.5 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(() =>
      createCalibrationState({ targetC: 200, limits: { maximumTemperatureC: 199 } }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
  });

  it('is a deterministic reducer for identical states and events', () => {
    const initial = createCalibrationState({ targetC: 100 });
    const event = { type: 'start' as const, atMs: 123 };
    expect(transitionCalibration(initial, event)).toEqual(transitionCalibration(initial, event));
  });
});
