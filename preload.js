// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.
const { SerialPort } = require('serialport')
const { ReadlineParser } = require('@serialport/parser-readline')
const { createIcons, icons } = require('lucide');
const { Chart } = require('chart.js/auto');
const { updateSerialPortList } = require("./updateSerialPortList");
const { dispatchEvent } = require('./dispatchEvent');
const { onerror, console_onerror } = require('./errorHandler');

// globals
let startup_time = Date.now();
let terminal_history = [];

// error handling
window.onerror = onerror;
console.error = console_onerror;

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
        temp: window.tempChart.data.datasets,
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
    window.tempChart.data.datasets = persistent.chart.temp;
  } else {
    console.log('Reloaded without persistent data.');
  }
})

// serialport events
window.addEventListener('serialport:connected', _ => {
  document.getElementById('connect-button').style.visibility = "hidden";
  document.getElementById('disconnect-button').style.visibility = null;
  document.getElementById('port-select').disabled = true;
  document.getElementById('baud-rate').disabled = true;
  document.getElementById('terminal').checked = true;
});
window.addEventListener('serialport:data', event => {
  const data = event.detail.data;
  let should_print = true;
  let match;

  const regex = /T(?<tool>\d*):(?<temp>[0-9.]+)\s*\/(?<target>[0-9.]+)\s*(@\d?:(?<power>[0-9.]+))?/gm
  while ((match = regex.exec(data)) !== null) {
    dispatchEvent('serialport:data-temp', {
      Tool : parseInt(match.groups.tool || 0),
      Temp : parseFloat(match.groups.temp || -1),
      Target : parseFloat(match.groups.target || -1),
      Power : parseInt(match.groups.power || -1)
    });
    should_print = false;
  }
  
  if (should_print) {
    const terminal = document.querySelector('#terminal-output').getBoundingClientRect();
    const terminal_bottom = document.querySelector('#terminal-output-bottom').getBoundingClientRect();
    const terminal_bottom_visible = terminal_bottom.y <= terminal.y + terminal.height;

    document.querySelector('#terminal-output pre').innerText += data + '\n';
    
    if (terminal_bottom_visible) {
      document.querySelector('#terminal-output-bottom').scrollIntoView();
    }
  }
});

function appendToChart(label, color, x, y, yAxisID) {
  if (y != -1) {
    let dataset = window.tempChart.data.datasets.find(dataset => dataset.label === label);
    if (dataset == undefined) {
      dataset = {
        label: label,
        data: [], 
        borderColor: color,
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
window.addEventListener('serialport:data-temp', event => {
  const data = event.detail;
  const x = (Date.now() - startup_time) / 1000;

  appendToChart(
    `Temperature ${data.Tool}`,
    `hsl(${(data.Tool - 1) * 30}, 100%, 50%)`,
    x,
    data.Temp,
    'y'
  );

  appendToChart(
    `Power ${data.Tool}`,
    `hsl(210, 100%, ${(data.Tool - 1) * 50 / 16 + 50}%)`,
    x,
    data.Power,
    'y1'
  );

  window.tempChart.update();
});
window.addEventListener('serialport:disconnected', _ => {
  document.getElementById('connect-button').style.visibility = null;
  document.getElementById('disconnect-button').style.visibility = "hidden";
  document.getElementById('port-select').disabled = false;
  document.getElementById('baud-rate').disabled = false;
  updateSerialPortList();
});

// ui events
function connect(port, baudRate) {
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
        document.querySelector('#terminal-output pre').innerText += '> ' + terminal_input.value + '\n';
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

// initialize chart
window.addEventListener('DOMContentLoaded', () => {
  const ctx = document.querySelector('#temp-chart canvas');
  window.tempChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        }
      },
      scales: {
        x: {
          type: 'linear',
          position: 'bottom',
          // display: false,
          min: 0,
          max: 120,
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
          position: 'left',
          suggestedMin: 0,
          suggestedMax: 50,
          ticks: {
            callback: (value, index, ticks) => `${value} ºC`
          }
        },
        y1: {
          type: 'linear',
          position: 'right',
          // display: false,
          min: 0,
          max: 255,
          ticks: {
            callback: (value, index, ticks) => `${value}`
          }
        }
      }
    }
  });

  // if (localStorage.getItem('persistent')) {
  //   const persistent = JSON.parse(localStorage.getItem('persistent'));
  //   window.tempChart.dataset = persistent.chart.temp;
  // }
});

// trigger custom events
window.addEventListener('DOMContentLoaded', () => {
  if (window.port == undefined) {
    dispatchEvent('serialport:disconnected', {});
  } else {
    dispatchEvent('serialport:connected', {});
  }
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
  createIcons({ icons });
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