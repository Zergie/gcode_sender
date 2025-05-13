const { BrowserWindow } = require('electron');

const simSpeed = 100; // real ms per step
const simTimeWarp = 1; // too high (>10) values break things!

const camber = {
    width: 80,
    depth: 220,
    height: 60
};
const dx = 5; // cell size in mm
const ambient = {
    temperature: 22.0,
    lossRate: {
        front: 0.043,
        back: 0.0043,
        top_bottom: 0.0043,
        side: 0.0043,
    }
}
const heater = {
    voltage: 230.0,
    amperage: 8.0,
    maxTemp: 500.0,
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
    X: 4 + Math.floor(camber.width / dx),
    Y: 4 + Math.floor(camber.depth / dx),
    Z: 4 + Math.floor(camber.height / dx)
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
            for (let z of [0, grid.Z - 1]) {
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

function getLossRate(x, y, z) {
    if (x === grid.X - 1) return ambient.lossRate.front;
    if (x === 0) return ambient.lossRate.back;
    if (z === 0 || z === grid.Z - 1) ambient.lossRate.top_bottom;
    return ambient.lossRate.side;
}

// Single simulation step
function updateTemperature() {
    const old_temps = temps.map(layer =>
        layer.map(row => Float64Array.from(row))
    );

    for (let x = 0; x < grid.X; x++) {
        for (let y = 0; y < grid.Y; y++) {
            for (let z = 0; z < grid.Z; z++) {
                const T = old_temps[x][y][z];
                if (x === 0 || x === grid.X - 1 || y === 0 || y === grid.Y - 1 || z === 0 || z === grid.Z - 1) {
                    temps[x][y][z] += dt * getLossRate(x, y, z) * (ambient.temperature - T);
                }
                const neighbors = [
                    [x - 1, y, z], [x + 1, y, z],
                    [x, y - 1, z], [x, y + 1, z],
                    [x, y, z - 1], [x, y, z + 1],

                    [x - 1, y - 1, z], [x + 1, y + 1, z],
                    [x - 1, y + 1, z], [x + 1, y - 1, z],

                    [x - 1, y, z - 1], [x - 1, y, z + 1],
                    [x - 1, y - 1, z - 1], [x - 1, y - 1, z + 1],
                    [x, y - 1, z - 1], [x, y - 1, z + 1],
                    [x + 1, y - 1, z - 1], [x + 1, y - 1, z + 1],
                    [x + 1, y, z - 1], [x + 1, y, z + 1],
                    [x + 1, y + 1, z - 1], [x + 1, y + 1, z + 1],
                    [x, y + 1, z - 1], [x, y + 1, z + 1],
                    [x - 1, y + 1, z - 1], [x - 1, y + 1, z + 1],
                ];
                const heatRate = 1 / neighbors.length;
                for (const [nx, ny, nz] of neighbors) {
                    if (nx >= 0 && nx < grid.X && ny >= 0 && ny < grid.Y && nz >= 0 && nz < grid.Z) {
                        temps[x][y][z] += dt * (old_temps[nx][ny][nz] - T) * heatRate;
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


exports.initialize = function (power_, temp) {
    power = power_;
    setInterval(() => {
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