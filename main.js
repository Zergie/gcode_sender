const { app, BrowserWindow } = require('electron')
const path = require('path')
const url = require('url')

try {
    require('./my-electron-reloader')(module);
} catch (_) {}

const log = require('electron-log/main');
log.transports.file.level = 'info';
log.transports.file.resolvePathFn = () => __dirname + "/app.log";
log.initialize();


// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow

function createWindow() {
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        backgroundColor: "#ccc",
        webPreferences: {
            nodeIntegration: true, // to allow require
            contextIsolation: true,
            // contextIsolation: false, // allow use with Electron 12+
            preload: path.join(__dirname, 'preload.js')
        },
        icon:'images/icon.ico'
    })

    mainWindow.removeMenu()
    mainWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'index.html'),
        protocol: 'file:',
        slashes: true
    }))

    // Open the DevTools.
    // mainWindow.webContents.openDevTools()

    // Emitted when the window is closed.
    mainWindow.on('closed', function() {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        mainWindow = null
    })

    mainWindow.webContents.on('before-input-event', (_, input) => {
        if (input.type === 'keyDown' && input.key === 'F12') {
            mainWindow.webContents.isDevToolsOpened()
            ? mainWindow.webContents.closeDevTools()
            : mainWindow.webContents.openDevTools({ mode: 'right' });
        }
    });

    mainWindow.webContents.on("console-message", (ev) => {
        switch (ev.level) 
        {
            case 0:
                log.debug(`${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
                break;
            case 1:
                log.info(`${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
                break;
            case 2:
                log.warn(`${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
                break;
            case 3:
                log.error(`${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
                break;
        }
    });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow)

// Quit when all windows are closed.
app.on('window-all-closed', function() {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    app.quit()
})

app.on('activate', function() {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) {
        createWindow()
    }
})
