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
  const cellSize = grid.cellSize;

  const center = { x: camber.width / 2, y: camber.depth / 2, z: 0 };
  const scene = new THREE.Scene();

  const axesHelper = new THREE.AxesHelper(200);
  axesHelper.position.set(center.x, center.z, center.y);
  scene.add(axesHelper);

  const camera = new THREE.PerspectiveCamera(75, width / height, 1, 1000);
  camera.position.set(260, 60, 32);
  camera.lookAt(scene.position);

  const renderer = new THREE.WebGLRenderer({ canvas: canvas });
  renderer.setPixelRatio(window.devicePixelRatio);
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
  const sensorGeometry = new THREE.SphereGeometry(cellSize / 4, 8, 4);
  const sensorMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff });
  const sensorMesh = new THREE.Mesh(sensorGeometry, sensorMaterial);
  const sensorPos = sensor.getGridPos();
  sensorMesh.position.set(sensorPos.x * cellSize, sensorPos.z * cellSize, sensorPos.y * cellSize);
  scene.add(sensorMesh)

  // Cell visualization
  const vertices = [];
  const colors = [];
  const cubes = [];
  for (let x = 0; x < grid.X; x++) {
    cubes[x] = [];
    for (let y = 0; y < grid.Y; y++) {
      cubes[x][y] = [];
      for (let z = 0; z < grid.Z; z++) {
        switch (camber.material(x, y, z).type) {
          case 'solid':
            const geometry = new THREE.BoxGeometry(cellSize, cellSize, cellSize);
            const material = new THREE.MeshBasicMaterial({
              color: 0x0000ff,
              transparent: true,
              opacity: 0.01,
              depthWrite: false,
              // blending: THREE.AdditiveBlending 
            });
            const cube = new THREE.Mesh(geometry, material);

            cube.position.set(
              x * cellSize + cellSize / 2 - 4 * cellSize,
              z * cellSize + cellSize / 2 - 4 * cellSize,
              y * cellSize + cellSize / 2 - 4 * cellSize,
            );

            cubes[x][y][z] = cube;
            scene.add(cube);
            break;
          default:
            cubes[x][y][z] = null;
            break;
        }

        vertices.push(
          x * cellSize + cellSize / 2 - 4 * cellSize,
          z * cellSize + cellSize / 2 - 4 * cellSize,
          y * cellSize + cellSize / 2 - 4 * cellSize,
        );
        colors.push(0, 0, 0)

      }
    }
  }

  function generateCircleTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();

    return new THREE.CanvasTexture(canvas);;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  const material = new THREE.PointsMaterial({
    size: cellSize * 3,
    map: generateCircleTexture(),
    vertexColors: true, // 🔑 Enables per-point color
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    alphaTest: 0.01,         // Discard fully transparent pixels
    sizeAttenuation: true,   // make size distance-aware
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);

  function getMinMaxT() {
    const minT = 20;
    const maxT = target ? target : 150;
    return { minT, maxT };
  }
  
  // Map temperature to color
  function temperatureToColor(x, y, z, temp) {
    const { minT, maxT } = getMinMaxT();
    const tolerance = 2.5;

    if ((target - tolerance) <= temp && temp <= (target + tolerance)) {
      return new THREE.Color(0x00ff00); // Green for target temperature
    } else if (temp > target) {
        return new THREE.Color(0xff00ff); // Magenta for target temperature
    } else {
      const coolColor = ((x, y, z) => {
        switch (camber.material(x, y, z).material) {
          case 'steel':
            return new THREE.Color(`rgb(150, 145, 145)`);
          case 'glass':
            return new THREE.Color(`rgb(65, 67, 172)`);
          case 'glass-fiber':
            return new THREE.Color(`rgb(255, 255, 255)`);
          default:
            return new THREE.Color(`rgb(0, 0, 0)`);
        }
      })(x, y, z);

      const hotColor = new THREE.Color(`rgb(255, 0, 0)`);
      const result = new THREE.Color(`rgb(0, 0, 0)`);
      result.lerpColors(coolColor, hotColor, (temp - minT) / (maxT - minT));
      return result;
    }
  }

  // Map temperature to Opacity
  function temperatureToOpacity(x, y, z, temp) {
    const { minT, maxT } = getMinMaxT();
    const baseOpacity = ((x, y, z) => {
      switch (camber.material(x, y, z).material) {
        case 'steel': return 1.0;
        case 'glass': return 0.5;
        case 'glass-fiber': return 1.0;
        default: return 0.1;
      }
    })(x, y, z);
    return baseOpacity * (temp - minT) / (maxT - minT);
  }

  // Animation loop
  function animate() {
    requestAnimationFrame(animate);

    if (temps) {
      let index_point = 0;
      const colorAttr = geometry.getAttribute('color');
      for (let x = 0; x < grid.X; x++) {
        for (let y = 0; y < grid.Y; y++) {
          for (let z = 0; z < grid.Z; z++) {
            const t = temps[x][y][z];

            // if (z === 2) {
            switch (camber.material(x, y, z).type) {
              // case 'ambient':
              case 'gas':
                const i3 = index_point * 3;
                const { r, g, b } = temperatureToColor(x, y, z, t);
                colorAttr.array[i3] = r;
                colorAttr.array[i3 + 1] = g;
                colorAttr.array[i3 + 2] = b;
                break;
              case 'solid':
                cubes[x][y][z].material.color = temperatureToColor(x, y, z, t);
                cubes[x][y][z].material.opacity = temperatureToOpacity(x, y, z, t);
                break
            }
            // }

            index_point++;
          }
        }
      }
      colorAttr.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }
  animate();

  ipcRenderer.on('simulation:update', (event, temps_) => { temps = temps_; });
  ipcRenderer.on('dummy-mcu:update-target', (event, target_) => { target = target_; });
};
