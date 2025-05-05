const { ipcRenderer } = require('electron');

class Storage {
    static callbacks = {};
    static sessionData = {};

    static register(filename, options) {
        Storage.callbacks[filename] = {
            on_save: options.on_save || function (callback) {
                console.log('No save function provided for', filename);
            },
            on_load: options.on_load || function (session, localData) {
                console.log('No load function provided for', filename);
            },
            on_reload: options.on_reload || function (callback) {
                console.log('No reload function provided for', filename)
            }
        };
    }

    static save(filename) {
        try {
            const callback = Storage.callbacks[filename];
            callback.on_save(function (localData) {
                localStorage.setItem(filename, JSON.stringify(localData));
                console.log(`Saved ${filename} to disk:`, localData);
            });
        }
        catch (e) {
            console.log(e);
        }
    }

    static save_session() {
        try {
            for (const filename in Storage.callbacks) {
                const callback = Storage.callbacks[filename];
                callback.on_reload(function (session, localData) {
                    Storage.sessionData[filename] = session;
                });
            }
            localStorage.setItem("session", JSON.stringify(Storage.sessionData));
            console.log("Saved session to disk:", Storage.sessionData);
        }
        catch (e) {
            console.log(e);
        }
    }

    static load_all() {
        try {
            if (localStorage.getItem("session")) {
                Storage.sessionData = JSON.parse(localStorage.getItem("session")) || {};
            } else {
                Storage.sessionData = {};
            }
            console.log(`Loaded from sessionStorage:`, Storage.sessionData);
            localStorage.setItem("session", JSON.stringify({}));
        }
        catch (e) {
            console.log(e);
            Storage.sessionData = {};
        }

        for (const filename in Storage.callbacks) {
            Storage.load(filename);
        }
    }

    static load(filename) {
        try {
            const callback = Storage.callbacks[filename];

            const session = Storage.sessionData[filename] || {};

            let localData = {};
            if (localStorage.getItem(filename)) {
                localData = JSON.parse(localStorage.getItem(filename));
            }
            console.log(`Loaded ${filename} from disk:`, {
                session: session,
                localData: localData,
            });

            callback.on_load(session, localData);
        }
        catch (e) {
            console.log(e);
        }
    }
}

ipcRenderer.on('before-reload', () => {
    Storage.save_session();
});

ipcRenderer.on('after-reload', () => {
});

exports.Storage = Storage;
/* template Storage:

const { Storage } = require('./storage.js');
Storage.register(__filename, {
    on_reload: function (callback) {
        const data = {};
        callback(data);
    },
    on_save: function (callback) {
        const data = {};
        callback(data);
    },
    on_load: function (session, localData) {
    },
  });

*/

exports.register = Storage.register;
/* template register:

require('./storage.js').register(__filename, {
    on_reload: function (callback) {
        const data = {};
        callback(data);
    },
    on_save: function (callback) {
        const data = {};
        callback(data);
    },
    on_load: function (session, localData) {
    },
  });

*/