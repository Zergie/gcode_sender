import { describe, expect, it } from 'vitest';

import {
  createFirmwareQuickPidState,
  stepFirmwareQuickPid,
  type FirmwareQuickPidState,
} from '../control';
import { DEFAULT_OVEN_PROFILE, DEFAULT_SIMULATION_CONTROLLER } from './default-profile';
import {
  createPhysicalForecastPlanner,
  createPhysicalTwinObserver,
  type PhysicalForecastPlan,
  type ThermalForecastSource,
} from './physical-feed-forward';
import { createThermalTwin } from './physical-twin';
import type { OvenModelProfile } from './types';

const gains = { kp: 21.6, ki: 0.91, kd: 96 };
const forecastConfiguration = {
  ...DEFAULT_SIMULATION_CONTROLLER.modelAssistance,
  predictionHorizonSeconds: 10,
};

function pidAt(measurementC: number, output = 80): FirmwareQuickPidState {
  return createFirmwareQuickPidState({ measurementC, output, tunings: gains });
}

function plan(
  source: ThermalForecastSource,
  requestedTargetC: number,
  firmwarePidState = pidAt(
    (source.snapshot().temperaturesC.t1 + source.snapshot().temperaturesC.t2) / 2,
  ),
): PhysicalForecastPlan {
  return createPhysicalForecastPlanner({
    configuration: forecastConfiguration,
    initialTargetC: requestedTargetC,
  }).plan({
    mode: 'model-assisted-pid',
    source,
    firmwarePidState,
    requestedTargetC,
    stepSeconds: 1,
  });
}

function observedHotTwin(
  profile: OvenModelProfile,
  observation = { t1C: 165, t2C: 165, t3C: 40 },
): ReturnType<typeof createThermalTwin> {
  const twin = createThermalTwin({ profile });
  twin.advance({ durationSeconds: 300, duty: 1 });
  twin.assimilateSensorObservation(observation);
  return twin;
}

describe('twin-derived physical forecast planner', () => {
  it('keeps PID mode transparent and does not mutate the observed plant', () => {
    const source = createThermalTwin();
    const before = source.snapshot();
    const planner = createPhysicalForecastPlanner({
      configuration: forecastConfiguration,
      initialTargetC: 22,
    });
    const result = planner.plan({
      mode: 'pid',
      source,
      firmwarePidState: pidAt(22, 0),
      requestedTargetC: 180.9,
      stepSeconds: 1,
    });

    expect(result.trajectoryTargetC).toBe(180.9);
    expect(result.firmwareTargetC).toBe(180);
    expect(result.forecast).toBeNull();
    expect(source.snapshot()).toEqual(before);
  });

  it('keeps the requested scenario trajectory unchanged', () => {
    const source = observedHotTwin(DEFAULT_OVEN_PROFILE);
    const firmwarePidState = pidAt(165);
    const result = createPhysicalForecastPlanner({
      configuration: forecastConfiguration,
      initialTargetC: 165,
    }).plan({
      mode: 'model-assisted-pid',
      source,
      firmwarePidState,
      requestedTargetC: 180,
      targetAtOffsetSeconds: (offsetSeconds) => (offsetSeconds < 5 ? 180 : 160),
      stepSeconds: 1,
    });

    expect(result.requestedTargetC).toBe(180);
    expect(result.trajectoryTargetC).toBe(180);
    expect(result.trajectoryRateCPerSecond).toBe(15);
  });

  it('changes its whole-degree command when hidden physical power/topology changes', () => {
    const lowPowerProfile: OvenModelProfile = {
      ...DEFAULT_OVEN_PROFILE,
      heaters: {
        top: { ...DEFAULT_OVEN_PROFILE.heaters.top, ratedPowerW: 300 },
        bottom: { ...DEFAULT_OVEN_PROFILE.heaters.bottom, ratedPowerW: 300 },
      },
    };
    const nominal = plan(observedHotTwin(DEFAULT_OVEN_PROFILE), 165, pidAt(165));
    const lowPower = plan(observedHotTwin(lowPowerProfile), 165, pidAt(165));

    expect(nominal.forecast?.candidatesEvaluated).toBeGreaterThan(1);
    expect(lowPower.forecast?.candidatesEvaluated).toBeGreaterThan(1);
    expect(lowPower.firmwareTargetC).not.toBe(nominal.firmwareTargetC);
    expect(Number.isInteger(lowPower.firmwareTargetC)).toBe(true);
  });

  it('responds to the orientation of T1/T2 imbalance in an asymmetric oven', () => {
    const asymmetricProfile: OvenModelProfile = {
      ...DEFAULT_OVEN_PROFILE,
      heaters: {
        top: { ...DEFAULT_OVEN_PROFILE.heaters.top, ratedPowerW: 1_200 },
        bottom: { ...DEFAULT_OVEN_PROFILE.heaters.bottom, ratedPowerW: 600 },
      },
    };
    const topHot = observedHotTwin(asymmetricProfile, { t1C: 165, t2C: 155, t3C: 40 });
    const bottomHot = observedHotTwin(asymmetricProfile, { t1C: 155, t2C: 165, t3C: 40 });
    const plannerFor = (source: ThermalForecastSource): PhysicalForecastPlan =>
      createPhysicalForecastPlanner({
        // Mounted probes have a measured long time constant; five seconds cannot reveal
        // heater-orientation differences at the sensors.
        configuration: { ...forecastConfiguration, predictionHorizonSeconds: 60 },
        initialTargetC: 150,
      }).plan({
        mode: 'model-assisted-pid',
        source,
        firmwarePidState: pidAt(160, 0),
        requestedTargetC: 150,
        stepSeconds: 1,
      });
    const topHotPlan = plannerFor(topHot);
    const bottomHotPlan = plannerFor(bottomHot);
    expect(topHotPlan.forecast?.selected.maximumSensorSpreadC).toBeGreaterThanOrEqual(10);
    expect(bottomHotPlan.forecast?.selected.maximumSensorSpreadC).toBeGreaterThanOrEqual(10);
    expect(topHotPlan.firmwareTargetC).not.toBe(bottomHotPlan.firmwareTargetC);
  });

  it('selects bounded whole-degree candidates without mutating the source', () => {
    const source = observedHotTwin(DEFAULT_OVEN_PROFILE);
    const before = source.snapshot();
    const planner = createPhysicalForecastPlanner({
      configuration: {
        ...forecastConfiguration,
        maximumTargetLeadC: 5,
        minimumCommandC: 150,
        maximumCommandC: 202,
      },
      initialTargetC: 165,
    });
    const result = planner.plan({
      mode: 'model-assisted-pid',
      source,
      firmwarePidState: pidAt(165),
      requestedTargetC: 200.7,
      stepSeconds: 1,
    });

    expect(Number.isInteger(result.firmwareTargetC)).toBe(true);
    expect(result.firmwareTargetC).toBeGreaterThanOrEqual(196);
    expect(result.firmwareTargetC).toBeLessThanOrEqual(202);
    expect(source.snapshot()).toEqual(before);
  });

  it('bounds deterministic candidate-search work for wide command ranges', () => {
    const source = createThermalTwin();
    const result = createPhysicalForecastPlanner({
      configuration: {
        ...forecastConfiguration,
        predictionHorizonSeconds: 1,
        maximumTargetLeadC: 100,
        minimumCommandC: 0,
        maximumCommandC: 250,
      },
      initialTargetC: 125,
    }).plan({
      mode: 'model-assisted-pid',
      source,
      firmwarePidState: pidAt(22, 0),
      requestedTargetC: 125,
      stepSeconds: 1,
    });

    expect(result.forecast?.candidatesEvaluated).toBeLessThanOrEqual(16);
  });

  it('does not generate a target oscillator at physical equilibrium', () => {
    const source = createThermalTwin();
    const planner = createPhysicalForecastPlanner({
      configuration: forecastConfiguration,
      initialTargetC: 22,
    });
    const input = {
      mode: 'model-assisted-pid' as const,
      source,
      firmwarePidState: pidAt(22, 0),
      requestedTargetC: 22,
      stepSeconds: 1,
    };

    const commands = Array.from({ length: 5 }, () => planner.plan(input).firmwareTargetC);
    expect(commands).toEqual([22, 22, 22, 22, 22]);
  });

  it('forecasts when immediately saturated endpoint commands can diverge later', () => {
    const source = observedHotTwin(DEFAULT_OVEN_PROFILE, { t1C: 150, t2C: 150, t3C: 40 });
    const initialPidState = pidAt(150, 255);
    const immediatePwm = (setpointC: number): number =>
      stepFirmwareQuickPid(initialPidState, {
        setpointC,
        measurementC: 150,
        elapsedSeconds: DEFAULT_OVEN_PROFILE.solverStepSeconds,
      }).pwm8;
    const physicalPwmTrace = (setpointC: number): readonly number[] => {
      const twin = source.fork();
      let snapshot = twin.snapshot();
      let pidState = initialPidState;
      return Array.from({ length: 200 }, () => {
        const pidStep = stepFirmwareQuickPid(pidState, {
          setpointC,
          measurementC: (snapshot.temperaturesC.t1 + snapshot.temperaturesC.t2) / 2,
          elapsedSeconds: DEFAULT_OVEN_PROFILE.solverStepSeconds,
        });
        pidState = pidStep.state;
        snapshot = twin.advance({
          durationSeconds: DEFAULT_OVEN_PROFILE.solverStepSeconds,
          duty: pidStep.pwm8 / 255,
        });
        return pidStep.pwm8;
      });
    };

    expect([immediatePwm(150), immediatePwm(180)]).toEqual([255, 255]);
    expect(physicalPwmTrace(150)).not.toEqual(physicalPwmTrace(180));

    const result = plan(source, 165, initialPidState);

    expect(result.forecast).not.toBeNull();
    expect(result.forecast?.candidatesEvaluated).toBeGreaterThan(1);
  });
});

describe('persistent physical twin observer', () => {
  it('accumulates jittered telemetry intervals onto deterministic fixed physics steps', () => {
    const first = createPhysicalTwinObserver({ profile: DEFAULT_OVEN_PROFILE });
    const second = createPhysicalTwinObserver({ profile: DEFAULT_OVEN_PROFILE });
    const observations = [
      { elapsedSeconds: 0.033, appliedPwm8: 255, t1C: 22, t2C: 22, t3C: 22 },
      { elapsedSeconds: 0.041, appliedPwm8: 0, t1C: 22, t2C: 22, t3C: 22 },
      { elapsedSeconds: 0.027, appliedPwm8: 128, t1C: 22, t2C: 22, t3C: 22 },
    ];

    const firstTimes = observations.map(
      (observation) => first.observe(observation).snapshot.timeSeconds,
    );
    observations.forEach((observation) => second.observe(observation));

    expect(firstTimes).toEqual([0, 0.05, 0.1]);
    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.snapshot().temperaturesC.topHeater).toBeGreaterThan(22);
  });

  it('retains hidden states across reported-PWM advances and explicit sensor assimilation', () => {
    const observer = createPhysicalTwinObserver({ profile: DEFAULT_OVEN_PROFILE });
    const first = observer.observe({
      elapsedSeconds: 5,
      appliedPwm8: 255,
      t1C: 30,
      t2C: 31,
      t3C: 24,
    });
    const firstHeaterC = first.snapshot.temperaturesC.topHeater;

    expect(first.snapshot.timeSeconds).toBe(5);
    expect(first.snapshot.temperaturesC.t1).toBe(30);
    expect(first.snapshot.temperaturesC.t2).toBe(31);
    expect(firstHeaterC).toBeGreaterThan(DEFAULT_OVEN_PROFILE.ambientTemperatureC);
    expect(first.snapshot.energy.internalEnergyChangeJ).toBe(0);
    expect(first.snapshot.energy.electricalInputJ).toBe(0);
    expect(first.snapshot.energy.netHeatToAmbientJ).toBe(0);
    expect(first.snapshot.energy.balanceResidualJ).toBe(0);

    const second = observer.observe({
      elapsedSeconds: 5,
      appliedPwm8: 0,
      t1C: 32,
      t2C: 33,
      t3C: 25,
    });
    expect(second.snapshot.timeSeconds).toBe(10);
    expect(second.snapshot.temperaturesC.topHeater).toBeGreaterThan(
      DEFAULT_OVEN_PROFILE.ambientTemperatureC,
    );
    expect(second.snapshot.temperaturesC.topHeater).not.toBe(32.5);
    expect(second.imposedInternalEnergyChangeJ).not.toBe(0);
  });

  it('forks forecasts without changing the persistent observer', () => {
    const observer = createPhysicalTwinObserver({
      profile: DEFAULT_OVEN_PROFILE,
      initialSensorsC: { t1C: 165, t2C: 165, t3C: 40 },
    });
    observer.observe({
      elapsedSeconds: 10,
      appliedPwm8: 128,
      t1C: 165,
      t2C: 165,
      t3C: 40,
    });
    const before = observer.snapshot();

    plan(observer, 170, pidAt(165));
    expect(observer.snapshot()).toEqual(before);
  });
});
