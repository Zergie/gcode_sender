const { ipcRenderer } = require('electron');

class Storage {
    static callbacks = {};
    static sessionData = {};

    static register(filename, options) {
        Storage.callbacks[filename] = {
            on_load: options.on_load || function (session, localData) {
                console.log('No load function provided for', filename);
            },
            on_save: options.on_save || function (callback) {
                console.log('No save function provided for', filename);
            }
        };
    }

    static save_all() {
        for (const filename in Storage.callbacks) {
            Storage.save(filename);
        }

        localStorage.setItem("session", Storage.sessionData);
        console.log("Saved session to disk:", Storage.sessionData);
    }
    static save(filename) {
        const callback = Storage.callbacks[filename];
        callback.on_save(function (session, localData) {
            Storage.sessionData[filename] = session;

            localStorage.setItem(filename, JSON.stringify(localData));
            console.log(`Saved ${filename} to disk:`, {
                session: session,
                localData: localData,
            });
        });
    }

    static load_session() {
        if (localStorage.getItem("session")) {
            Storage.sessionData = JSON.parse(localStorage.getItem("session")) || {};
        } else {
            Storage.sessionData = {};
        }
        console.log(`Loaded from sessionStorage:`, Storage.sessionData);
    }

    static load_all() {
        for (const filename in Storage.callbacks) {
            Storage.load(filename);
        }
    }

    static load(filename) {
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
}

ipcRenderer.on('before-reload', () => {
    Storage.save_all();
});

ipcRenderer.on('after-reload', () => {
    Storage.load_session();
});
exports.Storage = Storage;
/* template Storage:

const { Storage } = require('./storage.js');
Storage.register(__filename, {
    on_save: function (callback) {
        const session = {};
        const localData = {};
    
        // ...
        
        callback(session, localData);
    },
    on_load: function (session, localData) {
    },
  });

*/

exports.register = Storage.register;
/* template register:

require('./storage.js').register(__filename, {
    on_save: function (callback) {
        const session = {};
        const localData = {};
    
        // ...

        callback(session, localData);
    },
    on_load: function (session, localData) {
    },
  });

*/