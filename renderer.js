const { SerialPort } = require('serialport')
const { ReadlineParser } = require('@serialport/parser-readline')
const { RegexParser } = require('@serialport/parser-regex')
const { createIcons, icons } = require('lucide');


document.addEventListener('connected', _ => {
  document.getElementById('connect-button').style.visibility = "hidden";
  document.getElementById('disconnect-button').style.visibility = "";
  document.getElementById('port-select').disabled = true;
  document.getElementById('baud-rate').disabled = true;
});
document.addEventListener('data', event => {
  var data = event.detail.data;
  console.log(`Received data: ${data}`);
});
document.addEventListener('data-temp', event => {
  var data = event.detail.data;
  console.log(`Received data-temp: ${data}`);
  const regex = /T(?<tool>\d*):(?<temp>[0-9.]+)\s*\/(?<target>[0-9.]+)\s*(@\d?:(?<power>[0-9.]+))?/gm
  let match;
  while ((match = regex.exec(data)) !== null) {
    console.log(`Tool: ${match.groups.tool || 0}, Temp: ${match.groups.temp}, Target: ${match.groups.target}, Power: ${match.groups.power}`);
  }
});
document.addEventListener('disconnected', _ => {
  document.getElementById('connect-button').style.visibility = "";
  document.getElementById('disconnect-button').style.visibility = "hidden";
  document.getElementById('port-select').disabled = false;
  document.getElementById('baud-rate').disabled = false;
  updateSerialPortList();
});


async function updateSerialPortList() {
  if (!window.isConnected) {
    try {
      const ports = await SerialPort.list();
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

function sendMessage() {
  const message = sendMessageBox.value.trim();
  if (message !== "") {
    // TODO: Send the message to the appropriate destination here
    receivedMessageBox.value += message + '\n';
    sendMessageBox.value = "";  // Clear the textbox after sending
    receivedMessageBox.scrollTop = receivedMessageBox.scrollHeight;  // Scroll to the end
  }
}

function dispatchEvent(event, detail) {
  document.dispatchEvent(new CustomEvent(event,{
    bubbles: true,
    cancelable: false,
    detail: detail
  }));
}

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

  document.getElementById('connect-button').addEventListener('click', function () {
    const port = document.getElementById('port-select').value;
    const baudRate = document.getElementById('baud-rate').value;
    if (port) {
      console.log(`Connecting to port ${port} with baud rate ${baudRate}`);
      document.getElementById('port-error').style.visibility = "hidden";
      window.port = new SerialPort({ path: port, baudRate: parseInt(baudRate) });
      
      const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
      parser.on('data', (data) => dispatchEvent('data', { data }));
      
      const tempParser = port.pipe(new RegexParser({ regex: /T:\d+ /gm }))
      tempParser.on('data', (data) => dispatchEvent('data-temp', { data }));
      
      window.isConnected = true;
      dispatchEvent('connected', {});
    } else {
      document.getElementById('port-error').style.visibility = "";
    }
  });
  document.getElementById('disconnect-button').addEventListener('click', function () {
    console.log(`Disconnecting from port ${window.port}`);
    window.port = null;
    window.isConnected = false;
    dispatchEvent('disconnected', {});
  });
  dispatchEvent('disconnected', {});
  
  // const sendButton = document.getElementById('send-button');
  // const sendMessageBox = document.getElementById('send-message');
  // const receivedMessageBox = document.getElementById('received-messages');
  
  // sendButton.addEventListener('click', sendMessage);
  
  // sendMessageBox.addEventListener('keydown', function (event) {
    //   if (event.key === 'Enter' && !event.shiftKey) {
      //     event.preventDefault();  // Prevent newline insertion
      //     sendMessage();
      //   }
      // });
      
    }
    
setup();