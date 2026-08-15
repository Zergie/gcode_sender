import { TuningDomainError } from './tuning-error';
import type { DerivedPidGains, PidGains, RelayCycleEstimate, RelayPeak } from './types';

const FIRMWARE_OUTPUT_MAX = 255;

function validatePeaks(peaks: readonly RelayPeak[], minimumPeakSwingC: number): void {
  if (peaks.length < 12) {
    throw new TuningDomainError(
      'INVALID_PEAKS',
      'Relay calibration requires at least 12 alternating peaks.',
      'peaks',
    );
  }
  if (!Number.isFinite(minimumPeakSwingC) || minimumPeakSwingC <= 0) {
    throw new TuningDomainError(
      'INVALID_CONFIGURATION',
      'minimumPeakSwingC must be finite and greater than zero.',
      'minimumPeakSwingC',
    );
  }
  peaks.forEach((peak, index) => {
    if (!Number.isFinite(peak.temperatureC) || !Number.isFinite(peak.atMs)) {
      throw new TuningDomainError(
        'INVALID_PEAKS',
        'Peak values must be finite.',
        `peaks[${index}]`,
      );
    }
    if (index > 0) {
      const previous = peaks[index - 1];
      if (previous === undefined || peak.atMs <= previous.atMs || peak.kind === previous.kind) {
        throw new TuningDomainError(
          'INVALID_PEAKS',
          'Peaks must be time-ordered and alternate high/low.',
          `peaks[${index}]`,
        );
      }
    }
    if (index > 1 && peak.kind !== peaks[index - 2]?.kind) {
      throw new TuningDomainError(
        'INVALID_PEAKS',
        'Every second peak must have the same kind.',
        `peaks[${index}]`,
      );
    }
  });
}

function cycleEstimates(peaks: readonly RelayPeak[]): RelayCycleEstimate[] {
  const estimates: RelayCycleEstimate[] = [];
  // As in Klipper's relay autotune, ignore early warm-up cycles and use the
  // median later cycle time. This is a clean-room TypeScript implementation;
  // no Python source text is copied.
  for (let peakIndex = 4; peakIndex < peaks.length; peakIndex += 1) {
    const current = peaks[peakIndex];
    const previous = peaks[peakIndex - 1];
    const previousSameKind = peaks[peakIndex - 2];
    if (current === undefined || previous === undefined || previousSameKind === undefined) {
      continue;
    }
    estimates.push({
      peakIndex,
      amplitudeC: Math.abs(current.temperatureC - previous.temperatureC) / 2,
      periodSeconds: (current.atMs - previousSameKind.atMs) / 1000,
    });
  }
  return estimates;
}

function assertFiniteGains(gains: PidGains): PidGains {
  if (![gains.kp, gains.ki, gains.kd].every((gain) => Number.isFinite(gain) && gain >= 0)) {
    throw new TuningDomainError('INVALID_PEAKS', 'The relay trace produced invalid PID gains.');
  }
  return gains;
}

/**
 * Derives gains from a saturated 0/255 relay trace.
 *
 * Klipper performs the relay test in a normalized 0..1 power domain and scales
 * reported PID parameters by 255. QuickPID controls this firmware directly in
 * a 0..255 domain, so using 255 in the ultimate-gain calculation yields the
 * same reported numeric gains in the per-second Ki / seconds Kd convention
 * accepted by QuickPID's SetTunings().
 */
export function deriveRelayPidGains(
  peaks: readonly RelayPeak[],
  minimumPeakSwingC = 0.25,
): DerivedPidGains {
  validatePeaks(peaks, minimumPeakSwingC);
  const estimates = cycleEstimates(peaks).filter(
    (estimate) => estimate.periodSeconds > 0 && estimate.amplitudeC >= minimumPeakSwingC,
  );
  if (estimates.length === 0) {
    throw new TuningDomainError(
      'INVALID_PEAKS',
      'The relay trace has insufficient oscillation amplitude.',
      'peaks',
    );
  }

  const sortedByPeriod = [...estimates].sort(
    (left, right) => left.periodSeconds - right.periodSeconds,
  );
  const selected = sortedByPeriod[Math.floor(sortedByPeriod.length / 2)];
  if (selected === undefined) {
    throw new TuningDomainError('INVALID_PEAKS', 'No usable relay cycle was found.');
  }

  const ultimateGain = (4 * FIRMWARE_OUTPUT_MAX) / (Math.PI * selected.amplitudeC);
  const ultimatePeriodSeconds = selected.periodSeconds;

  const kp = 0.6 * ultimateGain;
  const integralTimeSeconds = 0.5 * ultimatePeriodSeconds;
  const derivativeTimeSeconds = 0.125 * ultimatePeriodSeconds;
  const quickPid = assertFiniteGains({
    kp,
    ki: kp / integralTimeSeconds,
    kd: kp * derivativeTimeSeconds,
  });

  // Tyreus-Luyben is intentionally offered as the less aggressive draft.
  const conservativeKp = 0.31 * ultimateGain;
  const conservativeIntegralTimeSeconds = 2.2 * ultimatePeriodSeconds;
  const conservativeDerivativeTimeSeconds = 0.168 * ultimatePeriodSeconds;
  const conservative = assertFiniteGains({
    kp: conservativeKp,
    ki: conservativeKp / conservativeIntegralTimeSeconds,
    kd: conservativeKp * conservativeDerivativeTimeSeconds,
  });

  return {
    quickPid,
    conservative,
    ultimateGain,
    ultimatePeriodSeconds,
    temperatureAmplitudeC: selected.amplitudeC,
    selectedCycle: selected,
  };
}
