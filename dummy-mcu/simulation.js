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
        const alphaDoubleGlassed = 1e-7;
        const alphaGlasFiber = 5e-8 * (dx / 15); // dx / thickness
        const alphaSteel = 4.05e-6 * (dx / 0.5); // dx / thickness

        let type;
        switch (true) {
            case (x === 0 || y === 0 || z === 0 ||
                x === grid.X - 1 || y === grid.Y - 1 || z === grid.Z - 1):
                type = 'ambient'; break;
            case (x === 1 || y === 1 || z === 1 ||
                y === grid.Y - 2 || z === grid.Z - 2):
                type = 'isolation'; break;
            case (x === grid.X - 3):
                type = 'front'; break;
            case (x === 2):
                type = 'back'; break;
            case (z === 2):
                type = 'bottom'; break;
            case (z === grid.Z - 3):
                type = 'top'; break;
            case (y === 2 || y === grid.Y - 3):
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
}
const heater = {
    voltage: 230.0,
    amperage: 8.0,
    maxTemp: 1100.0,
    getPower: () => heater.voltage * heater.amperage, // in Watts
}
const sensor = {
    x: Math.floor(camber.width / 2),
    y: Math.floor(camber.depth / 2),
    z: Math.floor(camber.height / 2),
    noise: () => (Math.random() - 0.5) * 0.4,
    getGridPos: () => {
        const x = Math.floor(sensor.x / dx);
        const y = Math.floor(sensor.y / dx);
        const z = Math.floor(sensor.z / dx);
        return { x, y, z };
    },
    getTemp: (temps) => {
        const { x, y, z } = sensor.getGridPos();
        return temps[x][y][z] + sensor.noise();
    }
}

// Grid and simulation parameters
const grid = {
    cellSize: dx,
    X: 6 + Math.floor(camber.width / dx),
    Y: 6 + Math.floor(camber.depth / dx),
    Z: 6 + Math.floor(camber.height / dx)
}
const dt = simSpeed / (simTimeWarp * 1000); // simulation time step in seconds

// Initialize 3D temperature grid
let temps = Array.from({ length: grid.X }, () =>
    Array.from({ length: grid.Y }, () =>
        Array(grid.Z).fill(ambient.temperature))
);


// Heater control
let power = null;
function applyHeater(temps) {
    const activation = (x) => Math.max(0, Math.sin(x) + x / 2 - 0.25);
    const powerWatts = heater.getPower() * activation(power.get() / 255.0);
    const efficiency = 0.2; // 20% realistic transfer into air
    const energyTotal = powerWatts * efficiency * dt; // joules per timestep

    const c = 1005; // J/(kg·K), specific heat of air
    const rho = 1.2; // kg/m³, density of air

    const dxMeters = dx / 1000; // convert mm → m
    const cellVolume = dxMeters ** 3; // m³
    const cellMass = rho * cellVolume; // kg

    const start = 2;
    const end = grid.Y - 3;
    const center = Math.floor(grid.X / 2);
    const count = (end - start) * 2; // top and bottom

    const energyPerCell = energyTotal / count;
    const deltaT = energyPerCell / (cellMass * c);

    for (let x of [center]) {
        for (let y = start; y < end; y++) {
            for (let z of [3, grid.Z - 4]) {
                temps[x][y][z] += deltaT;
                temps[x][y][z] = Math.min(temps[x][y][z], heater.maxTemp);
            }
        }
    }

    for (let x of [0, grid.X - 1]) {
        for (let y of [0, grid.Y - 1]) {
            for (let z of [0, grid.Z - 1]) {
                temps[x][y][z] = ambient.temperature;
            }
        }
    }
}

// Single simulation step
function updateTemperature() {
    const old_temps = temps.map(layer =>
        layer.map(row => Array.from(row))
    );

    for (let x = 0; x < grid.X - 1; x++) {
        for (let y = 0; y < grid.Y - 1; y++) {
            for (let z = 0; z < grid.Z - 1; z++) {
                const { type, alpha } = camber.material(x, y, z);
                const T = old_temps[x][y][z];
                
                if (type == 'ambient') {
                    temps[x][y][z] = ambient.temperature;
                } else {
                    // heat diffusion
                    const laplacian =
                        (
                            old_temps[x + 1][y][z] + old_temps[x - 1][y][z] +
                            old_temps[x][y + 1][z] + old_temps[x][y - 1][z] +
                            old_temps[x][y][z + 1] + old_temps[x][y][z - 1] - 6 * T
                        ) / ((dx / 1000) ** 2);

                    temps[x][y][z] = T + alpha * dt * laplacian;
                }

                if (type == 'gas') {
                    // Convection upward (hot air rises)
                    if (z < grid.Z - 1) {
                        const Tabove = old_temps[x][y][z + 1];
                        if (T > Tabove) {
                            const dT = camber.convection_rate * dt * (T - Tabove);
                            temps[x][y][z] -= dT;
                            temps[x][y][z + 1] += dT;
                        }
                    }

                    // Convection downward (cold air sinks)
                    if (z > 0) {
                        const Tbelow = old_temps[x][y][z - 1];
                        if (T < Tbelow) {
                            const dT = camber.convection_rate * dt * (Tbelow - T);
                            temps[x][y][z] += dT;
                            temps[x][y][z - 1] -= dT;
                        }
                    }
                }
            }
        }
    }

    for (let x = 0; x < grid.X - 1; x++) {
        for (let y = 0; y < grid.Y - 1; y++) {
            for (let z = 0; z < grid.Z - 1; z++) {
                if (x === 0 || y === 0 || z === 0 ||
                    x === grid.X - 1 || y === grid.Y - 1 || z === grid.Z - 1) {
                    if (temps[x][y][z] > ambient.temperature) {
                        console.log("above ambient:", x, y, z);
                    }
                }
            }
        }
    }

    return temps;
}

function logCenterYPlaneVisual(temps) {
    const centerY = Math.floor(grid.Y / 2);

    const emojiForTemp = (t) => {
        if (t < 0) return '❄️';         // freezing
        if (t < 10) return '🧊';        // very cold
        if (t < 25) return '🔵';        // cold
        if (t < 35) return '🟢';        // cool
        if (t < 50) return '🟡';        // warm
        if (t < 70) return '🟠';        // hot
        if (t < 90) return '🔴';        // very hot
        if (t < 120) return '🔥';       // extremely hot
        return '☀️';                    // scorching
    };

    console.log(`\n--- 🔥 Temperature Slice at Y=${centerY} ---`);
    for (let z = 0; z < grid.Z; z++) {
        let row = '';
        for (let x = 0; x < grid.X; x++) {
            const t = temps[x][centerY][z];
            row += emojiForTemp(t);
        }
        console.log(row);
    }
}

let simInterval = 0;
exports.initialize = function (power_, temp) {
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
exports.camber = camber;
exports.sensor = sensor;
exports.stop = function () {
    clearInterval(simInterval);
    simInterval = 0;
};