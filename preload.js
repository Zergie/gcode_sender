// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.
window.addEventListener('DOMContentLoaded', () => {
    fetch('./package.json')
    .then(response => response.json())
    .then(package => {
      document.title = `${package.name} v${package.version}`;
      document.getElementById('title').innerText = document.title;
    })
    .catch(error => console.error('Error loading package.json:', error));
})