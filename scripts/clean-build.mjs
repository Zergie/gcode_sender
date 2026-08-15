import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  all: ['dist'],
  renderer: [path.join('dist', 'renderer')],
  electron: [path.join('dist', 'electron'), path.join('dist', 'shared')],
  package: ['out'],
};

const selection = process.argv[2] ?? 'all';
if (!Object.hasOwn(targets, selection)) {
  throw new TypeError(`Unknown clean target: ${selection}`);
}

for (const relativeTarget of targets[selection]) {
  const target = path.resolve(repositoryRoot, relativeTarget);
  const relative = path.relative(repositoryRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.length === 0) {
    throw new Error(`Refusing to clean path outside the repository: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}
