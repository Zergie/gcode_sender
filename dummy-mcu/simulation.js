const { BrowserWindow } = require('electron');

const simSpeed = 100; // real ms per step
const simTimeWarp = 1; // too high (>10) values break things!

const dx = 5; // cell size in mm
const camber = {
    width: 80,
    depth: 220,
    height: 60,
    convection_rate: 0.05, // tunable (0.01–0.1 for natural convection)
    material: function (x, y, z) {
        const alphaAir = 2.2e-5;
        const alphaDoubleGlassed = 1e-7 * (dx / 20); // dx / thickness
        const alphaGlasFiber = 5e-8 * (dx / 15); // dx / thickness
        const alphaSteel = 4.05e-6 * (dx / 0.5); // dx / thickness

        let type;
        switch (true) {
            case (x === 0 || y === 0 || z === 0 ||
                x === grid.X - 1 || y === grid.Y - 1 || z === grid.Z - 1):
                type = 'ambient'; break;
            case (x === 1 || y === 1 || z === 1 ||
                x === grid.X - 2 || y === grid.Y - 2 || z === grid.Z - 2):
                type = 'ambient'; break;
            case (x === 2 || y === 2 || z === 2 ||
                y === grid.Y - 3 || z === grid.Z - 3):
                type = 'isolation'; break;
            case (x === grid.X - 4):
                type = 'front'; break;
            case (x === 3):
                type = 'back'; break;
            case (z === 3):
                type = 'bottom'; break;
            case (z === grid.Z - 4):
                type = 'top'; break;
            case (y === 3 || y === grid.Y - 4):
                type = 'side'; break;
            default:
                type = 'air'; break;
        }

        switch (type) {
            case 'ambient':
                return { type: 'ambient', material: 'air', alpha: alphaAir };
            case 'air':
                return { type: 'gas', material: 'air', alpha: alphaAir };
            case 'isolation':
                return { type: 'solid', material: 'glass-fiber', alpha: alphaGlasFiber };
            case 'top':
            case 'bottom':
            case 'side':
            case 'back':
                return { type: 'solid', material: 'steel', alpha: alphaSteel };
            case 'front':
                return { type: 'solid', material: 'glass', alpha: alphaDoubleGlassed };
        }
    }
};
const ambient = {
    temperature: 22.0,
    heatLoss: 0.8,
}
// Fitted to the mean of T1/T2 in physical-cycle.fixture.js (36 observations,
// approximately 3 C RMS error). These are effective model parameters, not
// measured material properties; validation covers this 200 C cycle.
// The attached mass and enclosure-to-room loss stand in for the load, mounts,
// leakage, and thermal bridges that the material grid does not resolve.
const calibration = Object.freeze({
    attachedLoadHeatCapacityJPerK: 325,
    enclosureConductanceWPerK: 4.33,
    sensorResponseSeconds: 18,
});
const heater = {
    topPowerWatts: 900,
    bottomPowerWatts: 900,
    maxTemp: 1200.0,
    getPower: () => heater.topPowerWatts + heater.bottomPowerWatts,
}
const sensor = {
    x: Math.floor(camber.width / 2),
    y: Math.floor(camber.depth / 2),
    z: Math.floor(camber.height / 2),
    temperature: ambient.temperature,
    noise: () => (Math.random() - 0.5) * 0.4,
    getGridPos: () => {
        const x = Math.floor(sensor.x / dx);
        const y = Math.floor(sensor.y / dx);
        const z = Math.floor(sensor.z / dx);
        return { x, y, z };
    },
    getTemp: (temps) => {
        const { x, y, z } = sensor.getGridPos();
        const response = 1 - Math.exp(-dt / calibration.sensorResponseSeconds);
        sensor.temperature += response * (temps[x][y][z] - sensor.temperature);
        return sensor.temperature + sensor.noise();
    }
}

// Grid and simulation parameters
const grid = {
    cellSize: dx,
    X: 8 + Math.floor(camber.width / dx),
    Y: 8 + Math.floor(camber.depth / dx),
    Z: 8 + Math.floor(camber.height / dx)
}
const dt = simSpeed / (simTimeWarp * 1000); // simulation time step in seconds

// Initialize 3D temperature grid
let temps = Array.from({ length: grid.X }, () =>
    Array.from({ length: grid.Y }, () =>
        Array(grid.Z).fill(ambient.temperature))
);

// A temperature-only Laplacian loses energy across unequal heat capacities.
// Exchange heat using interface conductivity and each cell's capacity instead.
const volumetricHeatCapacity = { // J/(m³·K)
    air: 1.2 * 1005,
    steel: 7850 * 500,
    glass: 2500 * 840,
    'glass-fiber': 48 * 840,
};
const cellVolume = (dx / 1000) ** 3;
const cells = temps.map((layer, x) => layer.map((row, y) => row.map((_, z) => {
    const material = camber.material(x, y, z);
    const capacity = volumetricHeatCapacity[material.material];
    return {
        type: material.type,
        material: material.material,
        capacity,
        conductivity: material.alpha * capacity,
    };
})));
const enclosureCells = [];
let enclosureCapacityJPerK = 0;
for (let x = 0; x < grid.X; x++) {
    for (let y = 0; y < grid.Y; y++) {
        for (let z = 0; z < grid.Z; z++) {
            const cell = cells[x][y][z];
            if (cell.material === 'steel' || cell.material === 'glass') {
                enclosureCells.push({ x, y, z, cell });
                enclosureCapacityJPerK += cell.capacity * cellVolume;
            }
        }
    }
}
for (const { cell } of enclosureCells) {
    // Added mass stores heat without changing the material's conductivity.
    cell.capacity *= 1 + calibration.attachedLoadHeatCapacityJPerK / enclosureCapacityJPerK;
}
const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// Geometry and materials are fixed; calculate interface rates once.
const diffusionRates = cells.map((layer, x) => layer.map((row, y) => row.map((cell, z) => {
    if (x === 0 || x === grid.X - 1 || y === 0 || y === grid.Y - 1 || z === 0 || z === grid.Z - 1) return [];
    return neighbors.map(([nx, ny, nz]) => {
        const other = cells[x + nx][y + ny][z + nz];
        // Two half-cell thermal resistances in series (harmonic mean).
        const conductivity = 2 * cell.conductivity * other.conductivity / (cell.conductivity + other.conductivity);
        return conductivity * dt / (cell.capacity * (dx / 1000) ** 2);
    });
})));


// Heater control
let power = null;
function applyHeater(temps) {
    const duty = Math.max(0, Math.min(1, power.get() / 255.0));
    const energyTotal = heater.getPower() * duty * dt; // joules per timestep

    const start = 3; // y=2 is insulation; heat only the steel top/bottom cells
    const end = grid.Y - 3;
    const center = Math.floor(grid.X / 2);
    const count = (end - start) * 2; // top and bottom

    const energyPerCell = energyTotal / count;
    const deltaT = energyPerCell / (cells[center][start][3].capacity * cellVolume);

    for (let x of [center]) {
        for (let y = start; y < end; y++) {
            for (let z of [3, grid.Z - 4]) {
                temps[x][y][z] += deltaT;
                temps[x][y][z] = Math.min(temps[x][y][z], heater.maxTemp);
            }
        }
    }
}

// Single simulation step
function updateTemperature() {
    const old_temps = temps.map(layer =>
        layer.map(row => Array.from(row))
    );

    for (let x = 1; x < grid.X - 1; x++) {
        for (let y = 1; y < grid.Y - 1; y++) {
            for (let z = 1; z < grid.Z - 1; z++) {
                const { type } = cells[x][y][z];
                const T = old_temps[x][y][z];

                const rates = diffusionRates[x][y][z];
                temps[x][y][z] = T +
                    rates[0] * (old_temps[x + 1][y][z] - T) + rates[1] * (old_temps[x - 1][y][z] - T) +
                    rates[2] * (old_temps[x][y + 1][z] - T) + rates[3] * (old_temps[x][y - 1][z] - T) +
                    rates[4] * (old_temps[x][y][z + 1] - T) + rates[5] * (old_temps[x][y][z - 1] - T);

                if (type === 'ambient') {
                    const deltaT = temps[x][y][z] - ambient.temperature;
                    temps[x][y][z] -= deltaT * ambient.heatLoss;
                }
            }
        }
    }

    // Exchange heat once per gas pair after diffusion, so a later cell update
    // cannot overwrite the heat received by its neighbor. Solids do not convect.
    for (let x = 1; x < grid.X - 1; x++) {
        for (let y = 1; y < grid.Y - 1; y++) {
            for (let z = 1; z < grid.Z - 2; z++) {
                if (cells[x][y][z].type !== 'gas' || cells[x][y][z + 1].type !== 'gas') continue;
                const difference = old_temps[x][y][z] - old_temps[x][y][z + 1];
                if (difference > 0) {
                    const deltaT = camber.convection_rate * dt * difference;
                    temps[x][y][z] -= deltaT;
                    temps[x][y][z + 1] += deltaT;
                }
            }
        }
    }

    const conductancePerCell = calibration.enclosureConductanceWPerK / enclosureCells.length;
    for (const { x, y, z, cell } of enclosureCells) {
        const heatToRoomJ = conductancePerCell * (temps[x][y][z] - ambient.temperature) * dt;
        temps[x][y][z] -= heatToRoomJ / (cell.capacity * cellVolume);
    }

    return temps;
}

let simInterval = 0;
exports.initialize = function (power_, temp, { initialTemperatureC } = {}) {
    if (initialTemperatureC !== undefined) {
        if (!Number.isFinite(initialTemperatureC) || initialTemperatureC <= -273.15) {
            throw new RangeError('initialTemperatureC must be finite and above absolute zero');
        }
        for (let x = 0; x < grid.X; x++) {
            for (let y = 0; y < grid.Y; y++) {
                for (let z = 0; z < grid.Z; z++) {
                    temps[x][y][z] = cells[x][y][z].type === 'ambient' ? ambient.temperature : initialTemperatureC;
                }
            }
        }
        sensor.temperature = initialTemperatureC;
    }
    power = power_;
    simInterval = setInterval(() => {
        applyHeater(temps);
        updateTemperature();
        temp.set(sensor.getTemp(temps));
        for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('simulation:update', temps);
        }
        // logCenterYPlaneVisual(temps);
    }, simSpeed);
};
exports.grid = grid;
exports.ambient = ambient;
exports.camber = camber;
exports.sensor = sensor;
exports.calibration = calibration;
exports.stop = function () {
    clearInterval(simInterval);
    simInterval = 0;
};
exports.simSpeed = simSpeed;
exports.simTimeWarp = simTimeWarp;
