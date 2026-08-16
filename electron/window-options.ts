import path from 'node:path';

import type { BrowserWindowConstructorOptions } from 'electron';

interface MainWindowOptionsInput {
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly preloadPath: string;
}

export function createMainWindowOptions({
  appPath,
  isPackaged,
  platform,
  preloadPath,
}: MainWindowOptionsInput): BrowserWindowConstructorOptions {
  const developmentIcon = isPackaged
    ? undefined
    : path.join(appPath, 'images', iconFileFor(platform));

  return {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    useContentSize: true,
    show: false,
    backgroundColor: '#0b1118',
    autoHideMenuBar: true,
    ...(developmentIcon === undefined ? {} : { icon: developmentIcon }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
}

function iconFileFor(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'icon.ico';
  }
  if (platform === 'darwin') {
    return 'icon.icns';
  }
  return 'icon.png';
}
