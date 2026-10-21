import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'minimum', width: 900, height: 600 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`Tuning sections contain their workspace: ${theme} theme at ${viewport.name} viewport`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/?state=disconnected&theme=${theme}#/simulation`, {
        waitUntil: 'domcontentloaded',
      });

      await expect(page.locator('.tuning-page')).toBeVisible();
      await expect(page.locator('app-simulation')).toBeVisible();
      await expect(page.locator('.simulation-layout')).toBeVisible();

      await page.getByRole('button', { name: 'Tuning', exact: true }).click();
      for (const content of ['.profile-library', '.tuning-grid', '.autotune-layout'] as const) {
        await expect(page.locator(content)).toBeVisible();
        const bounds = await page.locator(content).boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      }

      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
    });
  }
}
