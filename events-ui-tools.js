const { loadPersistent, savePersistent } = require('./electron-reloader.js');

window.addEventListener('electron-reloader::before-reload', event => {
    savePersistent(__filename, {
    });
});
window.addEventListener('electron-reloader::after-reload', event => {
    const data = loadPersistent(__filename);
});

document.getElementById('pid-tuning-button').addEventListener('click', event => {
    alert('PID tuning started!'); 
});

document.getElementById('pid-fine-tuning-button').addEventListener('click', event => {
    alert('PID fine tuning started!'); 
});