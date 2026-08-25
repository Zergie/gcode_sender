import { readFile } from 'node:fs/promises';

const routeSelectors = {
  about: [
    '.about-hero',
    '.about-mark',
    '.about-grid',
    '.about-card',
    '.about-details',
    '.about-footer',
  ],
};

const route = process.argv[2];
if (!route || !(route in routeSelectors)) {
  console.error(
    `Usage: node scripts/check-migrated-route-styles.mjs ${Object.keys(routeSelectors).join('|')}`,
  );
  process.exitCode = 2;
} else {
  const stylesheet = await readFile('src/styles.scss', 'utf8');
  const leaked = routeSelectors[route].filter((selector) =>
    new RegExp(`(^|[,{\\n])\\s*${selector.replace('.', '\\.')}(?=[\\s,{:#.>+~]|$)`).test(
      stylesheet,
    ),
  );

  if (leaked.length > 0) {
    console.error(`${route} selectors found in src/styles.scss: ${leaked.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`${route} route selectors are component-scoped.`);
  }
}
