const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, 'simulation.js'), 'utf8');

// Exercise the production timer callback without Electron, wall-clock jitter,
// or sensor noise. Each run gets the same fresh ambient-temperature grid.
function simulate(duty, steps = 150) {
    let tick;
    let temperatures;
    let measuredTemperature;
    const simulation = {};
    runInNewContext(source, {
        exports: simulation,
        require: (name) => {
            assert.equal(name, 'electron');
            return {
                BrowserWindow: {
                    getAllWindows: () => [{ webContents: {
                        send: (channel, values) => {
                            assert.equal(channel, 'simulation:update');
                            temperatures = values;
                        },
                    } }],
                },
            };
        },
        setInterval: (callback) => { tick = callback; return 1; },
        clearInterval: () => {},
    });
    simulation.sensor.noise = () => 0;
    simulation.initialize({ get: () => duty * 255 }, {
        set: (value) => { measuredTemperature = value; },
    });
    for (let step = 0; step < steps; step++) tick();
    simulation.stop();
    return { measuredTemperature, temperatures, ambient: simulation.ambient.temperature };
}

test('25%, 50%, and 100% duty produce increasing sensor temperatures', (t) => {
    const readings = [0.25, 0.5, 1].map((duty) => simulate(duty).measuredTemperature);
    t.diagnostic(`Sensor temperatures after 15 s at 25%, 50%, 100%: ${readings.join(', ')} C`);
    assert.ok(readings[0] > 22, `25% duty must heat the sensor: ${readings}`);
    assert.ok(readings[1] > readings[0], `50% duty must exceed 25%: ${readings}`);
    assert.ok(readings[2] > readings[1], `100% duty must exceed 50%: ${readings}`);
});

test('one full-power step does not saturate heater cells', () => {
    const { temperatures, ambient } = simulate(1, 1);
    const maximum = Math.max(...temperatures.flat(2));
    assert.ok(maximum > ambient);
    assert.ok(maximum < 100, `one 0.1 s step should heat metal by only a few degrees: ${maximum}`);
});

test('zero duty preserves ambient equilibrium', () => {
    const { temperatures, measuredTemperature, ambient } = simulate(0, 10);
    assert.equal(measuredTemperature, ambient);
    assert.ok(temperatures.flat(2).every((value) => value === ambient));
});
