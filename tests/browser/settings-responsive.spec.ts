import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'minimum', width: 900, height: 600 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`Settings containment: ${theme} theme at ${viewport.name} viewport`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/?state=disconnected&theme=${theme}#/settings`, {
        waitUntil: 'domcontentloaded',
      });

      await expect(page.locator('.settings-layout')).toBeVisible();
      await expect(page.locator('.settings-card').first()).toBeVisible();
      await expect(page.locator('.theme-options')).toBeVisible();
      await expect(page.locator('.catalog-card')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );

      const bounds = await page.locator('.settings-layout').boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    });
  }
}
