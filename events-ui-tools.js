require('./storage.js').register(__filename, {
    on_save: function (callback) {
        const data = {
            temp : document.querySelector("#target-temp").value
        };
        callback(data);
    },
    on_load: function (session, localData) {
        document.querySelector("#target-temp").value = session.temp || 200;
    },
  });

document.getElementById('pid-tuning-button').addEventListener('click', event => {
    alert('PID tuning started!'); 
});

document.getElementById('pid-fine-tuning-button').addEventListener('click', event => {
    alert('PID fine tuning started!'); 
});