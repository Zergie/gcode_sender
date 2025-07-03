const { send, print, warn, error } = require('./events-ui-settings.js');
require('./events-chart.js');
const { availableCommands } = require('./events-autocomplete.js');

let terminal_history_index = 0;
let terminal_history = [];

require('./storage.js').register(__filename, {
    on_reload: function (callback) {
        const data = {
            history: terminal_history,
            history_index: terminal_history_index,
            // simulator_button: document.getElementById('simulator-button').checked,
        };
        callback(data);
    },
    on_load: function (session, localData) {
        terminal_history = session.history || [];
        terminal_history_index = session.history_index || 0;
        // document.getElementById('simulator-button').checked = session.simulator_button || false;
    },
  });

async function builtin(command) {
    const el = document.createElement('span');
    el.className = 'terminal-command-sent';
    el.innerText = command;
    document.querySelector('#terminal-output').insertBefore(el, document.querySelector('#terminal-output-bottom'));
    document.querySelector('#terminal-output-bottom').scrollIntoView();

    switch (command) {
        case ".list":
            await availableCommands().then(array => {
                array
                    .filter(x => x.code != undefined)
                    .sort((a, b) => cmp(a.code[0], b.code[0]) || cmp(parseInt(a.code.substring(1)), parseInt(b.code.substring(1))))
                    .forEach(x => print(`${x.code} - ${x.description}`));
              });
            break;
    
        default:
            error("Invalid builtin command.");
            break;
    }
}

const terminal_input = document.getElementById('terminal-input');
terminal_input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();  // Prevent newline insertion
        if (terminal_input.value.length <= 0) {
        } else if (terminal_input.value.startsWith(".")) {
            builtin(terminal_input.value);
            terminal_history.push(terminal_input.value);
            terminal_history_index = 0;
        } else {
            send(terminal_input.value);
            terminal_history.push(terminal_input.value);
            terminal_history_index = 0;
        }
        document.querySelector('#autoComplete_list_1').hidden = true;
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