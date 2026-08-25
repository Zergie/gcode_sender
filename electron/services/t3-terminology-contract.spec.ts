import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { T3_TELEMETRY_SEMANTICS } from '../../shared/t3-semantics';

const repositoryRoot = join(import.meta.dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8');
}

function normalized(relativePath: string): string {
  return read(relativePath).replace(/\s+/g, ' ');
}

describe('T3 terminology contract', () => {
  it('keeps documentation and product surfaces aligned with the approved meaning', () => {
    const canonicalLabel = T3_TELEMETRY_SEMANTICS.label;

    expect(read('README.md')).toContain(canonicalLabel);
    expect(normalized('README.md')).toContain(
      'externally exposed enclosure thermistor; informational only.',
    );
    expect(normalized('ARCHITECTURE.md')).toContain(canonicalLabel);
    expect(normalized('ARCHITECTURE.md')).toContain(
      'externally exposed enclosure thermistor; informational only.',
    );
    expect(normalized('T3-HARDWARE-SEMANTICS.md')).toContain(canonicalLabel);

    expect(read('src/app/features/dashboard/dashboard.html')).toContain('t3Semantics.label');
    expect(read('src/app/features/dashboard/dashboard.html')).toContain('t3Semantics.description');
    expect(read('src/app/features/simulation/simulation.html')).toContain(canonicalLabel);
    expect(read('electron/services/live-tuning-service.ts')).toContain(
      'T3_TELEMETRY_SEMANTICS.label',
    );
    expect(read('electron/services/session-artifact-exporter.ts')).toContain(
      'T3_TELEMETRY_SEMANTICS.label',
    );
    expect(read('src/app/features/simulation/simulation.ts')).toContain(
      'T3_TELEMETRY_SEMANTICS.label',
    );
  });

  it('rejects obsolete T3 terminology in product surfaces and documentation', () => {
    const checkedPaths = [
      'README.md',
      'ARCHITECTURE.md',
      'src/app/features/dashboard/dashboard.html',
      'src/app/features/settings/settings.html',
      'src/app/features/simulation/simulation.html',
      'src/app/features/simulation/simulation.ts',
      'electron/services/live-tuning-service.ts',
      'electron/services/session-artifact-exporter.ts',
    ];
    const obsoleteTerms = [
      /T3\s+safety/i,
      /T3\s+room\s+conductance/i,
      /MCU\s+sensor/i,
      /safety\/enclosure/i,
    ];

    for (const path of checkedPaths) {
      const content = read(path);
      for (const obsoleteTerm of obsoleteTerms) {
        expect(content, `${path} contains obsolete T3 terminology`).not.toMatch(obsoleteTerm);
      }
    }
  });
});
