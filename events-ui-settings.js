const { SerialPort, ReadlineParser } = require('serialport');
const { dispatchEvent } = require('./dispatchEvent.js');
let terminal_send_buffer = [];

const { Storage } = require('./storage.js');
Storage.register(__filename, {
  on_reload: function (callback) {
    const data = {
      gcode_start: document.getElementById('gcode-start').value,
    };
    if (window.port) {
      data.serialport = window.port.settings.path;
      data.baudRate = window.port.settings.baudRate;
      window.port.close();
      window.port = undefined;
    }
    callback(data);
  },
  on_save: function (callback) {
    const data = {
      gcode_start: document.getElementById('gcode-start').value,
    };
    callback(data);
  },
  on_load: function (session, localData) {
    document.getElementById('gcode-start').value = session.gcode_start || '';

    if (session.serialport) {
      connect(session.serialport, session.baudRate);
    }
  },
});

window.addEventListener('serialport:connected', _ => {
  document.getElementById('terminal').checked = true;
  Storage.save(__filename);
  terminal_send_buffer = Array.from(document.getElementById('gcode-start').value.split('\n').filter(line => line.trim() !== ''));
  if (terminal_send_buffer.length > 0) {
    send(terminal_send_buffer.shift());
  }
});
window.addEventListener('serialport:data', event => {
  const data = event.detail.data;
  let should_print = true;
  
  let match;
  let regex = /T(?<tool>\d*):(?<temp>-?[0-9.]+)(\s*\/(?<target>[0-9.]+))?\s*(@\d?:(?<power>[0-9.]+))?/gm;
  while ((match = regex.exec(data)) !== null) {
    dispatchEvent('serialport:data-temp', {
      Tool: parseInt(match.groups.tool || 0),
      Temp: parseFloat(match.groups.temp || -1),
      Target: parseFloat(match.groups.target || -1),
      Power: parseInt(match.groups.power || -1)
    });
    should_print = false;
  }

  if (data.includes('FIRMWARE_NAME:')) {
    const firmware = {};
    const regexFirmware = /\b([A-Z_]+):((?:(?!\b[A-Z_]+:).)+)/gm;
    while ((match = regexFirmware.exec(data)) !== null) {
      firmware[match[1]] = match[2].trim();
    }

    document.title = document.title.includes(' - ') ? document.title.split(' - ')[0] : document.title;
    if (firmware.MACHINE_TYPE && firmware.UUID) {
        document.title = `${document.title} - ${firmware.MACHINE_TYPE} (${firmware.UUID})`;
    }
    dispatchEvent('serialport:data-firmware', firmware);
  }

  if (should_print) {
    print(data);
  }

  if (terminal_send_buffer.length > 0) {
    send(terminal_send_buffer.shift());
  }
});
window.addEventListener('serialport:disconnected', _ => {
  updateSerialPortList();
  document.title = document.title.split(' - ')[0];
});

function print(data, color=undefined) {
  const terminal = document.querySelector('#terminal-output').getBoundingClientRect();
  const terminal_bottom = document.querySelector('#terminal-output-bottom').getBoundingClientRect();
  const terminal_bottom_visible = terminal_bottom.y <= terminal.y + terminal.height;

  const el = document.createElement('span');
  el.className = 'terminal-command-received';
  if (color) {
    el.style.color = color;
  }
  el.innerText = data;
  document.querySelector('#terminal-output').insertBefore(el, document.querySelector('#terminal-output-bottom'));

  if (terminal_bottom_visible) {
    document.querySelector('#terminal-output-bottom').scrollIntoView();
  }
}

function connect(port, baudRate) {
  document.getElementById('connect-button').checked = true;
  const portError = document.getElementById('port-error');
  portError.style.animation = "none";
  portError.offsetHeight;
  portError.style.animation = null;

  if (port) {
    console.log(`Connecting to port ${port} with baud rate ${baudRate}`);
    portError.style.visibility = "hidden";

    if (port === 'dummy-mcu') {
      window.port = require('./dummy-mcu.js');
      window.port.initSimulation();
    } else {
      window.port = new SerialPort({ path: port, baudRate: parseInt(baudRate) });
      window.port.on('error', (error) => {
        alert(`Error: ${error.message}`);
        dispatchEvent('serialport:disconnected', {});
      });
      const parser = window.port.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', (data) => dispatchEvent('serialport:data', { data }));
    }

    dispatchEvent('serialport:connected', {});
  } else {
    document.getElementById('port-error').style.visibility = null;
  }
}

function send (gcode, silent = false) {
  if (!silent) {
    const el = document.createElement('span');
    el.className = 'terminal-command-sent';
    el.innerText = gcode;
    document.querySelector('#terminal-output').insertBefore(el, document.querySelector('#terminal-output-bottom'));
    document.querySelector('#terminal-output-bottom').scrollIntoView();
  }
  if (window.port) {
    window.port.write(gcode + '\n');
  } else {
    console.error('not connected!');
  }
}
exports.send = send;
exports.print = function(data) { print(`// ${data}`, 'var(--print-text-color)'); };
exports.warn = function(data) { print(`// ${data}`, 'var(--warn-text-color)'); };
exports.error = function(data) { print(`// ${data}`, 'var(--error-text-color)'); };

async function updateSerialPortList() {
  if (window.port == undefined) {
    try {
      const ports = await SerialPort.list();
      ports.push({ path: 'dummy-mcu' });
      const portSelect = document.getElementById('port-select');
      const existingPorts = Array.from(portSelect.options).map(option => option.value);

      ports.forEach(port => {
        if (!existingPorts.includes(port.path)) {
          const option = document.createElement('option');
          option.value = port.path;
          option.textContent = port.path;
          portSelect.appendChild(option);
        }
      });

      if (portSelect.options.length > 0 && portSelect.selectedIndex === -1) {
        portSelect.selectedIndex = 0;
      }
    } catch (error) {
      console.error('Error listing serial ports:', error);
    }

    setTimeout(updateSerialPortList, 2000);
  }
}

document.getElementById('connect-button').addEventListener('click', event => {
  Storage.save(__filename);
  connect(document.getElementById('port-select').value, document.getElementById('baud-rate').value)
});

document.getElementById('disconnect-button').addEventListener('click', event => {
  console.log(`Disconnecting from port ${window.port.settings.path}`);
  window.port.close();
  window.port = undefined;
  dispatchEvent('serialport:disconnected', {});
});

// trigger custom events
if (window.port == undefined) {
  dispatchEvent('serialport:disconnected', {});
} else {
  dispatchEvent('serialport:connected', {});
}