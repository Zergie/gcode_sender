// error handling
const { onerror, console_onerror } = require('./errorHandler');
window.onerror = onerror;
console.error = console_onerror;

window.addEventListener('DOMContentLoaded', () => { 
  require('./menu.js');

  require('./events-ui-settings.js');
  require('./events-ui-terminal.js');
  require('./events-ui-tools.js');

  require('./electron-json-storage.js');
});

// fill in the program name, version, description, and URL from package.json
window.addEventListener('DOMContentLoaded', () => {
  fetch('./package.json')
  .then(response => response.json())
  .then(package => {
    document.title = `${package.name.replace("_", " ")} v${package.version}`;
    Array.from(document.querySelectorAll('.program-name')).forEach(node => node.innerText = package.name.replace("_", " "));
    Array.from(document.querySelectorAll('.program-version')).forEach(node => node.innerText = package.version);
    Array.from(document.querySelectorAll('.program-description')).forEach(node => node.innerText = package.description);
    Array.from(document.querySelectorAll('a.program-url')).forEach(node => { 
      node.innerText = package.homepage;
      node.href = package.homepage;
    });
  })
  .catch(error => console.error('Error loading package.json:', error));
});