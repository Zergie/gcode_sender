// error handling
const { onerror, console_onerror } = require('./errorHandler');
window.onerror = onerror;
console.error = console_onerror;

const { SerialPort } = require('serialport')
const { ReadlineParser } = require('@serialport/parser-readline')
const { createIcons, icons } = require('lucide');
const { Chart } = require('chart.js/auto');
const { updateSerialPortList } = require("./updateSerialPortList");
const { dispatchEvent } = require('./dispatchEvent');
const autoComplete = require("@tarekraafat/autocomplete.js");
const { gcode }  = require('./gcode.js');
const storage = require('electron-json-storage');
const path = require('path');

// globals
let startup_time = Date.now();
let terminal_history = [];

// electron-reloader events
window.addEventListener('electron-reloader::before-reload', event => {
  if (window.port != undefined) {
    localStorage.setItem('persistent', JSON.stringify({
      startup : startup_time,
      serialport: {
        path: window.port.settings.path,
        baudRate: window.port.settings.baudRate,
      },
      terminal: {
        history: terminal_history,
      },
      chart: {
        datasets: {
          data: window.tempChart.data.datasets,
          hidden: window.tempChart.data.datasets.map((_, index) => index).filter(index => !window.tempChart.isDatasetVisible(index)),
        }
      }
    }));
    window.port.close();
    window.port = undefined;
  } else {
    try { localStorage.removeItem('persistent'); } catch (_) {}
  }
})
window.addEventListener('electron-reloader::after-reload', event => {
  if (localStorage.getItem('persistent')) {
    const persistent = JSON.parse(localStorage.getItem('persistent'));
    console.log(`Reloaded with ${JSON.stringify(persistent)}`);

    startup_time = persistent.startup
    connect(persistent.serialport.path, persistent.serialport.baudRate);
    terminal_history = persistent.terminal.history;

    // chart
    window.tempChart.data.datasets = persistent.chart.datasets.data;
    Array.from(persistent.chart.datasets.hidden).forEach(index => window.tempChart.setDatasetVisibility(index, false));
  } else {
    console.log('Reloaded without persistent data.');
  }
})

// serialport events
window.addEventListener('serialport:connected', _ => {
  document.getElementById('terminal').checked = true;
  storage.set('settings', { gcode_start : document.getElementById('gcode-start').value });
  window.port.write(document.getElementById('gcode-start').value + '\n');
});
window.addEventListener('serialport:data', event => {
  const data = event.detail.data;
  let should_print = true;
  let match;

  const regex = /T(?<tool>\d*):(?<temp>-?[0-9.]+)(\s*\/(?<target>[0-9.]+))?\s*(@\d?:(?<power>[0-9.]+))?/gm
  while ((match = regex.exec(data)) !== null) {
    dispatchEvent('serialport:data-temp', {
      Tool : parseInt(match.groups.tool || 0),
      Temp : parseFloat(match.groups.temp || -1),
      Target : parseFloat(match.groups.target || -1),
      Power : parseInt(match.groups.power || -1)
    });
    should_print = false;
  }
  
  // should_print = true;
  if (should_print) {
    const terminal = document.querySelector('#terminal-output').getBoundingClientRect();
    const terminal_bottom = document.querySelector('#terminal-output-bottom').getBoundingClientRect();
    const terminal_bottom_visible = terminal_bottom.y <= terminal.y + terminal.height;

    const el = document.createElement('span');
    el.className = 'terminal-command-received';
    el.innerText = data;
    document.querySelector('#terminal-output').insertBefore(el, document.querySelector('#terminal-output-bottom'));

    if (terminal_bottom_visible) {
      document.querySelector('#terminal-output-bottom').scrollIntoView();
    }
  }
});
window.addEventListener('serialport:data-temp', event => {
  function appendToChart(label, color, x, y, yAxisID) {
    if (y != -1) {
      let dataset = window.tempChart.data.datasets.find(dataset => dataset.label === label);
      if (dataset == undefined) {
        dataset = {
          label: label,
          data: [], 
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          pointStyle: false,
          fill: false,
          tension: 0.1,
          yAxisID: yAxisID,
        };
        window.tempChart.data.datasets.push(dataset);
      }
      dataset.data.push({ x: x, y: y });
  
      if (x >= window.tempChart.options.scales.x.max) {
        const diff = Math.round(window.tempChart.options.scales.x.max - window.tempChart.options.scales.x.min);
        window.tempChart.options.scales.x.min = x - diff;
        window.tempChart.options.scales.x.max = x;
      }
    }
  }

  const data = event.detail;
  const x = (Date.now() - startup_time) / 1000;
  const reds = ['#ff0000', '#ff1a1a', '#ff3333', '#ff4d4d', '#ff6666', '#ff8080', '#ff9999'];
  const redComplementary = ['#11cde9', '#1ad4e9', '#33dbe9', '#4de2e9', '#66e9e9', '#80f0e9', '#99f7e9'];
  const blues = ['#113fe9', '#1f47dc', '#2d4fcf', '#3a57c1', '#485fb4', '#5667a7', '#646f9a', '#4ca3dd', '#3cb0e6', '#2cbde0', '#1ccad9', '#0cd7d2'];

  appendToChart(
    `Temperature ${data.Tool}`,
    reds[data.Tool],
    x,
    data.Temp,
    'y'
  );

  appendToChart(
    `Target ${data.Tool}`,
    redComplementary[data.Tool],
    x,
    data.Target,
    'y'
  );

  appendToChart(
    `Power ${data.Tool}`,
    blues[data.Tool],
    x,
    data.Power,
    'y1'
  );

  window.tempChart.update();
});
window.addEventListener('serialport:disconnected', _ => {
  updateSerialPortList();
});

// ui events
function connect(port, baudRate) {
  document.getElementById('connect-button').checked = true;
  const portError = document.getElementById('port-error');
  portError.style.animation = "none";
  portError.offsetHeight;
  portError.style.animation = null;

  if (port) {
    console.log(`Connecting to port ${port} with baud rate ${baudRate}`);
    portError.style.visibility = "hidden";
    window.port = new SerialPort({ path: port, baudRate: parseInt(baudRate) });
    window.port.on('error', (error) => {
      alert(`Error: ${error.message}`);
      dispatchEvent('serialport:disconnected', {});
    });

    const parser = window.port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (data) => dispatchEvent('serialport:data', { data }));
    
    dispatchEvent('serialport:connected', {});
  } else {
    document.getElementById('port-error').style.visibility = null;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('connect-button').addEventListener('click', () => 
    connect(document.getElementById('port-select').value, document.getElementById('baud-rate').value));
  
  document.getElementById('disconnect-button').addEventListener('click', function () {
    console.log(`Disconnecting from port ${window.port.settings.path}`);
    window.port.close();
    window.port = undefined;
    dispatchEvent('serialport:disconnected', {});
  });
  
  const terminal_input = document.getElementById('terminal-input');
  let terminal_history_index = 0;
  terminal_input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();  // Prevent newline insertion
      if (terminal_input.value.length > 0) {
        const el = document.createElement('span');
        el.className = 'terminal-command-sent';
        el.innerText = terminal_input.value;
        document.querySelector('#terminal-output').insertBefore(el, document.querySelector('#terminal-output-bottom'));
        document.querySelector('#terminal-output-bottom').scrollIntoView();
        window.port.write(terminal_input.value + '\n');
        terminal_history.push(terminal_input.value);
        terminal_history_index = 0;
      }
      terminal_input.value = "";
    } else if (event.key === 'ArrowUp' && !event.shiftKey) {
      event.preventDefault();  // Prevent newline insertion
      terminal_history_index += 1;
      if (terminal_history_index > terminal_history.length) {
        terminal_history_index = terminal_history.length;
      }
      terminal_input.value = terminal_history[terminal_history.length - terminal_history_index];
      terminal_input.selectionStart = terminal_input.value.length;
    } else if (event.key === 'ArrowDown' && !event.shiftKey) {
      event.preventDefault();  // Prevent newline insertion
      terminal_history_index -= 1;
      if (terminal_history_index < 1) {
        terminal_history_index = 1;
      }
      terminal_input.value = terminal_history[terminal_history.length - terminal_history_index];
      terminal_input.selectionStart = terminal_input.value.length;
    }
  });
});

// create chart
window.addEventListener('DOMContentLoaded', () => {;
  const ctx = document.querySelector('#temp-chart canvas');
  window.tempChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [],
    },
    plugins: [{
      afterDraw: chart => {
        chart.data.datasets
          .filter((_, index) => chart.isDatasetVisible(index))
          .forEach(dataset => {
            const i = dataset.data.length - 1;
            const x = dataset.data[i].x;
            const y = dataset.data[i].y;
            
            const ctx = chart.ctx;
            const x_point = chart.scales.x.getPixelForValue(x);
            const y_point = chart.scales[dataset.yAxisID].getPixelForValue(y) - 10;
            const text = window.tempChart.options.scales[dataset.yAxisID].ticks.callback(y.toFixed(1), null, null);

            ctx.save();
            ctx.textAlign = 'center';
            ctx.font = 'bold 12px Roboto';
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 3;
            ctx.strokeText(text, x_point, y_point);
            ctx.fillStyle = dataset.borderColor;
            ctx.fillText(`${text}`, x_point, y_point);
            ctx.restore();
          });
      }
    }],
    options: {
      animation: false,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'left',
        }
      },
      scales: {
        x: {
          type: 'linear',
          position: 'bottom',
          min: 0,
          max: 300,
          ticks: {
            major: {
              enabled: true
            },
            callback: function(value, index, ticks) {
              let time = new Date(value * 1000);
              time = {
                hours: `${time.getHours()-1}`.padStart(2, "0"),
                minutes: `${time.getMinutes()}`.padStart(2, "0"),
                seconds: `${time.getSeconds()}`.padStart(2, "0"),
              }
              return `${time.hours}:${time.minutes}:${time.seconds}`;
            } 
          }
        },
        y: {
          type: 'linear',
          position: 'right',
          suggestedMin: 0,
          suggestedMax: 300,
          ticks: {
            callback: (value, index, ticks) => `${value} ºC`
          }
        },
        y1: {
          type: 'linear',
          position: 'left',
          min: 0,
          max: 255,
          ticks: {
            callback: (value, index, ticks) => `${parseFloat(value).toFixed(0)}`
          }
        }
      }
    }
  });
});

// trigger custom events
window.addEventListener('DOMContentLoaded', () => {
  if (window.port == undefined) {
    dispatchEvent('serialport:disconnected', {});
  } else {
    dispatchEvent('serialport:connected', {});
  }
});

// initialize terminal auto-complete
window.addEventListener('DOMContentLoaded', () => {
  const autoCompleteJS = new autoComplete({
      selector: "#terminal-input",
      data: {
          src: (query) => {
            if (query.includes(' ')) {
              const [command, ...args] = query.split(' ');
              const gcodeCommand = gcode.find(x => x.code.toLowerCase() === command.toLowerCase());
              
              if (gcodeCommand.parameters == undefined) {
                return []
              } else if (query.endsWith(" ")) {
                const filteredArgs = Array.from(args).map(x => x[0]).join('').toLowerCase();
                const parameter = Array.from(gcodeCommand.parameters).filter(x => !filteredArgs.includes(x.name.toLowerCase()));
                return parameter.map(x => `${query.replace(/\s+$/g, "")} ${x.name} - ${x.description}`); 
              } else {
                const filteredArgs = Array.from(args).map(x => x[0]).join('').toLowerCase().replace(/\s+(\w)/g, "$1").slice(-1);
                const parameter = Array.from(gcodeCommand.parameters).filter(x => x.name.toLowerCase() == filteredArgs);
                return parameter.map(x => `${query.replace(/\s+$/i, "")} - ${x.description}`);
              }
            } else {
              return Array.from(gcode).filter(x => {try{return x.code.toLowerCase().startsWith(query.toLowerCase())}catch{}}).map(x => `${x.code} - ${x.description}`);
            }
          },
      },
      resultItem: {
          highlight: true
      },
      events: {
          input: {
              selection: (event) => {
                  const selection = event.detail.selection.value;
                  autoCompleteJS.input.value = selection.split(" - ")[0]; 
              }
          }
      }
  });
});
// create menu
window.addEventListener('DOMContentLoaded', () => {
  let menuItems = Array.from(document.querySelectorAll('.container .text-content .text'))
  const content = document.querySelector('.container .content');
  const list = document.querySelector('.container .content .list');
  let count = 0;
  
  menuItems.forEach(item => {
    const input = document.createElement('input');
    input.setAttribute('type', 'radio');
    input.setAttribute('name', 'slider');
    input.setAttribute('id', item.classList[0]);
    if (count === 0) {
      input.setAttribute('checked', '');
    }
    content.insertBefore(input, list);
    
    count++;
  });
  menuItems.forEach(item => {
    const label = document.createElement('label');
    label.setAttribute('for', item.classList[0]);
    label.classList.add(item.classList[0]);
    const span = document.createElement('div');
    span.setAttribute('data-lucide', item.getAttribute('icon'));
    label.appendChild(span);
    list.appendChild(label);
  });

  menuItems = menuItems.map(x => x.classList[0])
  const style = document.querySelector('#style');
  style.innerHTML = `
  ${menuItems.map(x => `#${x}:checked~.list label.${x}`).join(',')}{
    color: var(--checked-color);
    background-color: var(--checked-background);
    transition: all 0.6s ease;
  }
  ${menuItems.map(x => `#${x}:checked~.text-content .${x}`).join(',')}{
    display: block;
  }
  ${menuItems.slice(1).map(x => `#${x}:checked~.text-content .${menuItems[0]}`).join(',')}{
    display: none;
  }
  `;
});
// create icons
window.addEventListener('DOMContentLoaded', () => {
  createIcons({ icons });
});
// get persistent data
window.addEventListener('DOMContentLoaded', () => {
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

  storage.setDataPath(getAppDataPath());
  storage.get('settings', (error, data) => {
    if (error) throw error;
    if (data.gcode_start != undefined) {
      document.getElementById('gcode-start').value = data.gcode_start;
    }
  });
});
// fill in the program name, version, description, and URL from package.json
window.addEventListener('DOMContentLoaded', () => {
  fetch('./package.json')
  .then(response => response.json())
  .then(package => {
    document.title = `${package.name} v${package.version}`;
    Array.from(document.querySelectorAll('.program-name')).forEach(node => node.innerText = package.name);
    Array.from(document.querySelectorAll('.program-version')).forEach(node => node.innerText = package.version);
    Array.from(document.querySelectorAll('.program-description')).forEach(node => node.innerText = package.description);
    Array.from(document.querySelectorAll('a.program-url')).forEach(node => { 
      node.innerText = package.homepage;
      node.href = package.homepage;
    });
  })
  .catch(error => console.error('Error loading package.json:', error));
});