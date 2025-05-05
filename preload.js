// error handling
const { onerror, console_onerror } = require('./errorHandler');
window.onerror = onerror;
console.error = console_onerror;

const { Storage } = require('./storage.js');
window.addEventListener('DOMContentLoaded', () => { 
  require('./menu.js');

  require('./events-ui-settings.js');
  require('./events-ui-terminal.js');
  require('./events-ui-tools.js');
  require('./events-ui-about.js');

  Storage.load_all();
});