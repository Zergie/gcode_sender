const { console_log } = require("../logging");

let lastError = 0;
let integral = 0;
let pidInterval = 0;
exports.initialize = function (state, power) {
    pidInterval = setInterval(() => {
        const { temp, target, kp, ki, kd } = state.get();

        if (target == 0) {
            power.set(0);
        } else {
            let error = target - temp;
            let derivative = 0;
            
            integral += error;
            derivative = error - lastError;
            
            let p = power.get();
            p += kp * error + ki * integral + kd * derivative;
            // console.log(`>pid> kp: ${kp}, ki: ${ki}, kd: ${kd} => error, ${error}, p: ${p}`)
            if (p < 0) p = 0;
            if (p > 255) p = 255;
            power.set(p);

            lastError = error;
        }
    }, interval = 50);
};

exports.stop = function () {
    clearInterval(pidInterval);
    pidInterval = 0;
};