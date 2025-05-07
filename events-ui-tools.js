const { send } = require('./events-ui-settings.js');

require('./storage.js').register(__filename, {
    on_save: function (callback) {
        const data = {
            temp: document.querySelector("#target-temp").value
        };
        callback(data);
    },
    on_load: function (session, localData) {
        document.querySelector("#target-temp").value = session.temp || 200;
    },
});

function setPID(p, i, d) { send(`M301 P${p.toFixed(2)} I${i.toFixed(2)} D${d.toFixed(2)}`); }
function setHeater(temp) { send(`M104 S${temp}`); }
async function getHeaterState(timeout) {
    const now = Date.now();
    const result = await new Promise((resolve) => {
        send(`M105`);
        
        const checkTemp = function(event) {
            const data = event.detail;
            if (data && data.Tool == 1) {
                window.removeEventListener('serialport:data-temp', checkTemp);
                clearTimeout(timeoutId);
                resolve({
                    temp: data.temp,
                    time: Date.now(),
                    responseTime: Date.now() - now,
                });
            }
        };
        window.addEventListener('serialport:data-temp', checkTemp);

        const timeoutId = setTimeout(() => {
            window.removeEventListener('serialport:data-temp', checkTemp);
            console.warn('⚠️ Timeout: No temperature data received.');
            resolve({
                temp: null,
                time: null,
                responseTime: Infinity,
            });
        }, timeout);
    });

    return result;
}

document.getElementById('pid-tuning-button').addEventListener('click', event => {
    const targetTemp = parseFloat(document.querySelector("#target-temp").value) || 0;
    const settleThreshold = parseFloat(document.querySelector("#settle-threshold").value) || 1.0;
    const steadyDuration = 1000 * (parseFloat(document.querySelector("#steady-duration").value) || 5);
    const maxIterations = parseInt(document.querySelector("#max-iterations").value) || 10;
    const maxWaitTime = 60000 * (parseFloat(document.querySelector("#max-wait-time").value) || 2);
    const minHeatRate = parseFloat(document.querySelector("#min-heat-rate").value) || 0.05;
    const maxSafeTemp = parseFloat(document.querySelector("#max-safe-temp").value) || 250;
    const responseTimeout = 1000 * (parseFloat(document.querySelector("#response-timeout").value) || 5);

    // Tuning state
    let pid = { P: 16, I: 2.0, D: 85.0 }; //todo: read starting values from controller
    let iteration = 0;

    function tuneStep() {
        if (iteration >= maxIterations) {
            console.log('🎉 Tuning complete!');
            console.log(`✅ Final PID: M301 P${pid.P.toFixed(2)} I${pid.I.toFixed(2)} D${pid.D.toFixed(2)}`);
            return;
        }

        console.log(`\n🔁 Iteration ${iteration + 1}`);
        setPID(pid.P, pid.I, pid.D);
        setHeater(targetTemp);

        const temps = [];
        let stableStart = null;
        let lastTemp = currentTemp;
        let lastTime = Date.now();
        const startTime = Date.now();

        const interval = setInterval(async () => {
            const heaterState = await getHeaterState(responseTimeout);

            const currentTemp = heaterState.temp;
            const now = Date.now();
            const diff = Math.abs(currentTemp - targetTemp);
            const timeElapsed = now - startTime;

            // Detect communication failure
            if (heaterState.responseTime > responseTimeout) {
                console.error(`⏳ No temperature response in ${responseTimeout/1000} seconds!`);
                clearInterval(interval);
                return;
            }

            // Prevent runaway heating (e.g., sensor failure)
            if (currentTemp > maxSafeTemp) {
                console.error(`🔥 Overtemperature! Temp = ${currentTemp}°C`);
                clearInterval(interval);
                return;
            }

            // Catch open thermistor or disconnect
            if (lastTemp - currentTemp > 10) {
                console.error(`⚠️ Sudden temp drop: ${lastTemp}°C → ${currentTemp}°C`);
                clearInterval(interval);
                return;
            }

            // Check heating rate (underpowered?)
            const tempDelta = currentTemp - lastTemp;
            const timeDeltaSec = (now - lastTime) / 1000;
            const rate = tempDelta / timeDeltaSec;

            if (rate < minHeatRate && currentTemp < targetTemp - 5) {
                clearInterval(interval);
                console.error(`❌ Heating too slowly! (${rate.toFixed(3)} °C/s)`);
                console.error('💡 Heater might be underpowered or disconnected.');
                return;
            }

            // Check timeout
            if (timeElapsed > maxWaitTime) {
                clearInterval(interval);
                console.error('⏱️ Timeout: Heater failed to stabilize within limit.');
                return;
            }

            lastTemp = currentTemp;
            lastTime = now;

            // Stability check
            if (diff <= settleThreshold) {
                if (!stableStart) stableStart = now;
                temps.push(currentTemp);
            } else {
                stableStart = null;
                temps.length = 0;
            }

            if (stableStart && now - stableStart >= steadyDuration) {
                clearInterval(interval);
                const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
                const overshoot = Math.max(...temps) - targetTemp;

                console.log(`📊 Avg steady temp: ${avg.toFixed(2)}°C`);
                console.log(`📈 Overshoot: +${overshoot.toFixed(2)}°C`);

                // Tune logic
                if (overshoot > 3) {
                    pid.P -= 1;
                    pid.D += 10;
                } else if (avg < targetTemp - 1) {
                    pid.I += 0.3;
                } else if (avg > targetTemp + 1) {
                    pid.I -= 0.2;
                    pid.D += 5;
                } else {
                    console.log('✔️ Stability within ±1°C reached!');
                    iteration = maxIterations;
                }

                iteration++;
                tuneStep();
            }

        }, 1000);
    }

    tuneStep();
});

document.getElementById('pid-fine-tuning-button').addEventListener('click', event => {
    alert('PID fine tuning started!');
});


Array.from(document.querySelectorAll("*[unit=celsius]")).forEach(item => {
    const span = document.createElement("span");
    span.classList.add("unit");
    span.innerText = "°C";
    span.style.left = "-30px";
    item.after(span);
});
Array.from(document.querySelectorAll("*[unit=seconds]")).forEach(item => {
    const span = document.createElement("span");
    span.classList.add("unit");
    span.innerText = "s";
    span.style.left = "-20px";
    item.after(span);
});
Array.from(document.querySelectorAll("*[unit=minutes]")).forEach(item => {
    const span = document.createElement("span");
    span.classList.add("unit");
    span.innerText = "min";
    span.style.left = "-40px";
    item.after(span);
});