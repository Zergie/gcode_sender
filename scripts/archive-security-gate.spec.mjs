import { describe, expect, it } from 'vitest';
import { evaluateAuditReport } from './archive-security-gate.mjs';

const finding = (severity = 'high') => ({
  vulnerabilities: {
    tar: {
      severity,
      via: [{ source: 'GHSA-audit-tar', title: 'Archive traversal', severity }],
    },
  },
});

const exception = (expiresOn = '2027-01-01') => ({
  advisory: 'GHSA-audit-tar',
  workflow: 'desktop packaging',
  exposureAnalysis: 'Only the local build workflow consumes this package.',
  owner: 'release-team',
  expiresOn,
  removalCondition: 'Remove when the maintained dependency is available.',
});

describe('archive security gate audit evaluation', () => {
  it('passes the clean audit report', () => {
    expect(evaluateAuditReport({ vulnerabilities: {} }).ok).toBe(true);
  });

  it('fails an unmatched high or critical finding', () => {
    const result = evaluateAuditReport(finding('critical'));

    expect(result.ok).toBe(false);
    expect(result.unexcepted).toMatchObject([
      { package: 'tar', advisory: 'GHSA-audit-tar', severity: 'critical' },
    ]);
  });

  it('accepts a current complete exception for a finding', () => {
    const result = evaluateAuditReport(finding(), [exception()], new Date('2026-01-01T00:00:00Z'));

    expect(result.ok).toBe(true);
    expect(result.findings[0].excepted).toBe(true);
  });

  it('fails expired and incomplete exceptions even without an active finding', () => {
    const result = evaluateAuditReport(
      { vulnerabilities: {} },
      [{ advisory: 'GHSA-old', expiresOn: '2025-01-01' }],
      new Date('2026-01-01T00:00:00Z'),
    );

    expect(result.ok).toBe(false);
    expect(result.invalidExceptions).toContain('exceptions[0].workflow is required');
    expect(result.invalidExceptions).toContain('exceptions[0] is expired (2025-01-01)');
  });
});
