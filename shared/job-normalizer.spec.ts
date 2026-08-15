import { describe, expect, it } from 'vitest';

import {
  INITIAL_GCODE_COMMENT_STATE,
  normalizeGcodeLine,
  normalizeStartupMacro,
} from './job-normalizer';

describe('G-code normalization', () => {
  it('removes semicolon and parenthetical comments without validating the command', () => {
    expect(normalizeGcodeLine(' G1 X1 (move x) Y2 ; tail').command).toBe('G1 X1 Y2');
    expect(normalizeGcodeLine('TOTALLY_UNKNOWN A9').command).toBe('TOTALLY_UNKNOWN A9');
  });

  it('does not concatenate tokens separated by a comment', () => {
    expect(normalizeGcodeLine('M104(comment)S200').command).toBe('M104 S200');
  });

  it('carries nested parenthetical comments across lines', () => {
    const first = normalizeGcodeLine('G1 X1 (outer (inner)', INITIAL_GCODE_COMMENT_STATE);
    const second = normalizeGcodeLine('still comment) Y2', first.state);
    expect(first.command).toBe('G1 X1');
    expect(second.command).toBe('Y2');
    expect(second.state.parenthesisDepth).toBe(0);
  });

  it('normalizes a multiline startup macro', () => {
    expect(normalizeStartupMacro('\uFEFFM115\r\n; comment\nM105 (sample)')).toEqual([
      'M115',
      'M105',
    ]);
  });
});
