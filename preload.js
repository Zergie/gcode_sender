// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.
window.addEventListener('DOMContentLoaded', () => {
    fetch('./package.json')
    .then(response => response.json())
    .then(package => {
      document.title = `${package.name} v${package.version}`;
      document.querySelector('.topic').innerText = document.title;
    })
    .catch(error => console.error('Error loading package.json:', error));
})