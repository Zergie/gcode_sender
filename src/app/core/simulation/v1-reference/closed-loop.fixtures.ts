import type { V1ReferenceClosedLoopScenario } from './types';

export interface V1ReferenceClosedLoopFixture {
  readonly name: string;
  readonly scenario: V1ReferenceClosedLoopScenario;
  readonly expectedTimeSeconds: readonly number[];
  readonly expectedTargetC: readonly number[];
  readonly expectedSensorC: readonly number[];
  readonly expectedPowerByte: readonly number[];
  readonly expectedMetrics: {
    readonly finalSensorC: number;
    readonly minimumSensorC: number;
    readonly maximumSensorC: number;
    readonly minimumPowerByte: number;
    readonly maximumPowerByte: number;
  };
}

const HOLD_TIMES_SECONDS = [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600] as const;

const PROFILE_TIMES_SECONDS = [
  0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 960, 1_020, 1_080,
  1_140, 1_200,
] as const;

function holdScenario(targetC: number): V1ReferenceClosedLoopScenario {
  return {
    durationSeconds: 600,
    sampleEverySeconds: 60,
    targets: [{ atSeconds: 0, targetC }],
  };
}

/** Golden closed-loop traces generated from the exact v1 controller and plant. */
export const V1_REFERENCE_CLOSED_LOOP_FIXTURES: readonly V1ReferenceClosedLoopFixture[] = [
  {
    name: '100 C hold',
    scenario: holdScenario(100),
    expectedTimeSeconds: HOLD_TIMES_SECONDS,
    expectedTargetC: HOLD_TIMES_SECONDS.map(() => 100),
    expectedSensorC: [
      22, 97.689238001, 100.003017955, 100.054604135, 100.052104067, 100.048249627, 100.044544384,
      100.041125392, 100.037965554, 100.035045766, 100.032347937,
    ],
    expectedPowerByte: [
      0, 46.886084125, 46.517847196, 46.38797533, 46.260665338, 46.142894802, 46.034207059,
      45.933856411, 45.841214896, 45.75569681, 45.676760298,
    ],
    expectedMetrics: {
      finalSensorC: 100.032347937,
      minimumSensorC: 22,
      maximumSensorC: 100.056018638,
      minimumPowerByte: 0,
      maximumPowerByte: 148.512,
    },
  },
  {
    name: '150 C hold',
    scenario: holdScenario(150),
    expectedTimeSeconds: HOLD_TIMES_SECONDS,
    expectedTargetC: HOLD_TIMES_SECONDS.map(() => 150),
    expectedSensorC: [
      22, 153.55288114, 158.408089245, 150.659575342, 150.100931566, 150.079048523, 150.072571516,
      150.066965804, 150.061816933, 150.057059537, 150.052663854,
    ],
    expectedPowerByte: [
      0, 72.194738754, 52.895285931, 48.744960213, 48.571421059, 48.378618115, 48.201555091,
      48.038157675, 47.887312457, 47.74807507, 47.619561604,
    ],
    expectedMetrics: {
      finalSensorC: 150.052663854,
      minimumSensorC: 22,
      maximumSensorC: 158.865272152,
      minimumPowerByte: 0,
      maximumPowerByte: 243.712,
    },
  },
  {
    name: '200 C hold',
    scenario: holdScenario(200),
    expectedTimeSeconds: HOLD_TIMES_SECONDS,
    expectedTargetC: HOLD_TIMES_SECONDS.map(() => 200),
    expectedSensorC: [
      22, 153.55288114, 158.408089245, 160.955302412, 163.404263346, 165.779281545, 168.078409984,
      170.300378357, 172.444700775, 174.511543924, 176.501583795,
    ],
    expectedPowerByte: [0, 227.194738754, 255, 255, 255, 255, 255, 255, 255, 255, 255],
    expectedMetrics: {
      finalSensorC: 176.501583795,
      minimumSensorC: 22,
      maximumSensorC: 176.501583795,
      minimumPowerByte: 0,
      maximumPowerByte: 255,
    },
  },
  {
    name: '200 C heat then M104 S0 cooldown',
    scenario: {
      durationSeconds: 1_200,
      sampleEverySeconds: 60,
      targets: [
        { atSeconds: 0, targetC: 200 },
        { atSeconds: 600, targetC: 0 },
      ],
    },
    expectedTimeSeconds: PROFILE_TIMES_SECONDS,
    // Samples at a command boundary describe the interval that just completed.
    expectedTargetC: [
      200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    expectedSensorC: [
      22, 153.55288114, 158.408089245, 160.955302412, 163.404263346, 165.779281545, 168.078409984,
      170.300378357, 172.444700775, 174.511543924, 176.501583795, 178.415913952, 113.640547077,
      66.237897566, 63.758997692, 62.113634599, 60.541915883, 59.029980627, 57.575581908,
      56.177740306, 54.833306448,
    ],
    expectedPowerByte: [
      0, 227.194738754, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0.939432708, 0, 0, 0, 0,
      0, 0, 0, 0,
    ],
    expectedMetrics: {
      finalSensorC: 54.833306448,
      minimumSensorC: 22,
      maximumSensorC: 179.797896894,
      minimumPowerByte: 0,
      maximumPowerByte: 255,
    },
  },
] as const;
