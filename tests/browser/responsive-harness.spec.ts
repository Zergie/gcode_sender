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

async function attachDiagnostics(page: Page, testInfo: TestInfo): Promise<void> {
  const diagnostics = await page.evaluate(() => {
    const selectors = ['.workbench-shell', '.sidebar', '.workspace', '.route-stage', 'main'];
    const rects = Object.fromEntries(
      selectors.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        const rect = element?.getBoundingClientRect();
        return [
          selector,
          rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        ];
      }),
    );
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      rects,
      bodyExcerpt: document.body.innerText.slice(0, 2_000),
      htmlExcerpt: document.documentElement.outerHTML.slice(0, 4_000),
    };
  });
  await testInfo.attach('responsive-diagnostics.json', {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('responsive-page.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function expectWithinViewport(page: Page, locator: Locator): Promise<void> {
  const rect = await rectangle(locator);
  expect(rect.x, 'left edge should be visible').toBeGreaterThanOrEqual(0);
  expect(rect.y, 'top edge should be visible').toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width, 'right edge should be visible').toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(rect.y + rect.height, 'bottom edge should be visible').toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`shell containment: ${theme} theme at ${viewport.name} viewport`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      try {
        await page.goto(`/dashboard?state=disconnected&theme=${theme}`, {
          waitUntil: 'domcontentloaded',
        });
        await expect(page.locator('.workbench-shell')).toBeVisible();
        await expect(page.locator('.route-stage')).toContainText('Dashboard');
        await expectWithinViewport(page, page.locator('.workbench-shell'));
        await expectWithinViewport(page, page.locator('main.workspace'));
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        // Dashboard content is intentionally taller than the minimum viewport;
        // the shell must contain it without allowing horizontal page growth.
        await expect(page.locator('.serial-port-dialog')).toHaveCount(0);
        await expect(page.getByRole('region', { name: 'Machine connection' })).toBeVisible();
      } catch (error) {
        await attachDiagnostics(page, testInfo);
        throw error;
      }
    });
  }
}
