import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'minimum', width: 900, height: 600 },
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
  expect(child.x + child.width, `${label} should not escape right`).toBeLessThanOrEqual(
    parent.x + parent.width + 1,
  );
  expect(child.y, `${label} should not escape top`).toBeGreaterThanOrEqual(parent.y - 1);
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
  expect(rect.x + rect.width, `${label} should be visible on the right`).toBeLessThanOrEqual(
    viewport.width,
  );
  expect(rect.y, `${label} should be visible at the top`).toBeGreaterThanOrEqual(0);
  expect(rect.y + rect.height, `${label} should be visible at the bottom`).toBeLessThanOrEqual(
    viewport.height,
  );
}

async function attachDiagnostics(page: Page, testInfo: TestInfo): Promise<void> {
  const diagnostics = await page.evaluate(() => {
    const selectors = [
      '.simulation-layout',
      '.simulation-controls',
      '.oven-visual-panel',
      '.simulation-chart',
      '.playback-bar',
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
  await testInfo.attach('simulation-responsive-diagnostics.json', {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('simulation-responsive-page.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
}

for (const theme of THEMES) {
  test(`populated Simulation remains contained while resizing: ${theme} theme`, async ({
    page,
  }, testInfo) => {
    try {
      await page.setViewportSize(VIEWPORTS[0]);
      await page.goto(`/?state=simulation&theme=${theme}#/simulation`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.simulation-chart')).toBeVisible();
      await expect(page.locator('.metric-comparison')).toHaveCount(2);
      await expect(page.locator('.chart-body svg')).toBeVisible();

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        const layout = await rectangle(page.locator('.simulation-layout'));
        const controls = await rectangle(page.locator('.simulation-controls'));
        const twin = await rectangle(page.locator('.oven-visual-panel'));
        const chart = await rectangle(page.locator('.simulation-chart'));
        expectContained(controls, layout, 'simulation controls');
        expectContained(twin, layout, 'physical-twin workspace');
        expectContained(chart, layout, 'simulation chart');
        expectDisjoint(twin, chart, 'physical-twin workspace and chart');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );

        await expectFocusedWithinViewport(
          page,
          page.getByRole('button', { name: 'Simulation', exact: true }),
          'simulation section action',
        );
        await expectFocusedWithinViewport(
          page,
          page.getByRole('button', { name: 'Reset simulation' }),
          'reset action',
        );
        await expectFocusedWithinViewport(
          page,
          page.getByRole('button', { name: 'Single step' }),
          'single-step action',
        );
      }
    } catch (error) {
      await attachDiagnostics(page, testInfo);
      throw error;
    }
  });
}
