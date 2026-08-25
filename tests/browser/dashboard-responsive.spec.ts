import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

const VIEWPORTS = [
  { name: 'minimum', width: 900, height: 600 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
const THEMES = ['light', 'dark'] as const;
type Rect = { x: number; y: number; width: number; height: number };

async function rectangle(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (box === null)
    throw new Error(`Expected ${await locator.evaluate((node) => node.tagName)} to be laid out`);
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function expectContained(child: Rect, parent: Rect, label: string): void {
  expect(child.x, `${label} should not escape left`).toBeGreaterThanOrEqual(parent.x - 1);
  expect(child.y, `${label} should not escape top`).toBeGreaterThanOrEqual(parent.y - 1);
  expect(child.x + child.width, `${label} should not escape right`).toBeLessThanOrEqual(
    parent.x + parent.width + 1,
  );
  expect(child.y + child.height, `${label} should not escape bottom`).toBeLessThanOrEqual(
    parent.y + parent.height + 1,
  );
}

function expectDisjoint(first: Rect, second: Rect, label: string): void {
  const overlaps =
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y;
  expect(overlaps, `${label} should not overlap`).toBe(false);
}

async function expectFocusedWithinViewport(
  page: Page,
  locator: Locator,
  label: string,
): Promise<void> {
  await locator.focus();
  await expect(locator, `${label} should receive keyboard focus`).toBeFocused();
  await locator.scrollIntoViewIfNeeded();
  const rect = await rectangle(locator);
  const viewport = page.viewportSize()!;
  expect(rect.x, `${label} should be visible on the left`).toBeGreaterThanOrEqual(0);
  expect(rect.y, `${label} should be visible at the top`).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width, `${label} should be visible on the right`).toBeLessThanOrEqual(
    viewport.width,
  );
  expect(rect.y + rect.height, `${label} should be visible at the bottom`).toBeLessThanOrEqual(
    viewport.height,
  );
}

async function attachDiagnostics(page: Page, testInfo: TestInfo): Promise<void> {
  const diagnostics = await page.evaluate(() => {
    const selectors = [
      '.metric-grid',
      '.metric-card',
      '.dashboard-layout',
      '.chart-panel',
      '.dashboard-rail',
      '.target-panel',
      '.program-card',
    ];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      rects: Object.fromEntries(
        selectors.map((selector) => {
          const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
          return [
            selector,
            rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          ];
        }),
      ),
      bodyExcerpt: document.body.innerText.slice(0, 2_000),
    };
  });
  await testInfo.attach('dashboard-responsive-diagnostics.json', {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('dashboard-responsive-page.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`active Dashboard containment: ${theme} theme at ${viewport.name} viewport`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      try {
        await page.goto(`/?state=monitoring&theme=${theme}#/dashboard`, {
          waitUntil: 'domcontentloaded',
        });

        const metricGrid = page.locator('.metric-grid');
        const metrics = page.locator('.metric-card');
        const dashboardLayout = page.locator('.dashboard-layout');
        const chart = page.locator('.chart-panel');
        const rail = page.locator('.dashboard-rail');
        const targetPanel = page.locator('.target-panel');
        const programPanel = page.locator('.program-card');
        await expect(page.locator('.route-stage')).toContainText('Dashboard');
        await expect(page.locator('.metric-value').first()).toContainText('184.6');
        await expect(page.locator('.chart-panel')).toBeVisible();
        await expect(page.locator('.dashboard-rail')).toBeVisible();

        const metricGridRect = await rectangle(metricGrid);
        const dashboardLayoutRect = await rectangle(dashboardLayout);
        const chartRect = await rectangle(chart);
        const railRect = await rectangle(rail);
        expectContained(metricGridRect, await rectangle(page.locator('.workspace')), 'metric grid');
        expectContained(chartRect, dashboardLayoutRect, 'thermal chart');
        expectContained(railRect, dashboardLayoutRect, 'dashboard rail');
        expectDisjoint(chartRect, railRect, 'thermal chart and dashboard rail');
        for (let index = 0; index < (await metrics.count()); index += 1) {
          expectContained(
            await rectangle(metrics.nth(index)),
            metricGridRect,
            `metric ${index + 1}`,
          );
        }
        expectContained(await rectangle(targetPanel), railRect, 'target controls');
        expectContained(await rectangle(programPanel), railRect, 'heating program');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );

        await expectFocusedWithinViewport(
          page,
          page.getByRole('slider', { name: 'Target temperature' }),
          'target control',
        );
        await expectFocusedWithinViewport(
          page,
          page.getByRole('button', { name: 'Apply & arm control' }),
          'apply target action',
        );
        await expectFocusedWithinViewport(
          page,
          page.getByRole('button', { name: 'Run' }),
          'heating program action',
        );
      } catch (error) {
        await attachDiagnostics(page, testInfo);
        throw error;
      }
    });
  }
}
