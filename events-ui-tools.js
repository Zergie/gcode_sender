const { send, print, warn, error } = require('./events-ui-settings.js');
const { Storage } = require('./storage.js');
let currentAction = null;

Storage.register(__filename, {
    on_reload: function (callback) {
        const data = {
            currentAction: currentAction,
        };
        callback(data);
    },
    on_save: function (callback) {
        const data = {
            targetTemp:      parseFloat(document.querySelector("#target-temp").value),
            settleThreshold: parseFloat(document.querySelector("#settle-threshold").value),
            steadyDuration:  parseFloat(document.querySelector("#steady-duration").value),
            maxIterations:   parseInt(document.querySelector("#max-iterations").value),
            maxWaitTime:     parseFloat(document.querySelector("#max-wait-time").value),
            minHeatRate:     parseFloat(document.querySelector("#min-heat-rate").value),
            maxSafeTemp:     parseFloat(document.querySelector("#max-safe-temp").value),
            responseTimeout: parseFloat(document.querySelector("#response-timeout").value),
        };
        callback(data);
    },
    on_load: function (session, localData) {
        document.querySelector("#target-temp").value      = session.targetTemp      || 200;
        document.querySelector("#settle-threshold").value = session.settleThreshold || 1.0;
        document.querySelector("#steady-duration").value  = session.steadyDuration  || 5;
        document.querySelector("#max-iterations").value   = session.maxIterations   || 10;
        document.querySelector("#max-wait-time").value    = session.maxWaitTime     || 2;
        document.querySelector("#min-heat-rate").value    = session.minHeatRate     || 0.05;
        document.querySelector("#max-safe-temp").value    = session.maxSafeTemp     || 250;
        document.querySelector("#response-timeout").value = session.responseTimeout || 5;
        
        if (session.currentAction) {
            const el = document.getElementById(session.currentAction)
            el.click();
            el.dispatchEvent(new Event('click', { bubbles: true }));
        }
    },
});

function setPID(p, i, d) { send(`M301 P${p.toFixed(2)} I${i.toFixed(2)} D${d.toFixed(2)}`); }
function setHeater(temp) { send(`M104 S${temp}`); }
async function getHeaterState(timeout) {
    const now = Date.now();
    const result = await new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            window.removeEventListener('serialport:data-temp', checkTemp);
            warn('⚠️ Timeout: No temperature data received.');
            resolve({
                temp: null,
                time: null,
                responseTime: Infinity,
            });
        }, timeout);
        
        const checkTemp = function(event) {
            const data = event.detail;
            if (data && data.Tool == 0) {
                window.removeEventListener('serialport:data-temp', checkTemp);
                clearTimeout(timeoutId);
                resolve({
                    temp: data.Temp,
                    time: Date.now(),
                    responseTime: Date.now() - now,
                });
            }
        };
        window.addEventListener('serialport:data-temp', checkTemp);
        
        send(`M105`, true);
    });

    return result;
}

document.getElementById('pid-tuning-button').addEventListener('click', async event => {
    currentAction = 'pid-tuning-button';
    Storage.save(__filename);
    document.getElementById('terminal').checked = true;

    const targetTemp = parseFloat(document.querySelector("#target-temp").value) || 100;
    const settleThreshold = parseFloat(document.querySelector("#settle-threshold").value) || 1.0;
    const steadyDuration = 1000 * (parseFloat(document.querySelector("#steady-duration").value) || 5);
    const maxIterations = parseInt(document.querySelector("#max-iterations").value) || 10;
    const maxWaitTime = 60000 * (parseFloat(document.querySelector("#max-wait-time").value) || 2);
    const minHeatRate = parseFloat(document.querySelector("#min-heat-rate").value) || 0.05;
    const maxSafeTemp = parseFloat(document.querySelector("#max-safe-temp").value) || 250;
    const responseTimeout = 1000 * (parseFloat(document.querySelector("#response-timeout").value) || 5);

    // Tuning state
    let pid = { P: 16, I: 0.0, D: 0.0 };
    let iteration = 0;

    async function tuneStep() {
        if (iteration >= maxIterations) {
            print('🎉 Tuning complete!');
            setPID(pid.P, pid.I, pid.D);
            send(`M503`);
            tuneEnd();
            print(`✅ Save with: M500`);
            return;
        }

        print(`🔁 Iteration ${iteration + 1}`);
        send(`M155 S0`); // Disable auto-reporting
        setPID(pid.P, pid.I, pid.D);
        setHeater(targetTemp);

        const heaterState = await getHeaterState(responseTimeout);
        const temps = [];
        let stableStart = null;
        let lastTemp = heaterState.temp;
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
                error(`⏳ No temperature response in ${responseTimeout/1000} seconds!`);
                tuneEnd(interval);
                return;
            }

            // Prevent runaway heating (e.g., sensor failure)
            if (currentTemp > maxSafeTemp) {
                error(`🔥 Overtemperature! Temp = ${currentTemp}°C`);
                tuneEnd(interval);
                return;
            }

            // Catch open thermistor or disconnect
            if (lastTemp - currentTemp > 10) {
                error(`⚠️ Sudden temp drop: ${lastTemp}°C → ${currentTemp}°C`);
                tuneEnd(interval);
                return;
            }

            // Check heating rate (underpowered?)
            const tempDelta = currentTemp - lastTemp;
            const timeDeltaSec = (now - lastTime) / 1000;
            const rate = tempDelta / timeDeltaSec;

            // if (rate < minHeatRate && currentTemp < targetTemp - 5) {
            //     error(`❌ Heating too slowly! (${rate.toFixed(3)} °C/s)`);
            //     error('💡 Heater might be underpowered or disconnected.');
            //     tuneEnd(interval);
            //     return;
            // }

            // Check timeout
            if (timeElapsed > maxWaitTime) {
                error('⏱️ Timeout: Heater failed to stabilize within limit.');
                tuneEnd(interval);
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

                print(`📊 Avg steady temp: ${avg.toFixed(2)}°C`);
                print(`📈 Overshoot: +${overshoot.toFixed(2)}°C`);

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
                    print('✔️ Stability within ±1°C reached!');
                    iteration = maxIterations;
                }

                iteration++;
                await tuneStep();
            }

        }, 1000);
    }

    await tuneStep();
});

document.getElementById('pid-fine-tuning-button').addEventListener('click', event => {
    currentAction = 'pid-fine-tuning-button';
    Storage.save(__filename);
    document.getElementById('terminal').checked = true;

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

function tuneEnd(interval = undefined) {
    if (interval) {
        clearInterval(interval);
    }
    setHeater(0);
    currentAction = null;
}
