import { readFile } from 'node:fs/promises';

const workflows = {
  fast: {
    path: '.github/workflows/windows-verification.yml',
    name: 'Windows verification',
    jobName: 'Windows fast verification',
    required: [
      'npm ci --ignore-scripts',
      'npm run test:renderer',
      'npm run test:desktop',
      'npm run lint',
      'npm run format:check',
      'npm run typecheck:renderer',
      'npm run typecheck:desktop',
    ],
  },
  firmware: {
    path: '.github/workflows/portable-firmware-integration.yml',
    name: 'Portable firmware integration',
    jobName: 'Portable firmware integration (${{ matrix.os }})',
    required: [
      'npm ci --ignore-scripts',
      'npm run test:firmware-integration',
      'retention-days: 7',
      'TOOLCHAIN_UNAVAILABLE|TOOLCHAIN_SETUP_FAILED|COMPILE_FAILED|ABI_INCOMPATIBLE',
    ],
  },
  packaging: {
    path: '.github/workflows/windows-packaging.yml',
    name: 'Windows desktop packaging',
    jobName: 'Windows desktop packaging',
    required: [
      'npm ci --ignore-scripts',
      'npm run rebuild:native',
      'npm run verify:windows-package -- -KeepArtifacts',
      'retention-days: 7',
    ],
  },
};

const failures = [];

for (const [id, workflow] of Object.entries(workflows)) {
  const source = await readFile(workflow.path, 'utf8');
  const required = [
    `name: ${workflow.name}`,
    'pull_request:',
    'push:',
    'branches:',
    '      - main',
    'cancel-in-progress: true',
    'permissions:',
    '  contents: read',
    `name: ${workflow.jobName}`,
    ...workflow.required,
  ];

  for (const text of required) {
    if (!source.includes(text)) {
      failures.push(`${id}: missing required workflow contract: ${text}`);
    }
  }

  if (source.includes('continue-on-error: true')) {
    failures.push(`${id}: verification failures must not be masked`);
  }
  if (source.includes('secrets.')) {
    failures.push(`${id}: Windows verification must not require production secrets`);
  }
}

const fast = await readFile(workflows.fast.path, 'utf8');
if (!fast.includes('cache: npm') || !fast.includes('cache-dependency-path: package-lock.json')) {
  failures.push('fast: dependency caching must use npm download data keyed by package-lock.json');
}

const firmware = await readFile(workflows.firmware.path, 'utf8');
for (const os of ['windows-2022', 'ubuntu-24.04']) {
  if (!firmware.includes(`          - ${os}`)) {
    failures.push(`firmware: missing integration matrix entry: ${os}`);
  }
}
if (!firmware.includes('if: failure()')) {
  failures.push('firmware: diagnostics must upload only for failed integration jobs');
}

const packaging = await readFile(workflows.packaging.path, 'utf8');
if (!packaging.includes('if: always()')) {
  failures.push(
    'packaging: package and smoke-test diagnostics must remain inspectable after failure',
  );
}

if (failures.length > 0) {
  throw new Error(`Windows CI qualification failed:\n- ${failures.join('\n- ')}`);
}

console.log(
  'Windows CI qualification passed: fast verification, portable firmware integration, ' +
    'and Windows desktop packaging have stable triggers, permissions, failure handling, ' +
    'and documented command contracts.',
);
