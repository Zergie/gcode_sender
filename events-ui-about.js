const { shell } = require('electron');

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
      node.addEventListener('click', event => {
        event.preventDefault();
        shell.openExternal(package.homepage);  
      });
    });
  })
  .catch(error => console.error('Error loading package.json:', error));
