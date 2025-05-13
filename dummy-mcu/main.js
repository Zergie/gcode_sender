const { ipcMain, BrowserWindow } = require('electron');

let temp = 22;
let target = 0;
let power = 0;
let kp = 2.0;
let ki = 0.1;
let kd = 0.5;
let M155Interval = 0;

ipcMain.handle('dummy-mcu:initialize', (event, data) => {
  require('./pid.js').initialize(
    { get: () => { return { temp, target, kp, ki, kd }; } },
    { get: () => power, set: (value) => { power = value; } }
  );
  require('./simulation.js').initialize(
    { get: () => power },
    { get: () => temp, set: (value) => { temp = value; } }
  );
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
        target = parseFloat(command.S);
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('dummy-mcu:update-target', target);
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
      if (command.S) { kp = parseFloat(command.S); }
      respond('ok');
      break;
    case 'M131':
      if (command.S) { ki = parseFloat(command.S); }
      respond('ok');
      break;
    case 'M132':
      if (command.S) { kd = parseFloat(command.S); }
      respond('ok');
      break;
    case 'M301':
      if (command.P) { kp = parseFloat(command.P); }
      if (command.I) { ki = parseFloat(command.I); }
      if (command.D) { kd = parseFloat(command.D); }
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
      respond(`kp: ${kp.toFixed(2)}`);
      respond(`ki: ${ki.toFixed(2)}`);
      respond(`kd: ${kd.toFixed(2)}`);
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
  clearInterval(M155Interval);
  M155Interval = 0;
});


function respond(data) {
  // console.log('Responding:', data);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('dummy-mcu:respond', data);
  }
}

function reportTemperature(tool = 0, temperature = 0.0) {
  if (tool == 0) {
    respond(`T0:${temp.toFixed(2)} /${target.toFixed(0)} @0:${power.toFixed(0)}`);
  } else {
    respond(`T${tool}:${temperature.toFixed(2)}`);
  }
}