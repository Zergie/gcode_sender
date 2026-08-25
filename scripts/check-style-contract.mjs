import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { routeSelectors, findLeakedRouteSelectors } from './check-migrated-route-styles.mjs';

const globalSourceMaximum = 19_000;
const globalCompiledMaximum = 16_000;
const outputDirectory = 'dist/renderer';

const source = await readFile('src/styles.scss', 'utf8');
const sourceBytes = Buffer.byteLength(source);
const sourceLeaks = findLeakedRouteSelectors(source);
if (sourceLeaks.length > 0) {
  throw new Error(`Global stylesheet owns migrated route selectors: ${sourceLeaks.join(', ')}`);
}
if (sourceBytes > globalSourceMaximum) {
  throw new Error(`src/styles.scss is ${sourceBytes} bytes; maximum is ${globalSourceMaximum}`);
}

const outputEntries = await readdir(outputDirectory);
const outputFiles = await Promise.all(
  outputEntries.map(async (name) => ({
    name,
    isFile: (await stat(join(outputDirectory, name))).isFile(),
  })),
);
const cssFiles = outputFiles.filter(
  ({ name, isFile }) => isFile && /^styles-[^/]+\.css$/.test(name),
);
if (cssFiles.length !== 1) {
  throw new Error(
    `Expected exactly one global stylesheet in ${outputDirectory}, found ${cssFiles.length}`,
  );
}
const compiledBytes = (await stat(join(outputDirectory, cssFiles[0].name))).size;
if (compiledBytes > globalCompiledMaximum) {
  throw new Error(
    `${cssFiles[0].name} is ${compiledBytes} bytes; maximum is ${globalCompiledMaximum}`,
  );
}

const javascriptFiles = outputFiles
  .filter(({ name, isFile }) => isFile && /^chunk-.+\.js$|^main-.+\.js$/.test(name))
  .map(({ name }) => name);
const initialFiles = javascriptFiles.filter((name) => name.startsWith('main-'));
const lazyFiles = javascriptFiles.filter((name) => name.startsWith('chunk-'));
const initialText = (
  await Promise.all(initialFiles.map((name) => readFile(join(outputDirectory, name), 'utf8')))
).join('\n');
const initialLeaks = findLeakedRouteSelectors(initialText);
if (initialLeaks.length > 0) {
  throw new Error(
    `Migrated route styles were included in the initial bundle: ${initialLeaks.join(', ')}`,
  );
}

const lazyTexts = await Promise.all(
  lazyFiles.map(async (name) => [name, await readFile(join(outputDirectory, name), 'utf8')]),
);
const missingLazyOwners = Object.entries(routeSelectors)
  .filter(
    ([, selectors]) =>
      !selectors.some((selector) => lazyTexts.some(([, text]) => text.includes(selector))),
  )
  .map(([route]) => route);
if (missingLazyOwners.length > 0) {
  throw new Error(`No lazy bundle contains migrated styles for: ${missingLazyOwners.join(', ')}`);
}

console.log(
  `Global style contract passed: source ${sourceBytes} B / ${globalSourceMaximum} B, ` +
    `compiled ${compiledBytes} B / ${globalCompiledMaximum} B; ` +
    `${Object.keys(routeSelectors).length} routes remain lazy-scoped.`,
);
