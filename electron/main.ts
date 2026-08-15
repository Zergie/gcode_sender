import path from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';

import { IPC } from '../shared/ipc';
import { EventHub } from './event-hub';
import { registerIpcHandlers } from './ipc-handlers';
import { MainLogger, type Logger } from './logger';
import { shutdownInOrder } from './shutdown';
import { ActivityService } from './services/activity-service';
import { CatalogService } from './services/catalog-service';
import { JobService } from './services/job-service';
import { LiveTuningService } from './services/live-tuning-service';
import { PersistenceStore } from './services/persistence-store';
import { SerialService } from './services/serial-service';

interface Runtime {
  readonly logger: Logger;
  readonly events: EventHub;
  readonly store: PersistenceStore;
  readonly activity: ActivityService;
  readonly serial: SerialService;
  readonly jobs: JobService;
  readonly tuning: LiveTuningService;
  readonly catalog: CatalogService;
  readonly unregisterIpc: () => void;
}

let mainWindow: BrowserWindow | null = null;
let runtime: Runtime | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  void app
    .whenReady()
    .then(initialize)
    .catch((error: unknown) => {
      console.error('Unable to initialize GCode Sender', error);
      app.exit(1);
    });
}

async function initialize(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const logger = new MainLogger(userDataPath);
  const events = new EventHub(logger);
  const store = new PersistenceStore(userDataPath, logger);
  await store.initialize();
  const activity = new ActivityService();
  const serial = new SerialService(activity, logger);
  const sessionsDirectory = path.join(userDataPath, 'sessions');
  const jobs = new JobService(sessionsDirectory, serial, activity, store, logger);
  const tuning = new LiveTuningService(sessionsDirectory, serial, activity, store, logger);
  const catalog = new CatalogService(path.join(userDataPath, 'catalog'), store, logger);
  const unregisterIpc = registerIpcHandlers({
    getRenderer: () => mainWindow?.webContents ?? null,
    serial,
    jobs,
    tuning,
    catalog,
    store,
    activity,
    logger,
  });
  runtime = { logger, events, store, activity, serial, jobs, tuning, catalog, unregisterIpc };
  wireEvents(runtime);
  configureSessionPermissions();
  await createWindow();
  logger.info('GCode Sender main process initialized', {
    platform: process.platform,
    arch: process.arch,
  });
}

function wireEvents(current: Runtime): void {
  current.serial.subscribe('state', (state) => current.events.emit(IPC.eventSerialState, state));
  current.serial.subscribe('line', (line) => current.events.emit(IPC.eventSerialLine, line));
  current.serial.subscribe('telemetry', (telemetry) =>
    current.events.emit(IPC.eventTelemetry, telemetry),
  );
  current.serial.subscribe('firmwareError', (error) =>
    current.events.emit(IPC.eventFirmwareError, error),
  );
  current.serial.subscribe('firmware', (firmware) => {
    current.events.emit(IPC.eventFirmware, firmware);
    void current.catalog.setFirmware(firmware);
  });
  current.jobs.subscribeState((state) => current.events.emit(IPC.eventJobState, state));
  current.jobs.subscribeTimeout((timeout) => current.events.emit(IPC.eventJobTimeout, timeout));
  current.tuning.subscribe((state) => current.events.emit(IPC.eventTuningState, state));
  current.catalog.subscribeApproval((request) =>
    current.events.emit(IPC.eventCatalogApproval, request),
  );
  current.catalog.subscribeSnapshot((snapshot) =>
    current.events.emit(IPC.eventCatalogSnapshot, snapshot),
  );
  current.activity.subscribe((state) => current.events.emit(IPC.eventActivity, state));
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    useContentSize: true,
    show: false,
    backgroundColor: '#0b1118',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;
  runtime?.events.attach(window.webContents);

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url, { activate: true });
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    runtime?.logger.error('Renderer process exited', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    runtime?.events.detach(window.webContents);
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  const developmentUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && developmentUrl !== undefined) {
    const url = requireSafeDevelopmentUrl(developmentUrl);
    await window.loadURL(url.href);
  } else {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

function configureSessionPermissions(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    for (const header of Object.keys(responseHeaders)) {
      if (header.toLowerCase() === 'content-security-policy') {
        delete responseHeaders[header];
      }
    }
    responseHeaders['Content-Security-Policy'] = [contentSecurityPolicy(app.isPackaged)];
    callback({ responseHeaders });
  });
}

app.on('activate', () => {
  if (mainWindow === null && runtime !== null) {
    void createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (quitting || runtime === null) {
    return;
  }
  event.preventDefault();
  quitting = true;
  const current = runtime;
  void shutdownInOrder({
    stopJob: () => current.jobs.stop(),
    cancelTuning: () => current.tuning.cancel(),
    disconnectSerial: () => current.serial.disconnect(),
  })
    .then((result) => {
      if (result.status === 'timed-out') {
        current.logger.warn('Main-process shutdown exceeded its deadline');
      }
      for (const error of result.errors) {
        current.logger.warn('Main-process cleanup stage failed', { error: error.message });
      }
    })
    .finally(() => {
      current.unregisterIpc();
      app.quit();
    });
});

process.on('uncaughtException', (error) =>
  runtime?.logger.error('Uncaught main-process exception', { error: error.message }),
);
process.on('unhandledRejection', (reason) =>
  runtime?.logger.error('Unhandled main-process rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
  }),
);

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function contentSecurityPolicy(isPackaged: boolean): string {
  const connectSource = isPackaged ? "'none'" : "'self' ws://127.0.0.1:4200 ws://localhost:4200";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSource}`,
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

function requireSafeDevelopmentUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error('ELECTRON_RENDERER_URL must be an HTTP loopback URL');
  }
  return url;
}
