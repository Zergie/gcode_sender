const { console_log } = require("../logging");

let lastError = 0;
exports.initialize = function (state, power) {
    setInterval(() => {
        const { temp, target, kp, ki, kd } = state.get();

        if (target == 0) {
            power.set(0);
        } else {
            let error = target - temp;
            let integral = 0;
            let derivative = 0;
            
            integral += error;
            derivative = error - lastError;
            
            let p = power.get();
            p += kp * error + ki * integral + kd * derivative;
            if (p < 0) p = 0;
            if (p > 255) p = 255;
            power.set(p);

            lastError = error;
        }
    }, interval = 100);
};