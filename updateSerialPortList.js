async function updateSerialPortList() {
  if (window.port == undefined) {
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
exports.updateSerialPortList = updateSerialPortList;
