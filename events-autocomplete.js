const autoComplete = require("@tarekraafat/autocomplete.js");
const { gcode }  = require('./gcode.js');

let firmware = { name: "", version: "" };
window.addEventListener('serialport:data-firmware', event => {
  firmware = event.detail;
});

function availableCommands() {
  const [major, minor, patch] = firmware.version.split('.').map(Number);

  switch (firmware.name) {
    case 'Arduino Gcode Interpreter':
      switch (true) {
        case (major > 0 || minor >= 2):
          const regex = /^(G4|M(1|2|104|105|109|115|130|131|132|155|301|303|500|501|502|503|570|571))$/;
          return Array.from(gcode).filter(x => regex.test(x.code));
      }
  }

  return Array.from(gcode);
}

const autoCompleteJS = new autoComplete({
    selector: "#terminal-input",
    data: {
        src: (query) => {
          if (query.includes(' ')) {
            const [command, ...args] = query.split(' ');
            const gcodeCommand = availableCommands().find(x => x.code.toLowerCase() === command.toLowerCase());
            
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
            return availableCommands().filter(x => {try{return x.code.toLowerCase().startsWith(query.toLowerCase())}catch{}}).map(x => `${x.code} - ${x.description}`);
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