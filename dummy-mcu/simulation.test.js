const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { PHYSICAL_200C_CYCLE } = require('./physical-cycle.fixture');

const source = readFileSync(join(__dirname, 'simulation.js'), 'utf8');

// Exercise the production timer callback without Electron, wall-clock jitter,
// or sensor noise. Each run gets the same fresh ambient-temperature grid.
function createSimulation(duty, options = {}) {
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
    simulation.initialize({ get: () => (typeof duty === 'function' ? duty() : duty) * 255 }, {
        set: (value) => { measuredTemperature = value; },
    }, options);
    return {
        simulation,
        tick: () => tick(),
        result: () => ({ measuredTemperature, temperatures, ambient: simulation.ambient.temperature, simulation }),
    };
}

function simulate(duty, steps = 150, prepare) {
    const runner = createSimulation(duty);
    if (prepare) {
        runner.tick();
        prepare(runner.result().temperatures);
    }
    for (let step = 0; step < steps; step++) runner.tick();
    runner.simulation.stop();
    return runner.result();
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

test('replays the measured 12-minute physical cycle at its recorded duty', (t) => {
    const { initial, samples } = PHYSICAL_200C_CYCLE;
    let duty = 0;
    const runner = createSimulation(() => duty, { initialTemperatureC: (initial.t1C + initial.t2C) / 2 });
    const errors = [];
    let firstTargetBandSeconds = null;
    try {
        let previousSeconds = 0;
        for (const [seconds, recordedDuty, t1, t2] of samples) {
            duty = recordedDuty;
            const steps = Math.round((seconds - previousSeconds) * 1000 / runner.simulation.simSpeed);
            for (let step = 0; step < steps; step++) runner.tick();
            const actual = runner.result().measuredTemperature;
            errors.push(actual - (t1 + t2) / 2);
            if (actual >= 199 && firstTargetBandSeconds === null) firstTargetBandSeconds = seconds;
            previousSeconds = seconds;
        }
    } finally {
        runner.simulation.stop();
    }
    const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
    const maximumError = Math.max(...errors.map((error) => Math.abs(error)));
    t.diagnostic(`Physical-cycle control RMSE: ${rmse.toFixed(2)} C; maximum error: ${maximumError.toFixed(2)} C; first 199 C observation: ${firstTargetBandSeconds} s`);
    assert.ok(rmse < 6, `physical-cycle control RMSE ${rmse} C exceeds 6 C`);
    assert.ok(firstTargetBandSeconds >= 140 && firstTargetBandSeconds <= 220, 'warm-up must match the measured target arrival');
    assert.ok(maximumError < 10, 'every observation must be within 10 C of the physical cycle');
});

function storedEnergy({ temperatures, ambient, simulation }) {
    const capacities = { air: 1.2 * 1005, steel: 7850 * 500, glass: 2500 * 840, 'glass-fiber': 48 * 840 };
    const volume = (simulation.grid.cellSize / 1000) ** 3;
    let enclosureCapacity = 0;
    temperatures.forEach((layer, x) => layer.forEach((row, y) => row.forEach((_, z) => {
        const material = simulation.camber.material(x, y, z).material;
        if (material === 'steel' || material === 'glass') enclosureCapacity += capacities[material] * volume;
    })));
    let energy = 0;
    temperatures.forEach((layer, x) => layer.forEach((row, y) => row.forEach((temperature, z) => {
        const material = simulation.camber.material(x, y, z).material;
        const attachedLoad = material === 'steel' || material === 'glass'
            ? 1 + (simulation.calibration?.attachedLoadHeatCapacityJPerK ?? 0) / enclosureCapacity : 1;
        energy += (temperature - ambient) * capacities[material] * volume * attachedLoad;
    })));
    return energy;
}

test('two 900 W heaters apply linear duty and retain energy across material interfaces', () => {
    const fullPowerEnergy = storedEnergy(simulate(1, 1));
    const expected = 2 * 900 * 0.1;
    // Only a small fraction can escape to room air in the first 0.1 s.
    assert.ok(fullPowerEnergy > expected * 0.99 && fullPowerEnergy <= expected,
        `expected nearly ${expected} J, retained ${fullPowerEnergy} J`);
    for (const duty of [0.05, 0.25, 0.5]) {
        const actual = storedEnergy(simulate(duty, 1));
        assert.ok(Math.abs(actual / fullPowerEnergy - duty) < 1e-8, `${duty * 100}% duty supplied ${actual} J`);
    }
    assert.equal(storedEnergy(simulate(-0.1, 1)), 0, 'negative duty must supply no heat');
    assert.equal(storedEnergy(simulate(1.5, 1)), fullPowerEnergy, 'duty above 100% must not exceed rated power');
});

test('zero duty cools a warm chamber without creating heat', () => {
    const runner = createSimulation(0, { initialTemperatureC: 150 });
    try {
        runner.tick();
        const initialEnergy = storedEnergy(runner.result());
        for (let step = 0; step < 600; step++) runner.tick();
        const result = runner.result();
        assert.ok(storedEnergy(result) < initialEnergy);
        assert.ok(result.measuredTemperature < 150 && result.measuredTemperature > result.ambient);
        assert.ok(result.temperatures.flat(2).every((value) => Number.isFinite(value) && value >= result.ambient && value <= 150));
    } finally {
        runner.simulation.stop();
    }
});

test('diffusion and convection conserve heat in an interior hot air cell', () => {
    const result = simulate(0, 1, (temperatures) => { temperatures[8][22][6] = 100; });
    const expected = (100 - result.ambient) * 1.2 * 1005 * (result.simulation.grid.cellSize / 1000) ** 3;
    const energy = storedEnergy(result);
    assert.ok(Math.abs(energy - expected) < 1e-10, `expected ${expected} J, retained ${energy} J`);
    assert.ok(result.temperatures[8][22][7] > result.ambient, 'the cell above must receive heat');
    assert.ok(result.temperatures.flat(2).every((value) => value >= result.ambient && value <= 100));
});
