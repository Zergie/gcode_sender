// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.
window.addEventListener('DOMContentLoaded', () => {
    fetch('./package.json')
    .then(response => response.json())
    .then(package => {
      document.title = `${package.name} v${package.version}`;
      Array.from(document.querySelectorAll('.program-name')).forEach(node => node.innerText = package.name);
      Array.from(document.querySelectorAll('.program-version')).forEach(node => node.innerText = package.version);
      Array.from(document.querySelectorAll('.program-description')).forEach(node => node.innerText = package.description);
      Array.from(document.querySelectorAll('a.program-url')).forEach(node => { 
        node.innerText = package.homepage;
        node.href = package.homepage;
      });
    })
    .catch(error => console.error('Error loading package.json:', error));
})