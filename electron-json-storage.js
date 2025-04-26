const { dispatchEvent } = require('./dispatchEvent.js');
const storage = require('electron-json-storage');
const path = require('path');

function getAppDataPath() {
    switch (process.platform) {
        case "darwin": {
        return path.join(process.env.HOME, "Library", "Application Support", "gcode-sender");
        }
        case "win32": {
        return path.join(process.env.APPDATA, "gcode-sender");
        }
        case "linux": {
        return path.join(process.env.HOME, ".gcode-sender");
        }
        default: {
        console.log("Unsupported platform!");
        process.exit(1);
        }
    }
} 

window.addEventListener('electron-json-storage::save', event => {
    const filename = event.detail.filename;
    dispatchEvent('electron-json-storage::before-save', {
        callback: (data) => storage.set(filename, data),
    });
});

console.log("App data path: ", getAppDataPath());
storage.setDataPath(getAppDataPath());
dispatchEvent('electron-json-storage::after-load', {
    storage: storage,
});