import { expect, test } from '@playwright/test';

test('simulation presents one digital-twin heading, one firmware warning, and the terminal below the cutaway', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?state=simulation&theme=dark#/simulation', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('.model-heading')).toHaveText(/^Digital Twin$/);
  await expect(page.locator('.model-name')).toHaveCount(0);
  await expect(page.getByText('TWIN v1', { exact: true })).toHaveCount(0);

  const firmwarePrompt = page.getByText('Choose or replace the .ino file in Settings.', {
    exact: true,
  });
  await expect(firmwarePrompt).toHaveCount(1);
  const banner = page.locator('.tuning-page > .notice-banner');
  await expect(banner).toContainText('Choose or replace the .ino file in Settings.');
  await expect(banner.getByRole('button', { name: 'Choose .ino' })).toBeVisible();
  const bannerBox = await banner.boundingBox();
  const layoutBox = await page.locator('.simulation-layout').boundingBox();
  expect(bannerBox).not.toBeNull();
  expect(layoutBox).not.toBeNull();
  expect(bannerBox!.y).toBeLessThan(layoutBox!.y);

  const simulationControl = page.locator('.simulation-control');
  await expect(
    simulationControl.getByRole('heading', { name: 'Simulation Control' }),
  ).toBeVisible();
  await expect(simulationControl.getByRole('spinbutton', { name: 'Target' })).toBeVisible();
  await expect(simulationControl.getByRole('spinbutton', { name: 'Duration' })).toBeVisible();
  await expect(simulationControl.locator('.terminal-toolbar')).toBeVisible();
  await expect(simulationControl.locator('.terminal-output[role="log"]')).toBeVisible();
  await expect(simulationControl.locator('.terminal-composer')).toBeVisible();
  await expect(
    page.locator('.simulation-controls').getByRole('heading', { name: 'Scenario' }),
  ).toHaveCount(0);
  await expect(page.locator('.firmware-output-panel')).toHaveCount(0);
  expect(await simulationControl.evaluate((element) => element.closest('aside') === null)).toBe(
    true,
  );
  const terminalBox = await simulationControl.boundingBox();
  const cutawayBox = await page.locator('.oven-visual-panel').boundingBox();
  expect(terminalBox).not.toBeNull();
  expect(cutawayBox).not.toBeNull();
  expect(terminalBox!.y).toBeGreaterThan(cutawayBox!.y + cutawayBox!.height);
});

test('simulation navigation merges profile, schedule, and live tuning into Tuning', async ({
  page,
}) => {
  await page.goto('/?state=simulation&theme=dark#/simulation', { waitUntil: 'domcontentloaded' });
  const tabs = page.locator('.section-tabs button');
  await expect(tabs).toHaveText(['Simulation', 'Tuning']);
  await page.getByRole('button', { name: 'Tuning', exact: true }).click();

  const profile = page.locator('.profile-library');
  const schedule = page.locator('.tuning-grid');
  const liveTuning = page.locator('.autotune-layout');
  await expect(profile).toBeVisible();
  await expect(schedule).toBeVisible();
  await expect(liveTuning).toBeVisible();
  const profileBox = await profile.boundingBox();
  const scheduleBox = await schedule.boundingBox();
  const liveTuningBox = await liveTuning.boundingBox();
  expect(profileBox).not.toBeNull();
  expect(scheduleBox).not.toBeNull();
  expect(liveTuningBox).not.toBeNull();
  expect(profileBox!.y).toBeLessThan(scheduleBox!.y);
  expect(scheduleBox!.y).toBeLessThan(liveTuningBox!.y);
  await expect(page.locator('.method-source')).toHaveCount(0);
  await expect(page.getByText('Klipper pid_calibrate', { exact: true })).toHaveCount(0);
});

test('terminal and jobs headers omit duplicate actions', async ({ page }) => {
  await page.goto('/?theme=dark#/terminal', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('app-page-header .status-chip')).toHaveCount(0);

  await page.goto('/?theme=dark#/jobs', { waitUntil: 'domcontentloaded' });
  await expect(
    page.locator('app-page-header').getByRole('button', { name: 'Choose file' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Browse files' })).toBeVisible();
});

test('temperature labels render outside the stretched SVG coordinate system', async ({ page }) => {
  await page.goto('/?theme=dark#/dashboard', { waitUntil: 'domcontentloaded' });
  const chart = page.locator('.chart-body app-trend-chart');
  await expect(chart.locator('svg .axis-labels')).toHaveCount(0);
  await expect(chart.locator('.axis-labels span')).toHaveText([
    '250°',
    '200°',
    '150°',
    '100°',
    '50°',
    '0°',
  ]);
});
