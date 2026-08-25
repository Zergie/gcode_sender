import { describe, expect, it } from 'vitest';
import { inspectArchiveChain, validateExceptions } from './archive-security-verifier.mjs';

const policy = {
  archivePackages: {
    tar: [
      { advisory: 'GHSA-test-tar', affectedVersions: ['6.2.1'], workflow: 'desktop packaging' },
    ],
  },
};

function lockfile(version = '6.2.1') {
  return {
    packages: {
      '': { devDependencies: { forge: '1.0.0' } },
      'node_modules/forge': { version: '1.0.0', dependencies: { tar: '^6.0.0' } },
      'node_modules/forge/node_modules/tar': { version },
    },
  };
}

describe('archive security verifier', () => {
  it('reports vulnerable archive versions with the complete parent chain', () => {
    const result = inspectArchiveChain({ lockfile: lockfile(), policy });

    expect(result.ok).toBe(false);
    expect(result.unexcepted).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      advisory: 'GHSA-test-tar',
      package: 'tar',
      version: '6.2.1',
      workflow: 'desktop packaging',
      parentChain: ['', 'node_modules/forge', 'node_modules/forge/node_modules/tar'],
    });
  });

  it('passes a clean lockfile without consulting node_modules', () => {
    expect(inspectArchiveChain({ lockfile: lockfile('7.5.22'), policy }).ok).toBe(true);
  });

  it('rejects incomplete and expired reviewed exceptions', () => {
    const errors = validateExceptions(
      [{ advisory: 'GHSA-test-tar', owner: 'release-team', expiresOn: '2025-01-01' }],
      new Date('2026-01-01T00:00:00Z'),
    );

    expect(errors).toEqual([
      'exceptions[0].workflow is required',
      'exceptions[0].exposureAnalysis is required',
      'exceptions[0].removalCondition is required',
      'exceptions[0] is expired (2025-01-01)',
    ]);
  });

  it('accepts a complete current exception for a reviewed finding', () => {
    const exception = {
      advisory: 'GHSA-test-tar',
      workflow: 'desktop packaging',
      exposureAnalysis: 'The package is only used by the local packager.',
      owner: 'release-team',
      expiresOn: '2027-01-01',
      removalCondition: 'Remove when the maintained packager chain is available.',
    };
    const result = inspectArchiveChain({
      lockfile: lockfile(),
      policy,
      exceptions: [exception],
      now: new Date('2026-01-01T00:00:00Z'),
    });

    expect(result.invalidExceptions).toEqual([]);
    expect(result.findings[0].excepted).toBe(true);
    expect(result.unexcepted).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});
