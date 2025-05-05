const { send } = require('./events-ui-settings.js');
require('./events-chart.js');
require('./events-autocomplete.js');

let terminal_history_index = 0;
let terminal_history = [];

require('./storage.js').register(__filename, {
    on_save: function (callback) {
        const session = {
            history: terminal_history,
            history_index: terminal_history_index,
        };
        const localData = {};

        callback(session, localData);
    },
    on_load: function (session, localData) {
        terminal_history = session.history || [];
        terminal_history_index = session.history_index || 0;
    },
  });

const terminal_input = document.getElementById('terminal-input');
terminal_input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();  // Prevent newline insertion
        if (terminal_input.value.length > 0) {
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