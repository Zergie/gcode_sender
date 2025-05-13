const { ipcRenderer } = require('electron');
const { dispatchEvent } = require('./dispatchEvent');
const { Storage } = require('./storage.js');

Storage.register(__filename, {
  on_reload: function (callback) {
    const data = {
      temp: temp,
      target: target,
      power: power,
    };
    callback(data);
  },
  on_save: function (callback) {
    const data = {
      kp: kp,
      ki: ki,
      kd: kd,
    };
    callback(data);
  },
  on_load: function (session, localData) {
    temp = parseFloat(session.temp) || 22.0;
    target = parseFloat(session.target) || 0.0;
    power = parseFloat(session.power) || 0.0;
    kp = parseFloat(session.kp) || 2.0;
    ki = parseFloat(session.ki) || 0.1;
    kd = parseFloat(session.kd) || 0.5;
  },
});

exports.initialize = function () {
  ipcRenderer.invoke('dummy-mcu:initialize');
  require('./dummy-mcu/simulation-view.js').initialize();
};
exports.write = (data) => ipcRenderer.invoke('dummy-mcu:receive', data);
exports.close = () => ipcRenderer.invoke('dummy-mcu:close');
exports.settings = {
  path: 'dummy-mcu',
  baudRate: 115200,
};

ipcRenderer.on('dummy-mcu:respond', (event, data) => {
  dispatchEvent('serialport:data', { data: data, });
});