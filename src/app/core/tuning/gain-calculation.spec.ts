import { describe, expect, it } from 'vitest';

import { deriveRelayPidGains } from './gain-calculation';
import type { RelayPeak } from './types';

function regularPeaks(amplitudeC = 5): RelayPeak[] {
  return Array.from({ length: 12 }, (_, index) => ({
    kind: index % 2 === 0 ? ('high' as const) : ('low' as const),
    temperatureC: 150 + (index % 2 === 0 ? amplitudeC : -amplitudeC),
    atMs: index * 10_000,
  }));
}

describe('relay PID derivation', () => {
  it('matches Klipper-style relay/Ziegler-Nichols scaling for QuickPID', () => {
    const result = deriveRelayPidGains(regularPeaks());
    const expectedKu = (4 * 255) / (Math.PI * 5);

    expect(result.ultimateGain).toBeCloseTo(expectedKu, 10);
    expect(result.ultimatePeriodSeconds).toBe(20);
    expect(result.quickPid.kp).toBeCloseTo(0.6 * expectedKu, 10);
    expect(result.quickPid.ki).toBeCloseTo((0.6 * expectedKu) / 10, 10);
    expect(result.quickPid.kd).toBeCloseTo(0.6 * expectedKu * 2.5, 10);
    expect(result.conservative.kp).toBeLessThan(result.quickPid.kp);
    expect(result.conservative.ki).toBeLessThan(result.quickPid.ki);
  });

  it('uses a later median cycle and tolerates a timing outlier', () => {
    const peaks = regularPeaks();
    peaks[7] = { ...peaks[7]!, atMs: peaks[7]!.atMs + 2_000 };
    const result = deriveRelayPidGains(peaks);
    expect(result.ultimatePeriodSeconds).toBe(20);
    expect(result.selectedCycle.peakIndex).toBeGreaterThanOrEqual(4);
  });

  it('rejects too few, non-alternating, and flat peaks', () => {
    expect(() => deriveRelayPidGains(regularPeaks().slice(0, 11))).toThrowError(
      expect.objectContaining({ code: 'INVALID_PEAKS' }),
    );
    const nonAlternating = regularPeaks();
    nonAlternating[3] = { ...nonAlternating[3]!, kind: 'high' };
    expect(() => deriveRelayPidGains(nonAlternating)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PEAKS' }),
    );
    expect(() => deriveRelayPidGains(regularPeaks(0.01), 0.25)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PEAKS' }),
    );
  });
});
