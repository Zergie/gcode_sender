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
    const selectors = ['.terminal-shell', '.terminal-output', '.terminal-composer', 'main'];
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
  await testInfo.attach('terminal-responsive-diagnostics.json', {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('terminal-responsive-page.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

function expectSameGeometry(before: Rect, after: Rect, label: string): void {
  expect(after.x, `${label} x should remain stable`).toBeCloseTo(before.x, 1);
  expect(after.y, `${label} y should remain stable`).toBeCloseTo(before.y, 1);
  expect(after.width, `${label} width should remain stable`).toBeCloseTo(before.width, 1);
  expect(after.height, `${label} height should remain stable`).toBeCloseTo(before.height, 1);
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`terminal transcript containment: ${theme} theme at ${viewport.name} viewport`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      try {
        await page.goto(`/?state=terminal&theme=${theme}#/terminal`, {
          waitUntil: 'domcontentloaded',
        });
        const shell = page.locator('.terminal-shell');
        const output = page.locator('.terminal-output');
        const composer = page.locator('.terminal-composer');
        const command = page.getByRole('textbox', { name: 'G-code command' });
        const send = page.getByRole('button', { name: /Send/ });
        await expect(shell).toBeVisible();
        await expect(output).toContainText('deterministic terminal command');
        expect(await output.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
          await output.evaluate((element) => element.clientHeight),
        );

        const shellBefore = await rectangle(shell);
        const composerBefore = await rectangle(composer);
        const documentBefore = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        }));
        await output.evaluate((element) => (element.scrollTop = element.scrollHeight));
        await command.fill('M105');
        await expect(send).toBeEnabled();
        await send.click();
        await expect(output).toContainText('M105');

        expectSameGeometry(shellBefore, await rectangle(shell), 'terminal shell');
        expectSameGeometry(composerBefore, await rectangle(composer), 'terminal composer');
        expect(await output.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
          await output.evaluate((element) => element.clientHeight),
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight),
        ).toBeLessThanOrEqual(documentBefore.scrollHeight);

        await command.fill('M105');
        await command.focus();
        await expect(command).toBeFocused();
        await send.focus();
        await expect(send).toBeFocused();
        const focused = await rectangle(send);
        expect(focused.x).toBeGreaterThanOrEqual(0);
        expect(focused.y).toBeGreaterThanOrEqual(0);
        expect(focused.x + focused.width).toBeLessThanOrEqual(viewport.width);
        expect(focused.y + focused.height).toBeLessThanOrEqual(viewport.height);
      } catch (error) {
        await attachDiagnostics(page, testInfo);
        throw error;
      }
    });
  }
}
