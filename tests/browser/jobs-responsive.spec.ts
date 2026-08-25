import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'minimum', width: 900, height: 600 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`Jobs containment: ${theme} theme at ${viewport.name} viewport`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/?state=disconnected&theme=${theme}#/jobs`, {
        waitUntil: 'domcontentloaded',
      });

      await expect(page.locator('.jobs-layout')).toBeVisible();
      await expect(page.locator('.drop-zone')).toBeVisible();
      await expect(page.locator('.start-card')).toBeVisible();
      await expect(page.locator('.protocol-note')).toBeVisible();
      await expect(page.locator('.jobs-layout')).toHaveCSS('grid-template-columns', /.+/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );

      const bounds = await page.locator('.jobs-layout').boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    });
  }
}
