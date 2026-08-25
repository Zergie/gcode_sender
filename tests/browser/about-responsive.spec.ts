import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'minimum', width: 900, height: 600 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`About geometry: ${theme} theme at ${viewport.name} viewport`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/#/about?theme=${theme}`, { waitUntil: 'domcontentloaded' });

      await expect(page.locator('.about-page')).toBeVisible();
      await expect(page.locator('.about-grid .about-card')).toHaveCount(3);
      await expect(page.locator('.about-details')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );

      await page.emulateMedia({ media: 'print' });
      await expect(page.locator('.about-page')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
    });
  }
}
