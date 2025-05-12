const { dispatchEvent } = require('./dispatchEvent');
const { Storage } = require('./storage.js');

let temp = 22;
let target = 0;
let power = 0;
let kp = 2.0;
let ki = 0.1;
let kd = 0.5;

let M155Interval = 0;

Storage.register(__filename, {
  on_reload: function (callback) {
    const data = {
      temp: temp,
      target: target,
      power: power,
    };
    callback(data);
  },
  on_save: function (callback) {
    const data = {
      kp: kp,
      ki: ki,
      kd: kd,
    };
    callback(data);
  },
  on_load: function (session, localData) {
    temp = parseFloat(session.temp) || 22.0;
    target = parseFloat(session.target) || 0.0;
    power = parseFloat(session.power) || 0.0;
    kp = parseFloat(session.kp) || 2.0;
    ki = parseFloat(session.ki) || 0.1;
    kd = parseFloat(session.kd) || 0.5;
  },
});

exports.write = function (data) {
  const command = {};
  const regex = /^(?<name>[A-Z][0-9]+)|(?<key>[A-Z])(?<value>[-\d.]*)/g;
  let match;

  while ((match = regex.exec(data)) !== null) {
    if (match.groups.name) {
      command.name = match.groups.name;
    } else if (match.groups.key && match.groups.value) {
      command[match.groups.key] = match.groups.value;
    }
  }
  console.log('Received command:', command);
  switch (command.name) {
    case 'M104':
      if (command.S) {
        target = parseFloat(command.S);
      }
      respond(`ok`);
      break;
    case 'M105':
      reportTemperature();
      break;
    case 'M155':
      if (command.S) {
        const interval = parseFloat(command.S);
        if (interval > 0) {
          clearInterval(M155Interval);
          M155Interval = setInterval(reportTemperature, interval * 1000);
        } else {
          clearInterval(M155Interval);
        }
      }
      break;
    case 'M115':
      respond('FIRMWARE_NAME: DummyMCU MACHINE_TYPE: DummyMCU UUID: 1234567890');
      break;
    case 'M130':
      if (command.S) { kp = parseFloat(command.S); }
      respond('ok');
      break;
    case 'M131':
      if (command.S) { ki = parseFloat(command.S); }
      respond('ok');
      break;
    case 'M132':
      if (command.S) { kd = parseFloat(command.S); }
      respond('ok');
      break;
    case 'M301':
      if (command.P) { kp = parseFloat(command.P); }
      if (command.I) { ki = parseFloat(command.I); }
      if (command.D) { kd = parseFloat(command.D); }
      respond('ok');
      break;
    case 'M500':
      Storage.save(__filename);
      respond('ok');
      break;
    case 'M502':
      Storage.load(__filename);
      respond('ok');
      break;
    case 'M503':
      respond(`kp: ${kp.toFixed(2)}`);
      respond(`ki: ${ki.toFixed(2)}`);
      respond(`kd: ${kd.toFixed(2)}`);
      break;
    default:
      if (command.name) {
        respond(`Unknown command: ${command.name}`);
      } else {
        respond(`Unknown command: ${data}`);
      }
      break;
  }
};

exports.close = function () {
  clearInterval(reportTemperature);
};

exports.settings = {
  path: 'dummy-mcu',
  baudRate: 115200,
};

// PID control
let lastError = 0;
setInterval(() => {
  let error = target - temp;
  let integral = 0;
  let derivative = 0;

  integral += error;
  derivative = error - lastError;

  power += kp * error + ki * integral + kd * derivative;

  if (power < 0) power = 0;
  if (power > 255) power = 255;

  lastError = error;
}, interval = 100);

function respond(data) {
  // console.log('Responding:', data);
  dispatchEvent('serialport:data', { data: data, });
}

function reportTemperature(tool = 0, temperature = 0.0) {
  if (tool == 0) {
    respond(`T0:${temp.toFixed(2)} /${target.toFixed(0)} @0:${power.toFixed(0)}`);
  } else {
    respond(`T${tool}:${temperature.toFixed(2)}`);
  }
}

const camber = {
  width: 200,
  height: 200,
  depth: 100,
};
const ambient = {
  temperature: 22.0,
  lossRate: {
    front: 0.0043,
    back: 0.0043,
    top_bottom: 0.0043,
    side: 0.0043,
  }
}
const heater = {
  voltage: 230.0,
  amperage: 8.0,
  getPower: () => heater.voltage * heater.amperage, // in Watts
}
const sensor = {
  x: 100,
  y: 100,
  z: 50,
  noise: () => (Math.random() - 0.5) * 0.4,
  getTemp: (temps) => {
    const sx = Math.floor(sensor.x / dx);
    const sy = Math.floor(sensor.y / dx);
    const sz = Math.floor(sensor.z / dx);
    return temps[sx][sy][sz] + sensor.noise();
  }
}

// Grid and simulation parameters
const dx = 40; // cell size in mm
const gridX = Math.floor(camber.width / dx);
const gridY = Math.floor(camber.height / dx);
const gridZ = Math.floor(camber.depth / dx);
const simSpeed = 100; // real ms per step (speed multiplier)
const dt = simSpeed / 1000; // simulation time step in seconds

const alphaAir = 2.2e-5;
const alphaGlass = 5e-7;;
const alphaInsulation = 1e-7;;

// Initialize 3D temperature grid
let temps = Array.from({ length: gridX }, () =>
  Array.from({ length: gridY }, () =>
    new Float64Array(gridZ).fill(ambient.temperature)
  )
);


// Heater control
function applyHeater(grid) {
  const powerWatts = heater.getPower() * power / 255.0;
  const efficiency = 0.2; // 20% realistic transfer into air
  const energyTotal = powerWatts * efficiency * dt; // joules per timestep

  const c = 1005; // J/(kg·K), specific heat of air
  const rho = 1.2; // kg/m³, density of air

  const dxMeters = dx / 1000; // convert mm → m
  const cellVolume = dxMeters ** 3; // m³
  const cellMass = rho * cellVolume; // kg

  const startX = 1;
  const endX = gridX - 1;
  const centerY = Math.floor(gridY / 2);

  // Count heater cells and apply energy
  let count = 0;
  for (let x = startX; x < endX; x++) {
    count += 2; // top and bottom
  }

  const energyPerCell = energyTotal / count;
  const deltaT = energyPerCell / (cellMass * c);

  for (let x = startX; x < endX; x++) {
    grid[x][centerY][0] += deltaT;
    grid[x][centerY][gridZ - 1] += deltaT;
  }
}

function getLossRate(x, y, z) {
  if (y === gridY - 1) return ambient.lossRate.front;
  if (y === 0) return ambient.lossRate.back;
  if (z === 0 || z === gridZ - 1) ambient.lossRate.top_bottom;
  return ambient.lossRate.side;
}

function deepCopyGrid(grid) {
  return grid.map(layer =>
    layer.map(row => Float64Array.from(row))
  );
}

// Single simulation step
function updateTemperature(grid) {
  const newGrid = deepCopyGrid(grid);

  for (let x = 0; x < gridX; x++) {
    for (let y = 0; y < gridY; y++) {
      for (let z = 0; z < gridZ; z++) {
        const T = grid[x][y][z];
        if (x === 0 || x === gridX - 1 || y === 0 || y === gridY - 1 || z === 0 || z === gridZ - 1) {
          const lossRate = getLossRate(x, y, z);
          // newGrid[x][y][z] += lossRate * dt * (ambient.temperature - T);
        } else {
          const laplacian =
            (grid[x + 1][y][z] + grid[x - 1][y][z] +
              grid[x][y + 1][z] + grid[x][y - 1][z] +
              grid[x][y][z + 1] + grid[x][y][z - 1] - 6.0 * T) / (dx * dx);
          newGrid[x][y][z] = T + alphaAir * dt * laplacian;
          if (laplacian > 0) {
            console.log(`laplacian: ${laplacian}, alphaAir: ${alphaAir}, dt: ${dt}, T[${x}][${y}][${z}] = ${grid[x][y][z]} -> ${newGrid[x][y][z]}`);
          }
        }
      }
    }
  }

  return newGrid;
}

function logCenterYPlaneVisual(temps) {
  const centerY = Math.floor(gridY / 2);

  const emojiForTemp = (t) => {
    if (t < 25) return '🧊';        // cold
    if (t < 35) return '🔵';        // cool
    if (t < 50) return '🟢';        // warm
    if (t < 70) return '🟡';        // hot
    if (t < 90) return '🟠';        // hotter
    return '🔴';                    // very hot
  };

  console.log(`\n--- 🔥 Temperature Slice at Y=${centerY} ---`);
  for (let z = 0; z < gridZ; z++) {
    let row = '';
    for (let x = 0; x < gridX; x++) {
      const t = temps[x][centerY][z];
      row += emojiForTemp(t);
    }
    console.log(row);
  }
}


exports.initSimulation = function () {
  // Simulation loop
  setInterval(() => {
    applyHeater(temps);
    temps = updateTemperature(temps);
    temp = sensor.getTemp(temps);
    reportTemperature(1, temps[0][0][0]);
    reportTemperature(2, temps[0][0][gridZ - 1]);
    // logCenterYPlane(temps);
  }, simSpeed);
};