import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectArchiveChain, validateExceptions } from './archive-security-verifier.mjs';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function auditAdvisories(name, vulnerability) {
  const via = Array.isArray(vulnerability?.via) ? vulnerability.via : [];
  const relevant = via.filter(
    (entry) =>
      typeof entry === 'object' &&
      ['high', 'critical'].includes(entry.severity ?? vulnerability.severity),
  );
  if (relevant.length === 0 && ['high', 'critical'].includes(vulnerability?.severity)) {
    return [{ advisory: name, title: name, severity: vulnerability.severity }];
  }
  return relevant.map((entry) => ({
    advisory: String(entry.source ?? entry.url ?? `${name}:${entry.title ?? 'audit-finding'}`),
    title: entry.title ?? name,
    severity: entry.severity ?? vulnerability.severity,
  }));
}

export function evaluateAuditReport(report, exceptions = [], now = new Date()) {
  const exceptionsByAdvisory = new Map(
    exceptions.map((exception) => [exception.advisory, exception]),
  );
  const invalidExceptions = validateExceptions(exceptions, now);
  const findings = [];
  for (const [name, vulnerability] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const finding of auditAdvisories(name, vulnerability)) {
      const exception = exceptionsByAdvisory.get(finding.advisory);
      const excepted = exception !== undefined && validateExceptions([exception], now).length === 0;
      findings.push({ package: name, ...finding, excepted });
    }
  }
  const unexcepted = findings.filter((finding) => !finding.excepted);
  return {
    ok: unexcepted.length === 0 && invalidExceptions.length === 0,
    findings,
    unexcepted,
    invalidExceptions,
  };
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function runAudit() {
  const result = spawnSync(
    npmCommand(),
    ['audit', '--json', '--include=dev', '--package-lock-only'],
    { encoding: 'utf8' },
  );
  if (!result.stdout?.trim()) {
    throw new Error(
      `npm audit did not produce a JSON report (exit ${result.status ?? 'unknown'}): ${result.stderr?.trim() ?? ''}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm audit produced invalid JSON: ${error.message}`);
  }
}

export function runGate({
  lockfilePath,
  policyPath,
  exceptionsPath,
  auditReportPath,
  now = new Date(),
}) {
  const exceptions = exceptionsPath ? readJson(exceptionsPath) : [];
  const archive = inspectArchiveChain({
    lockfile: readJson(lockfilePath),
    policy: readJson(policyPath),
    exceptions,
    now,
  });
  const audit = evaluateAuditReport(
    auditReportPath ? readJson(auditReportPath) : runAudit(),
    exceptions,
    now,
  );
  return { ok: archive.ok && audit.ok, archive, audit };
}

if (pathToFileURL(path.resolve(process.argv[1] ?? '')).href === import.meta.url) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2)
    args.set(process.argv[index], process.argv[index + 1]);
  const required = ['--lockfile', '--policy', '--exceptions'];
  if (required.some((argument) => !args.get(argument))) {
    console.error(
      'Usage: node scripts/archive-security-gate.mjs --lockfile <path> --policy <path> --exceptions <path> [--audit-report <path>]',
    );
    process.exitCode = 2;
  } else {
    try {
      const result = runGate({
        lockfilePath: path.resolve(args.get('--lockfile')),
        policyPath: path.resolve(args.get('--policy')),
        exceptionsPath: path.resolve(args.get('--exceptions')),
        auditReportPath: args.get('--audit-report')
          ? path.resolve(args.get('--audit-report'))
          : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
