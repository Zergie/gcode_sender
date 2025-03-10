// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

const { SerialPort } = require('serialport')
const tableify = require('tableify')

async function listSerialPorts() {
  await SerialPort.list().then((ports, err) => {
    if(err) {
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

const sendButton = document.getElementById('send-button');
const sendMessageBox = document.getElementById('send-message');
const receivedMessageBox = document.getElementById('received-messages');

function sendMessage() {
    const message = sendMessageBox.value.trim();
    if (message !== "") {
      // TODO: Send the message to the appropriate destination here
      receivedMessageBox.value += message + '\n';
      sendMessageBox.value = "";  // Clear the textbox after sending
      receivedMessageBox.scrollTop = receivedMessageBox.scrollHeight;  // Scroll to the end
    }
}

sendButton.addEventListener('click', sendMessage);

sendMessageBox.addEventListener('keydown', function(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();  // Prevent newline insertion
        sendMessage();
    }
});

listPorts();
