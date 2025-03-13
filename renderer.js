const { SerialPort } = require('serialport')
const { ReadlineParser } = require('@serialport/parser-readline')
const { createIcons, icons } = require('lucide');
const { Chart } = require('chart.js/auto');
const { updateSerialPortList } = require("./updateSerialPortList");

function dispatchEvent(event, detail) {
  document.dispatchEvent(new CustomEvent(event, {
    bubbles: true,
    cancelable: false,
    detail: detail
  }));
}

document.addEventListener('serialport:connected', _ => {
  document.getElementById('connect-button').style.visibility = "hidden";
  document.getElementById('disconnect-button').style.visibility = null;
  document.getElementById('port-select').disabled = true;
  document.getElementById('baud-rate').disabled = true;
  document.getElementById('terminal').checked = true;
});

document.addEventListener('serialport:data', event => {
  const data = event.detail.data;
  
  const regex = /T(?<tool>\d*):(?<temp>[0-9.]+)\s*\/(?<target>[0-9.]+)\s*(@\d?:(?<power>[0-9.]+))?/gm
  let match;
  while ((match = regex.exec(data)) !== null) {
    dispatchEvent('serialport:data-temp', {
      Tool : parseInt(match.groups.tool || 0),
      Temp : parseFloat(match.groups.temp),
      Target : parseFloat(match.groups.target),
      Power : parseInt(match.groups.power || 0)
    });
  }
  
  document.querySelector('#terminal-output pre').innerText += data;
});

document.addEventListener('serialport:data-temp', event => {
  const data = event.detail;
  console.log(`Received data-temp: ${JSON.stringify(data)}`);
  window.tempChart.data.datasets[0].data.push({
    x: window.tempChart.data.datasets[0].data.length,
    y: data.Temp
  });
  window.tempChart.update();
});

document.addEventListener('serialport:disconnected', _ => {
  document.getElementById('connect-button').style.visibility = null;
  document.getElementById('disconnect-button').style.visibility = "hidden";
  document.getElementById('port-select').disabled = false;
  document.getElementById('baud-rate').disabled = false;
  updateSerialPortList();
});

document.getElementById('connect-button').addEventListener('click', function () {
  document.getElementById('port-error').style.animation = "none";
  document.getElementById('port-error').offsetHeight;
  document.getElementById('port-error').style.animation = null;
  const port = document.getElementById('port-select').value;
  const baudRate = document.getElementById('baud-rate').value;
  if (port) {
    console.log(`Connecting to port ${port} with baud rate ${baudRate}`);
    document.getElementById('port-error').style.visibility = "hidden";
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
});

document.getElementById('disconnect-button').addEventListener('click', function () {
  console.log(`Disconnecting from port ${window.port.settings.path}`);
  window.port.close();
  window.port = undefined;
  dispatchEvent('serialport:disconnected', {});
});
  
const terminal_input = document.getElementById('terminal-input');
terminal_input.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();  // Prevent newline insertion
      if (terminal_input.value.length > 0) {
        document.querySelector('#terminal-output pre').innerText += '\n> ' + terminal_input.value + '\n';
        window.port.write(terminal_input.value + '\n');
      }
      terminal_input.value = "";
    }
});


function setup() {
  var menuItems = Array.from(document.querySelectorAll('.container .text-content .text'))
  const content = document.querySelector('.container .content');
  const list = document.querySelector('.container .content .list');
  var count = 0;
  
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

  const ctx = document.querySelector('#temp-chart canvas');
  window.tempChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Temperature',
        data: [],
        borderColor: 'rgb(255, 99, 132)',
        tension: 0.1
      }],
    },
    options: {
      animation: false,
      scales: {
        x: {
          type: 'linear',
          position: 'bottom',
          suggestedMin: 0,
          suggestedMax: 100
        },
        y: {
          type: 'linear',
          position: 'left',
          suggestedMin: 0,
          suggestedMax: 50
        }
      }
    }
  });


  if (window.port == undefined) {
    dispatchEvent('serialport:disconnected', {});
  } else {
    dispatchEvent('serialport:connected', {});
  }   
}

setup();