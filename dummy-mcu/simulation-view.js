const { ipcRenderer } = require('electron');
const THREE = require('three')
const { OrbitControls } = require("three/examples/jsm/controls/OrbitControls.js");
const { grid, camber, sensor } = require('./simulation.js');

let temps = null;
let target = null;

exports.initialize = function () {
  const lower_panel = document.getElementById('lower-panel');
  const canvas = document.getElementById('simulation-canvas');
  const width = 600;
  const height = lower_panel.getBoundingClientRect().height;

  const center = { x: camber.width / 2, y: camber.depth / 2, z: 0 };
  const scene = new THREE.Scene();

  const axesHelper = new THREE.AxesHelper(200);
  axesHelper.position.set(center.x, center.z, center.y);
  scene.add(axesHelper);

  const camera = new THREE.PerspectiveCamera(75, width / height, 1, 1000);
  camera.position.set(300, 300, 200);
  camera.lookAt(scene.position);

  const renderer = new THREE.WebGLRenderer({ canvas: canvas });
  renderer.setSize(width, height);

  const resizeObserver = new ResizeObserver((entries) => {
    const { width, height } = lower_panel.getBoundingClientRect();
    camera.aspect = canvas.width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.width, height);
  });
  resizeObserver.observe(lower_panel);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(center.x, center.z, center.y);
  canvas.replaceWith(renderer.domElement);

  // Lighting
  const light = new THREE.AmbientLight(0xffffff);
  scene.add(light);

  // bounding box
  const boxGeometry = new THREE.BoxGeometry(camber.width, camber.height, camber.depth,);
  const boxMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
  const box = new THREE.Mesh(boxGeometry, boxMaterial);
  box.position.set(camber.width / 2, camber.height / 2, camber.depth / 2);
  scene.add(box);

  // sensor
  const cellSize = grid.cellSize;
  const sensorGeometry = new THREE.SphereGeometry(cellSize / 4, 8, 4);
  const sensorMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff });
  const sensorMesh = new THREE.Mesh(sensorGeometry, sensorMaterial);
  const sensorPos = sensor.getGridPos();
  sensorMesh.position.set(sensorPos.x * cellSize, sensorPos.z * cellSize, sensorPos.y * cellSize);
  scene.add(sensorMesh)

  // Cell visualization
  const cubes = [];
  for (let x = 0; x < grid.X; x++) {
    cubes[x] = [];
    for (let y = 0; y < grid.Y; y++) {
      cubes[x][y] = [];
      for (let z = 0; z < grid.Z; z++) {
        const geometry = new THREE.BoxGeometry(cellSize, cellSize, cellSize);
        const material = new THREE.MeshBasicMaterial({ color: 0x0000ff, transparent: true, opacity: 0.01 });
        const cube = new THREE.Mesh(geometry, material);

        cube.position.set(
          x * cellSize + cellSize / 2 - 2*cellSize,
          z * cellSize + cellSize / 2 - 2*cellSize,
          y * cellSize + cellSize / 2 - 2*cellSize,
        );

        cubes[x][y][z] = cube;
        scene.add(cube);
      }
    }
  }

  // Map temperature to color
  function temperatureToColor(x, y, z, temp) {
    if (!target) {
      const minT = 20, maxT = 150;
      const ratio = Math.min(Math.max((temp - minT) / (maxT - minT), 0), 1);
      const r = Math.floor(ratio * 255);
      const b = Math.floor((1 - ratio) * 255);
      return new THREE.Color(`rgb(${r},0,${b})`);
    } else if ((target - 1) <= temp && temp <= (target + 1)) {
      return new THREE.Color(0x00ff00); // Green for target temperature
    } else {
      const minT = 20, maxT = target * 1.5;
      const ratio = Math.min(Math.max((temp - minT) / (maxT - minT), 0), 1);
      const r = Math.floor(ratio * 255);
      const b = Math.floor((1 - ratio) * 255);
      return new THREE.Color(`rgb(${r},0,${b})`);
    }
  }
  function temperatureToOpacity(x, y, z, temp) {
    if (x == 0 || y == 0 || z == 0 || x == grid.X-1 || y == grid.Y-1 || z == grid.Z-1) return 0.01;
    const minT = 30, maxT = 100;
    const ratio = Math.min(Math.max((temp - minT) / (maxT - minT), 0), .25);
    return ratio;
  }

  // Animation loop
  function animate() {
    requestAnimationFrame(animate);

    if (temps) {
      for (let x = 0; x < grid.X; x++) {
        for (let y = 0; y < grid.Y; y++) {
          for (let z = 0; z < grid.Z; z++) {
            const t = temps[x][y][z];
            cubes[x][y][z].material.color = temperatureToColor(x, y, z, t);
            cubes[x][y][z].material.opacity = temperatureToOpacity(x, y, z, t);
          }
        }
      }
    }

    renderer.render(scene, camera);
  }
  animate();

  ipcRenderer.on('simulation:update', (event, temps_) => { temps = temps_; });
  ipcRenderer.on('dummy-mcu:update-target', (event, target_) => { target = target_; });
};

