import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_EXCEPTION_FIELDS = [
  'advisory',
  'workflow',
  'exposureAnalysis',
  'owner',
  'expiresOn',
  'removalCondition',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function packageName(packageKey) {
  const marker = 'node_modules/';
  const index = packageKey.lastIndexOf(marker);
  return index === -1 ? packageKey : packageKey.slice(index + marker.length);
}

function rootDependencies(lockfile) {
  return {
    ...lockfile.packages?.['']?.dependencies,
    ...lockfile.packages?.['']?.devDependencies,
  };
}

function dependencyKey(parentKey, dependencyName) {
  const candidate = `${parentKey}/node_modules/${dependencyName}`;
  if (parentKey === '') return `node_modules/${dependencyName}`;
  return candidate;
}

function findPackageKey(lockfile, parentKey, dependencyName) {
  let key = dependencyKey(parentKey, dependencyName);
  while (key !== 'node_modules') {
    if (lockfile.packages?.[key]) return key;
    const parent = key.slice(0, key.lastIndexOf('/node_modules/'));
    if (!parent || parent === key) break;
    key = `${parent}/node_modules/${dependencyName}`;
  }
  return lockfile.packages?.[`node_modules/${dependencyName}`]
    ? `node_modules/${dependencyName}`
    : undefined;
}

function graphPaths(lockfile) {
  const paths = new Map();
  const visit = (parentKey, chain, dependencies) => {
    for (const dependencyName of Object.keys(dependencies ?? {})) {
      const key = findPackageKey(lockfile, parentKey, dependencyName);
      if (!key || paths.has(key)) continue;
      const nextChain = [...chain, key];
      paths.set(key, nextChain);
      visit(key, nextChain, lockfile.packages[key].dependencies);
    }
  };
  visit('', [''], rootDependencies(lockfile));
  return paths;
}

function matchesVersion(version, affectedVersions) {
  return affectedVersions.includes(version);
}

export function validateExceptions(exceptions, now = new Date()) {
  const errors = [];
  for (const [index, exception] of exceptions.entries()) {
    for (const field of REQUIRED_EXCEPTION_FIELDS) {
      if (typeof exception?.[field] !== 'string' || exception[field].trim() === '') {
        errors.push(`exceptions[${index}].${field} is required`);
      }
    }
    if (typeof exception?.expiresOn === 'string') {
      const expiry = new Date(`${exception.expiresOn}T23:59:59.999Z`);
      if (Number.isNaN(expiry.valueOf())) {
        errors.push(`exceptions[${index}].expiresOn must be an ISO date`);
      } else if (expiry < now) {
        errors.push(`exceptions[${index}] is expired (${exception.expiresOn})`);
      }
    }
  }
  return errors;
}

export function inspectArchiveChain({ lockfile, policy, exceptions = [], now = new Date() }) {
  const exceptionsByAdvisory = new Map(
    exceptions.map((exception) => [exception.advisory, exception]),
  );
  const exceptionErrors = validateExceptions(exceptions, now);
  const paths = graphPaths(lockfile);
  const findings = [];

  for (const [packageKey, entry] of Object.entries(lockfile.packages ?? {})) {
    if (!packageKey || !entry?.version) continue;
    const name = packageName(packageKey);
    const rules = policy.archivePackages?.[name] ?? [];
    for (const rule of rules) {
      if (!matchesVersion(entry.version, rule.affectedVersions)) continue;
      const parentChain = paths.get(packageKey) ?? [packageKey];
      const exception = exceptionsByAdvisory.get(rule.advisory);
      const exceptionIsValid =
        exception !== undefined && validateExceptions([exception], now).length === 0;
      findings.push({
        advisory: rule.advisory,
        package: name,
        version: entry.version,
        node: packageKey,
        parentChain,
        workflow: rule.workflow,
        excepted: exceptionIsValid,
      });
    }
  }

  const unexcepted = findings.filter((finding) => !finding.excepted);
  const invalidExceptions = exceptionErrors.length > 0;
  return {
    ok: unexcepted.length === 0 && !invalidExceptions,
    findings,
    unexcepted,
    invalidExceptions: exceptionErrors,
  };
}

export function runFromFiles({ lockfilePath, policyPath, exceptionsPath, now = new Date() }) {
  const exceptions = exceptionsPath ? readJson(exceptionsPath) : [];
  return inspectArchiveChain({
    lockfile: readJson(lockfilePath),
    policy: readJson(policyPath),
    exceptions,
    now,
  });
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2)
    args.set(process.argv[index], process.argv[index + 1]);
  if (!args.get('--lockfile') || !args.get('--policy')) {
    console.error(
      'Usage: node scripts/archive-security-verifier.mjs --lockfile <path> --policy <path> [--exceptions <path>]',
    );
    process.exitCode = 2;
  } else {
    const result = runFromFiles({
      lockfilePath: path.resolve(args.get('--lockfile')),
      policyPath: path.resolve(args.get('--policy')),
      exceptionsPath: args.get('--exceptions') ? path.resolve(args.get('--exceptions')) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}
