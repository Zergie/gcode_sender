import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMainWindowOptions } from './window-options';

const appPath = path.resolve('C:/workspace/gcode-sender');
const preloadPath = path.resolve(appPath, 'dist/electron/preload.js');

describe('createMainWindowOptions', () => {
  it.each([
    ['win32', 'icon.ico'],
    ['darwin', 'icon.icns'],
    ['linux', 'icon.png'],
  ] as const)('uses the branded %s icon for development windows', (platform, iconFile) => {
    const options = createMainWindowOptions({
      appPath,
      isPackaged: false,
      platform,
      preloadPath,
    });

    expect(options.icon).toBe(path.join(appPath, 'images', iconFile));
  });

  it('leaves packaged window icon selection to the branded executable', () => {
    const options = createMainWindowOptions({
      appPath,
      isPackaged: true,
      platform: 'win32',
      preloadPath,
    });

    expect(options).not.toHaveProperty('icon');
  });

  it('retains the hardened renderer configuration', () => {
    const options = createMainWindowOptions({
      appPath,
      isPackaged: false,
      platform: 'win32',
      preloadPath,
    });

    expect(options.webPreferences).toMatchObject({
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });
});
