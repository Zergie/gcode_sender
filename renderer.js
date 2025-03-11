// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

const { SerialPort } = require('serialport')
const tableify = require('tableify')

async function listSerialPorts() {
  await SerialPort.list().then((ports, err) => {
    if (err) {
      document.getElementById('error').textContent = err.message
      return
    } else {
      document.getElementById('error').textContent = ''
    }

    if (ports.length === 0) {
      document.getElementById('error').textContent = 'No ports discovered'
    }

    tableHTML = tableify(ports)
    document.getElementById('ports').innerHTML = tableHTML
  })
}

function listPorts() {
  listSerialPorts();
  // Set a timeout that will check for new serialPorts every 2 seconds.
  // This timeout reschedules itself.
  setTimeout(listPorts, 2000);
}

function capitalize(val) {
  return String(val).charAt(0).toUpperCase() + String(val).slice(1);
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

function setup() {
  const menuItems = Array.from(document.querySelectorAll('.container .text-content .text')).map(x => x.classList[0])
  const content = document.querySelector('.container .content');
  const list = document.querySelector('.container .content .list');
  var count = 0;
  
  menuItems.forEach(item => {
    const input = document.createElement('input');
    input.setAttribute('type', 'radio');
    input.setAttribute('name', 'slider');
    input.setAttribute('id', item);
    if (count === 0) {
      input.setAttribute('checked', '');
    }
    content.insertBefore(input, list);
    
    count++;
  });
  menuItems.forEach(item => {
    const label = document.createElement('label');
    label.setAttribute('for', item);
    label.classList.add(item);
    const span = document.createElement('span');
    span.textContent = capitalize(item);
    label.appendChild(span);
    list.appendChild(label);
  });

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
