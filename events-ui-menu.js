const { createIcons, icons } = require('lucide');

let menuItems = Array.from(document.querySelectorAll('.container .text-content .text'))
const content = document.querySelector('.container .content');
const list = document.querySelector('.container .content .list');
let count = 0;

require('./storage.js').register(__filename, {
    on_reload: function (callback) {
        const data = {
            menuItems: {}
        };
        Array.from(document.querySelectorAll("*[name=slider]"))
            .forEach(x => data.menuItems[x.id] = x.checked);
        callback(data);
    },
    // on_save: function (callback) {
    //     const data = {};
    //     callback(data);
    // },
    on_load: function (session, localData) {
        for (const key in session.menuItems) {
            const element = document.getElementById(key);
            if (element) {
                element.checked = session.menuItems[key];
            }
        }
    },
  });

menuItems.forEach(item => {
    const input = document.createElement('input');
    input.setAttribute('type', 'radio');
    input.setAttribute('name', 'slider');
    input.setAttribute('id', item.classList[0]);
    if (count === 0) {
        input.setAttribute('checked', '');
    }
    content.insertBefore(input, list);

    count++;
});
menuItems.forEach(item => {
    const label = document.createElement('label');
    label.setAttribute('for', item.classList[0]);
    label.classList.add(item.classList[0]);
    const span = document.createElement('div');
    span.setAttribute('data-lucide', item.getAttribute('icon'));
    label.appendChild(span);
    list.appendChild(label);
});

menuItems = menuItems.map(x => x.classList[0])
const style = document.querySelector('#style');
style.innerHTML = `
${menuItems.map(x => `#${x}:checked~.list label.${x}`).join(',')}{
color: var(--checked-color);
background-color: var(--checked-background);
transition: all 0.6s ease;
}
${menuItems.map(x => `#${x}:checked~.text-content .${x}`).join(',')}{
display: block;
}
${menuItems.slice(1).map(x => `#${x}:checked~.text-content .${menuItems[0]}`).join(',')}{
display: none;
}
`;

createIcons({ icons });