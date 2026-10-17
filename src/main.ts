import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BALL_R, FOOT_SPOT, HEAD_SPOT, MAX_SHOT_SPEED, POCKETS, TABLE_L, TABLE_W } from './constants';
import { castCueRay, isMoving, step, type Body } from './physics';
import { buildRoom, buildTable } from './table';
import { ballColor, createBallMesh, createCue } from './balls';
import { evaluateShot, groupOf, type Player, type ShotRecord } from './rules';
import { sounds, unlockAudio } from './audio';

// Línea de cabecera: en el saque (y tras blanca dentro en el saque) la blanca va detrás de ella
const KITCHEN_X = HEAD_SPOT.x;

type State = 'menu' | 'aiming' | 'charging' | 'rolling' | 'placing' | 'over';

interface Ball {
  n: number;
  body: Body;
  mesh: THREE.Mesh;
  sinking: { x: number; z: number } | null;
}

// ---------- Escena ----------
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c0a09);
scene.fog = new THREE.Fog(0x0c0a09, 4, 11);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.18;

const camera = new THREE.PerspectiveCamera(42, 1, 0.02, 40);
camera.position.set(-2.3, 1.5, 0.9);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 0.4;
controls.maxDistance = 5;
controls.mouseButtons = {
  LEFT: null as unknown as THREE.MOUSE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = {
  ONE: null as unknown as THREE.TOUCH,
  TWO: THREE.TOUCH.DOLLY_ROTATE,
};
// En el menú la cámara gira despacio alrededor de la mesa
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;

scene.add(buildTable());
const { lamps } = buildRoom(scene);

const cue = createCue();
scene.add(cue);

// Guía de tiro
const guideMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.02, gapSize: 0.015, transparent: true, opacity: 0.6 });
const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), guideMat);
const objectGuide = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  guideMat.clone(),
);
const ghost = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }),
);
scene.add(guide, objectGuide, ghost);

// Línea de cabecera y zona de saque, visibles al colocar la blanca para el saque
const kitchen = new THREE.Group();
const kitchenArea = new THREE.Mesh(
  new THREE.PlaneGeometry(TABLE_L / 4, TABLE_W),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false }),
);
kitchenArea.rotation.x = -Math.PI / 2;
kitchenArea.position.set(-TABLE_L / 2 + TABLE_L / 8, 0.001, 0);
const headString = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(KITCHEN_X, 0.002, -TABLE_W / 2),
    new THREE.Vector3(KITCHEN_X, 0.002, TABLE_W / 2),
  ]),
  new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.03, gapSize: 0.02, transparent: true, opacity: 0.5 }),
);
headString.computeLineDistances();
kitchen.add(kitchenArea, headString);
scene.add(kitchen);

// ---------- Estado de juego ----------
const RACK_ORDER = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 6, 13, 14, 7, 15];

let balls: Ball[] = [];
let players: Player[] = [];
let current = 0;
let state: State = 'menu';
let aimAngle = 0;
let power = 0;
let chargeStart = 0;
let shot: ShotRecord = { firstHit: null, potted: [] };
let onTableBefore: number[] = [];
let isBreak = true;
let shotIsBreak = false;
let kitchenOnly = true;

const cueBall = () => balls[0];
const onTable = () => balls.filter((b) => b.body.active && b.n !== 0).map((b) => b.n);

function newGame() {
  for (const b of balls) scene.remove(b.mesh);
  balls = [];
  const add = (n: number, x: number, z: number) => {
    const mesh = createBallMesh(n);
    scene.add(mesh);
    balls[n] = { n, body: { id: n, x, z, vx: 0, vz: 0, active: true }, mesh, sinking: null };
  };

  add(0, HEAD_SPOT.x, HEAD_SPOT.z);
  const d = BALL_R * 2 * 1.002;
  let k = 0;
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) {
      add(RACK_ORDER[k++], FOOT_SPOT.x + row * d * Math.cos(Math.PI / 6), (j - row / 2) * d);
    }
  }

  players = [
    { name: 'Jugador 1', group: null },
    { name: 'Jugador 2', group: null },
  ];
  current = 0;
  aimAngle = 0;
  state = 'placing'; // saque: bola en mano detrás de la línea de cabecera
  isBreak = true;
  kitchenOnly = true;
  overlay.hidden = true;
  syncMeshes(0);
  renderHud();
  showMessage('Saque de Jugador 1: coloca la blanca detrás de la línea');
}

// ---------- HUD ----------
const overlay = document.querySelector<HTMLDivElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLHeadingElement>('#overlay-title')!;
const messageEl = document.querySelector<HTMLDivElement>('#message')!;
const powerEl = document.querySelector<HTMLDivElement>('#power')!;
const powerFill = document.querySelector<HTMLDivElement>('#power-fill')!;
document.querySelector('#restart')!.addEventListener('click', newGame);

let messageTimer = 0;
function showMessage(text: string) {
  messageEl.textContent = text;
  messageEl.classList.add('visible');
  clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => messageEl.classList.remove('visible'), 2800);
}

function renderHud() {
  const tableBalls = onTable();
  document.querySelectorAll<HTMLDivElement>('.player').forEach((el) => {
    const i = Number(el.dataset.player);
    const p = players[i];
    el.classList.toggle('active', i === current);
    el.querySelector('.group')!.textContent = p.group ? p.group : 'mesa abierta';
    const tray = el.querySelector('.tray')!;
    tray.innerHTML = '';
    if (!p.group) return;
    for (let n = 1; n <= 15; n++) {
      if (groupOf(n) !== p.group) continue;
      const chip = document.createElement('span');
      chip.className = 'chip' + (n > 8 ? ' stripe' : '') + (tableBalls.includes(n) ? '' : ' potted');
      chip.style.setProperty('--c', ballColor(n));
      chip.textContent = String(n);
      tray.append(chip);
    }
  });
}

// ---------- Entrada ----------
const raycaster = new THREE.Raycaster();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BALL_R);
const pointer = new THREE.Vector2();

function pointerOnTable(e: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.intersectPlane(tablePlane, new THREE.Vector3());
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// En táctil: un dedo apunta / mueve la blanca, dos dedos mueven la cámara y se tira con el botón.
const touches = new Set<number>();

function aimOrPlace(e: PointerEvent) {
  const p = pointerOnTable(e);
  if (!p) return;
  const c = cueBall().body;
  if (state === 'aiming') {
    aimAngle = Math.atan2(p.z - c.z, p.x - c.x);
  } else if (state === 'placing') {
    const maxX = kitchenOnly ? KITCHEN_X : TABLE_L / 2 - BALL_R;
    c.x = THREE.MathUtils.clamp(p.x, -TABLE_L / 2 + BALL_R, maxX);
    c.z = THREE.MathUtils.clamp(p.z, -TABLE_W / 2 + BALL_R, TABLE_W / 2 - BALL_R);
  }
}

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touches.size > 1) return;
  aimOrPlace(e);
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  unlockAudio();
  if (e.pointerType === 'touch') {
    touches.add(e.pointerId);
    if (touches.size === 1) aimOrPlace(e);
    return;
  }
  if (state === 'aiming') startCharge();
  else if (state === 'placing' && placementValid()) state = 'aiming';
});

window.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') {
    const wasSingle = touches.size === 1 && touches.has(e.pointerId);
    touches.delete(e.pointerId);
    if (wasSingle && state === 'placing' && placementValid()) state = 'aiming';
    return;
  }
  if (e.button === 0 && state === 'charging') shoot();
});
window.addEventListener('pointercancel', (e) => touches.delete(e.pointerId));

function startCharge() {
  state = 'charging';
  chargeStart = performance.now();
}

const shootBtn = document.querySelector<HTMLButtonElement>('#shoot-btn')!;
shootBtn.addEventListener('pointerdown', (e) => {
  unlockAudio();
  shootBtn.setPointerCapture(e.pointerId);
  if (state === 'aiming') startCharge();
});
shootBtn.addEventListener('pointerup', () => {
  if (state === 'charging') shoot();
});
shootBtn.addEventListener('contextmenu', (e) => e.preventDefault());

document.querySelectorAll<HTMLButtonElement>('[data-fine]').forEach((btn) =>
  btn.addEventListener('click', () => {
    if (state === 'aiming') aimAngle += Number(btn.dataset.fine) * 0.003;
  }),
);
document.querySelector('#view-btn')!.addEventListener('click', () => cameraBehindCue());

window.addEventListener('keydown', (e) => {
  if (state === 'aiming') {
    const delta = e.shiftKey ? 0.0008 : 0.004;
    if (e.key === 'ArrowLeft') aimAngle -= delta;
    if (e.key === 'ArrowRight') aimAngle += delta;
  }
  if ((e.key === 'v' || e.key === 'V') && state !== 'menu') cameraBehindCue();
});

const bottomBar = document.querySelector<HTMLDivElement>('.bottom')!;

/** Alto de pantalla que ocupa la barra inferior (0 si el HUD está oculto). */
function bottomBarHeight() {
  return bottomBar.offsetParent ? window.innerHeight - bottomBar.getBoundingClientRect().top : 0;
}

function resetCamera() {
  // Mesa en vertical: cámara centrada detrás de la cabecera, mirando a lo largo.
  // Se ajusta para que quepa entera en el hueco que deja libre la barra inferior.
  const h = window.innerHeight;
  const free = Math.max(0.4, (h - bottomBarHeight()) / h);
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * free;
  const freeAspect = camera.aspect / free;
  const fitHeight = 1.5 / tanV; // medio largo visible con perspectiva
  const fitWidth = 0.95 / (tanV * freeAspect); // medio ancho con raíles + margen
  const dist = Math.max(fitHeight, fitWidth);
  const elev = THREE.MathUtils.degToRad(62);
  camera.position.set(-dist * Math.cos(elev), dist * Math.sin(elev), 0.001);
  controls.target.set(0, 0, 0);
}

function cameraBehindCue() {
  const c = cueBall().body;
  const dx = Math.cos(aimAngle);
  const dz = Math.sin(aimAngle);
  camera.position.set(c.x - dx * 0.9, 0.42, c.z - dz * 0.9);
  controls.target.set(c.x + dx * 0.3, 0, c.z + dz * 0.3);
}

function placementValid() {
  const c = cueBall().body;
  return balls.every(
    (b) => b.n === 0 || !b.body.active || Math.hypot(b.body.x - c.x, b.body.z - c.z) > BALL_R * 2.05,
  );
}

function shoot() {
  const c = cueBall().body;
  const speed = 0.25 + power * (MAX_SHOT_SPEED - 0.25);
  c.vx = Math.cos(aimAngle) * speed;
  c.vz = Math.sin(aimAngle) * speed;
  sounds.cue(power);
  shot = { firstHit: null, potted: [] };
  onTableBefore = onTable();
  shotIsBreak = isBreak;
  isBreak = false;
  state = 'rolling';
  power = 0;
}

function endShot() {
  const result = evaluateShot(players, current, shot, onTableBefore, shotIsBreak);
  const cb = cueBall();

  if (result.respotEight) respot(balls[8]);

  if (result.winner !== null) {
    state = 'over';
    overlayTitle.textContent = result.message;
    overlay.hidden = false;
    renderHud();
    return;
  }

  if (!result.keepTurn) current = 1 - current;

  if (result.foul) {
    if (!cb.body.active) {
      cb.body.active = true;
      cb.sinking = null;
      cb.mesh.visible = true;
      cb.body.x = HEAD_SPOT.x;
      cb.body.z = HEAD_SPOT.z;
    }
    // Reglas WPA: falta en el saque → bola en mano detrás de la línea; después, en cualquier sitio
    kitchenOnly = shotIsBreak;
    if (kitchenOnly) cb.body.x = Math.min(cb.body.x, KITCHEN_X);
    state = 'placing';
  } else {
    state = 'aiming';
  }
  showMessage(result.message);
  renderHud();
}

// ---------- Bucle ----------
const tmpQ = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();

function syncMeshes(dt: number) {
  for (const b of balls) {
    if (b.sinking) {
      b.mesh.position.x += (b.sinking.x - b.mesh.position.x) * Math.min(1, dt * 10);
      b.mesh.position.z += (b.sinking.z - b.mesh.position.z) * Math.min(1, dt * 10);
      b.mesh.position.y -= dt * 0.6;
      if (b.mesh.position.y < -0.12) {
        b.mesh.visible = false;
        b.sinking = null;
      }
      continue;
    }
    if (!b.body.active) continue;
    const speed = Math.hypot(b.body.vx, b.body.vz);
    if (speed > 0) {
      tmpAxis.set(b.body.vz, 0, -b.body.vx).divideScalar(speed);
      tmpQ.setFromAxisAngle(tmpAxis, (speed * dt) / BALL_R);
      b.mesh.quaternion.premultiply(tmpQ);
    }
    b.mesh.position.set(b.body.x, BALL_R, b.body.z);
    b.mesh.visible = true;
  }
}

function updateAimVisuals() {
  const aiming = state === 'aiming' || state === 'charging';
  const c = cueBall().body;
  cue.visible = aiming;
  guide.visible = objectGuide.visible = aiming;
  ghost.visible = aiming || state === 'placing';
  powerEl.classList.toggle('visible', state === 'charging');
  shootBtn.disabled = !aiming;
  kitchen.visible = state === 'placing' && kitchenOnly;
  shootBtn.textContent = state === 'placing' ? 'Toca la mesa para colocar' : 'Mantén para tirar';

  if (state === 'placing') {
    ghost.position.set(c.x, BALL_R, c.z);
    (ghost.material as THREE.MeshBasicMaterial).color.set(placementValid() ? 0xffffff : 0xff4040);
    return;
  }
  (ghost.material as THREE.MeshBasicMaterial).color.set(0xffffff);
  if (!aiming) return;

  const dx = Math.cos(aimAngle);
  const dz = Math.sin(aimAngle);

  // Taco
  const pull = BALL_R + 0.012 + power * 0.28;
  cue.position.set(c.x - dx * pull, BALL_R + 0.004, c.z - dz * pull);
  cue.lookAt(c.x - dx * (pull + 1), BALL_R + 0.12, c.z - dz * (pull + 1));

  // Guía hasta la bola fantasma
  const { distance, hit } = castCueRay(c, balls.map((b) => b.body), dx, dz);
  const gx = c.x + dx * distance;
  const gz = c.z + dz * distance;
  ghost.position.set(gx, BALL_R, gz);
  setLine(guide, c.x, c.z, gx, gz);

  if (hit) {
    const nx = hit.x - gx;
    const nz = hit.z - gz;
    const len = Math.hypot(nx, nz) || 1;
    setLine(objectGuide, hit.x, hit.z, hit.x + (nx / len) * 0.25, hit.z + (nz / len) * 0.25);
  } else {
    objectGuide.visible = false;
  }
}

function setLine(line: THREE.Line, x0: number, z0: number, x1: number, z1: number) {
  const pos = line.geometry.attributes.position as THREE.BufferAttribute;
  pos.setXYZ(0, x0, BALL_R, z0);
  pos.setXYZ(1, x1, BALL_R, z1);
  pos.needsUpdate = true;
  line.computeLineDistances();
}

/** Recoloca una bola en el punto de pie, o lo más cerca detrás de él si está ocupado. */
function respot(ball: Ball) {
  const free = (x: number) =>
    balls.every((b) => b === ball || !b.body.active || Math.hypot(b.body.x - x, b.body.z) > BALL_R * 2.05);
  let x = FOOT_SPOT.x;
  while (!free(x) && x < TABLE_L / 2 - BALL_R) x += BALL_R * 0.5;
  Object.assign(ball.body, { x, z: 0, vx: 0, vz: 0, active: true });
  ball.sinking = null;
  ball.mesh.visible = true;
}

function nearestPocket(x: number, z: number) {
  return POCKETS.reduce((a, p) => (Math.hypot(p.x - x, p.z - z) < Math.hypot(a.x - x, a.z - z) ? p : a));
}

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 30);

  if (state === 'charging') {
    const t = ((performance.now() - chargeStart) / 1100) % 2;
    power = t < 1 ? t : 2 - t;
    powerFill.style.transform = `scaleX(${power})`;
  }

  if (state === 'rolling') {
    const ev = step(balls.map((b) => b.body), dt);
    for (const hit of ev.ballHits) {
      sounds.ball(hit.speed);
      if (shot.firstHit === null && (hit.a.id === 0 || hit.b.id === 0)) {
        shot.firstHit = hit.a.id === 0 ? hit.b.id : hit.a.id;
      }
    }
    for (const s of ev.cushionHits) sounds.cushion(s);
    for (const body of ev.potted) {
      sounds.pocket();
      shot.potted.push(body.id);
      const pocket = nearestPocket(body.x, body.z);
      balls[body.id].sinking = { x: pocket.x, z: pocket.z };
    }
    if (ev.potted.length) renderHud();
  }

  syncMeshes(dt);

  if (state === 'rolling' && !isMoving(balls.map((b) => b.body)) && balls.every((b) => !b.sinking)) {
    endShot();
  }

  updateAimVisuals();
  controls.update();
  // Desde arriba las lámparas taparían la mesa
  lamps.visible = state === 'menu' || camera.position.y < 1.2;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Centra la imagen en la zona que no tapa la barra inferior
  camera.setViewOffset(w, h, 0, bottomBarHeight() / 2, w, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

const startScreen = document.querySelector<HTMLDivElement>('#start')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;
document.querySelector('#play')!.addEventListener('click', () => {
  unlockAudio();
  startScreen.classList.add('leaving');
  setTimeout(() => (startScreen.hidden = true), 600);
  hud.hidden = false;
  controls.autoRotate = false;
  newGame();
  resize();
  resetCamera();
  if (matchMedia('(pointer: coarse)').matches) showMessage('Toca la mesa para colocar la blanca · dos dedos mueven la cámara');
});

resize();
newGame();
state = 'menu';
camera.position.set(-2.6, 1.9, 1.8);
frame();
