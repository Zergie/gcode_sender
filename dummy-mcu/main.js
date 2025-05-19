const { ipcMain, BrowserWindow } = require('electron');
const { simSpeed, simTimeWarp, ambient } = require('./simulation.js');
const Controller = require('node-pid-controller');

let temp = ambient.temperature;
let power = 0;
let M155Interval = 0;
let pidInterval = 0;
let pidController = new Controller(0.06, 0.001, 0.0, simSpeed * simTimeWarp);

ipcMain.handle('dummy-mcu:initialize', (event, data) => {
  require('./simulation.js').initialize(
    { get: () => power },
    { get: () => temp, set: (value) => { temp = value; } }
  );
  pidInterval = setInterval(function () {
    power = Math.min(255, Math.max(0, pidController.update(temp)));
  }, 100);
});

ipcMain.handle('dummy-mcu:receive', (event, data) => {
  const command = {};
  const regex = /^(?<name>[A-Z][0-9]+)|(?<key>[A-Z])(?<value>[-\d.]*)/g;
  let match;

  while ((match = regex.exec(data)) !== null) {
    if (match.groups.name) {
      command.name = match.groups.name;
    } else if (match.groups.key && match.groups.value) {
      command[match.groups.key] = match.groups.value;
    }
  }
  console.log('Received command:', command);
  switch (command.name) {
    case 'M104':
      if (command.S) {
        pidController.setTarget(parseFloat(command.S));
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('dummy-mcu:update-target', pidController.target);
        }
      }
      respond(`ok`);
      break;
    case 'M105':
      reportTemperature();
      break;
    case 'M155':
      if (command.S) {
        const interval = parseFloat(command.S);
        if (interval > 0) {
          clearInterval(M155Interval);
          M155Interval = setInterval(reportTemperature, interval * 1000);
        } else {
          clearInterval(M155Interval);
        }
      }
      break;
    case 'M115':
      respond('FIRMWARE_NAME: DummyMCU MACHINE_TYPE: DummyMCU UUID: 1234567890');
      break;
    case 'M130':
      if (command.S) { pidController.k_p = parseFloat(command.S); }
      respond('ok');
      break;
    case 'M131':
      if (command.S) { pidController.k_i = parseFloat(command.S); }
      respond('ok');
      break;
    case 'M132':
      if (command.S) { pidController.k_d = parseFloat(command.S); }
      respond('ok');
      break;
    case 'M301':
      if (command.P) { pidController.k_p = parseFloat(command.P); }
      if (command.I) { pidController.k_i = parseFloat(command.I); }
      if (command.D) { pidController.k_d = parseFloat(command.D); }
      respond('ok');
      break;
    case 'M500':
      Storage.save(__filename);
      respond('ok');
      break;
    case 'M502':
      Storage.load(__filename);
      respond('ok');
      break;
    case 'M503':
      respond(`kp: ${pidController.k_p.toFixed(3)}`);
      respond(`ki: ${pidController.k_i.toFixed(3)}`);
      respond(`kd: ${pidController.k_d.toFixed(3)}`);
      break;
    default:
      if (command.name) {
        respond(`Unknown command: ${command.name}`);
      } else {
        respond(`Unknown command: ${data}`);
      }
      break;
  }
});

ipcMain.handle('dummy-mcu:close', () => {
  clearInterval(M155Interval); M155Interval = 0;
  clearInterval(pidInterval); pidInterval = 0;
  pidController.reset();
  require('./simulation.js').stop();
});


function respond(data) {
  // console.log('Responding:', data);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('dummy-mcu:respond', data);
  }
}

function reportTemperature(tool = 0, temperature = 0.0) {
  if (tool == 0) {
    respond(`T0:${temp.toFixed(2)} /${pidController.target.toFixed(0)} @0:${power.toFixed(0)}`);
  } else {
    respond(`T${tool}:${temperature.toFixed(2)}`);
  }
}