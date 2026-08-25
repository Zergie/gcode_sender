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
  dashboard: [
    '.metric-grid',
    '.metric-card',
    '.dashboard-layout',
    '.chart-panel',
    '.chart-tools',
    '.profile-editor',
    '.chart-status',
    '.dashboard-rail',
    '.target-panel',
    '.output-panel',
    '.program-card',
  ],
  terminal: [
    '.terminal-page',
    '.terminal-shell',
    '.terminal-toolbar',
    '.traffic-legend',
    '.terminal-output',
    '.terminal-line',
    '.terminal-empty',
    '.terminal-composer',
    '.prompt',
    '.command-field',
    '.send-button',
    '.autocomplete',
    '.terminal-hints',
  ],
  jobs: [
    '.jobs-layout',
    '.jobs-main',
    '.jobs-rail',
    '.drop-zone',
    '.drop-icon',
    '.selected-file',
    '.file-identity',
    '.stream-facts',
    '.job-progress-card',
    '.progress-stats',
    '.job-controls',
    '.start-card',
    '.recent-list',
    '.recent-empty',
    '.recent-row',
    '.protocol-note',
  ],
  settings: [
    '.settings-page',
    '.settings-layout',
    '.settings-main',
    '.settings-rail',
    '.settings-card',
    '.settings-icon',
    '.settings-fields',
    '.fixed-value',
    '.connection-summary',
    '.settings-inline-note',
    '.theme-options',
    '.theme-preview',
    '.timeout-field',
    '.catalog-card',
    '.catalog-stat',
    '.notification-card',
    '.data-card',
    '.switch-row',
  ],
  simulation: [
    '.simulation-page',
    '.simulation-run-status',
    '.simulation-spinner',
    '.simulation-layout',
    '.simulation-controls',
    '.model-heading',
    '.model-summary',
    '.model-name',
    '.form-section',
    '.field-grid',
    '.range-field',
    '.advanced-toggle',
    '.advanced-fields',
    '.field-help',
    '.advanced-help',
    '.physical-parameter-groups',
    '.parameter-group',
    '.parameter-grid',
    '.derived-value',
    '.link-list',
    '.link-editor',
    '.mechanism-chip',
    '.radiation-editor',
    '.sensor-links',
    '.forecast-planner-parameters',
    '.fixed-step-note',
    '.simulation-workspace',
    '.oven-visual-panel',
    '.simulation-clock',
    '.oven-visual',
    '.oven-shell',
    '.oven-air',
    '.standard-load',
    '.flow',
    '.coil',
    '.sensor-pin',
    '.visual-readout',
    '.simulation-chart',
    '.controller-selector',
    '.comparison-insight',
    '.comparison-legend',
    '.playback-bar',
    '.transport-controls',
    '.round-control',
    '.playback-progress',
    '.timewarp',
    '.simulation-metrics',
    '.metric-comparison',
  ],
};

const routes = process.argv.slice(2);
if (routes.length === 0 || routes.some((route) => !(route in routeSelectors))) {
  console.error(
    `Usage: node scripts/check-migrated-route-styles.mjs ${Object.keys(routeSelectors).join('|')} ...`,
  );
  process.exitCode = 2;
} else {
  const stylesheet = await readFile('src/styles.scss', 'utf8');
  const leaked = routes.flatMap((route) =>
    routeSelectors[route]
      .filter((selector) =>
        new RegExp(`(^|[,{\\n])\\s*${selector.replace('.', '\\.')}(?=[\\s,{:#.>+~]|$)`).test(
          stylesheet,
        ),
      )
      .map((selector) => `${route}:${selector}`),
  );

  if (leaked.length > 0) {
    console.error(`Route selectors found in src/styles.scss: ${leaked.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`${routes.join(', ')} route selectors are component-scoped.`);
  }
}
