const autoComplete = require("@tarekraafat/autocomplete.js");
const { gcode } = require('./gcode.js');

let firmware = {
  FIRMWARE_NAME: "",
  G_CODE_URL: "",
};
window.addEventListener('serialport:data-firmware', event => {
  firmware = event.detail;
});

require('./storage.js').register(__filename, {
  on_reload: function (callback) {
      callback(firmware);
  },
  // on_save: function (callback) {
  //     const data = {};
  //     callback(data);
  // },
  on_load: function (session, localData) {
    if (session.firmware) {
      firmware = session.firmware;
    }
  },
});

function availableCommands() {
  if (firmware.gcode) {
    return Promise.resolve(firmware.gcode);
  }
  if (firmware.G_CODE_URL) {
    return fetch(firmware.G_CODE_URL)
      .then(response => response.json())
      .then(data => {
        firmware.gcode = data;
        return firmware.gcode;
      })
      .catch(error => {
        console.error("Error fetching G-code commands:", error);
        return Promise.resolve(Array.from(gcode || []));
      });
  }
  return Promise.resolve(Array.from(gcode));
}

const autoCompleteJS = new autoComplete({
  selector: "#terminal-input",
  data: {
    src: async (query) => {
      if (query.includes(' ')) {
        const [command, ...args] = query.split(' ');
        const gcodeCommand = await availableCommands().then(array => {
          const result = Array.from(array).find(x => x.code.toLowerCase() === command.toLowerCase());
          return result;
        });
        
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
        return availableCommands().then(commands => 
          commands.filter(x => { 
            try { 
              return x.code.toLowerCase().startsWith(query.toLowerCase()); 
            } catch { } 
          }).map(x => `${x.code} - ${x.description}`)
        );
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