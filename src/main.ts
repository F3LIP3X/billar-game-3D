import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BALL_R, FOOT_SPOT, HEAD_SPOT, MAX_SHOT_SPEED, POCKETS, TABLE_L, TABLE_W } from './constants';
import { castCueRay, isMoving, step, type Body } from './physics';
import { buildRoom, buildTable } from './table';
import { ballColor, createBallMesh, createCue } from './balls';
import { evaluateShot, groupOf, type Player, type ShotRecord } from './rules';
import { isMuted, setMuted, setRolling, sounds, unlockAudio } from './audio';

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
const fog = new THREE.Fog(0x0c0a09, 4, 11);
scene.fog = fog;
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.18;

const camera = new THREE.PerspectiveCamera(42, 1, 0.02, 40);
camera.position.set(-2.3, 1.5, 0.9);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495; // desde la vertical hasta casi a ras de mesa
controls.minDistance = 0.25;
controls.maxDistance = 20;
controls.enableZoom = true; // pellizco en táctil; la rueda se gestiona aparte con zoom suave
controls.screenSpacePanning = false; // desplazar sobre el plano de la mesa
controls.rotateSpeed = 0.7;
const PLAY_BUTTONS = {
  LEFT: null as unknown as THREE.MOUSE, // el clic izquierdo es para jugar
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
};
// Con Ctrl pulsado: cámara libre, el clic izquierdo gira y el derecho desplaza
const FREE_BUTTONS = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
controls.mouseButtons = { ...PLAY_BUTTONS };
controls.touches = {
  ONE: null as unknown as THREE.TOUCH,
  TWO: THREE.TOUCH.DOLLY_ROTATE,
};
// En el menú la cámara gira despacio alrededor de la mesa
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;

scene.add(buildTable());
const { setLampsOpacity } = buildRoom(scene);

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
const cueGuide = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  guideMat.clone(),
);
(cueGuide.material as THREE.LineDashedMaterial).opacity = 0.3;
scene.add(guide, objectGuide, cueGuide, ghost);

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

// Color de cada jugador: panel, aviso de turno y guía de tiro
const PLAYER_COLORS = ['#e2b65e', '#6aa6ff'];

// Estadísticas de la partida para la pantalla de victoria
let stats = [0, 1].map(() => ({ shots: 0, potted: 0, fouls: 0 }));
let gameStart = 0;

const cueBall = () => balls[0];
const onTable = () => balls.filter((b) => b.body.active && b.n !== 0).map((b) => b.n);

function newGame() {
  for (const b of balls) scene.remove(b.mesh);
  balls = [];
  const add = (n: number, x: number, z: number) => {
    const mesh = createBallMesh(n);
    scene.add(mesh);
    balls[n] = { n, body: { id: n, x, z, vx: 0, vz: 0, rx: 0, rz: 0, active: true }, mesh, sinking: null };
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
  stats = [0, 1].map(() => ({ shots: 0, potted: 0, fouls: 0 }));
  gameStart = performance.now();
  controls.autoRotate = false;
  stopConfetti();
  state = 'placing'; // saque: bola en mano detrás de la línea de cabecera
  isBreak = true;
  kitchenOnly = true;
  overlay.hidden = true;
  syncMeshes(0);
  renderHud();
  showMessage('Coloca la blanca detrás de la línea');
  announceTurn('Saque de Jugador 1');
}

// ---------- HUD ----------
const overlay = document.querySelector<HTMLDivElement>('#overlay')!;
const messageEl = document.querySelector<HTMLDivElement>('#message')!;
const powerEl = document.querySelector<HTMLDivElement>('#power')!;
const powerFill = document.querySelector<HTMLDivElement>('#power-fill')!;
document.querySelector('#restart')!.addEventListener('click', () => {
  newGame();
  setView('3d');
});
document.querySelector('#to-menu')!.addEventListener('click', () => {
  newGame();
  state = 'menu';
  hud.hidden = true;
  startScreen.hidden = false;
  startScreen.classList.remove('leaving');
  controls.autoRotate = true;
  moveCamera(new THREE.Vector3(-2.6, 1.9, 1.8), new THREE.Vector3(0, 0, 0), BASE_FOV, true);
});

function showVictory(winner: number, shooterWon: boolean, foul: boolean) {
  const loser = 1 - winner;
  const group = players[winner].group;
  document.querySelector('#winner-name')!.textContent = `¡Gana ${players[winner].name}!`;
  document.querySelector('#win-reason')!.textContent = shooterWon
    ? `Ha metido la 8 tras limpiar las ${group}`
    : `${players[loser].name} metió la 8 ${foul ? 'con falta' : 'antes de tiempo'}`;
  document.querySelectorAll<HTMLElement>('.stats [data-col]').forEach((el) => {
    const col = Number(el.dataset.col);
    el.classList.toggle('winner', col === winner);
    if (el.tagName === 'TH') el.textContent = players[col].name;
    else el.textContent = String(stats[col][el.dataset.stat as 'shots' | 'potted' | 'fouls']);
  });
  const secs = Math.round((performance.now() - gameStart) / 1000);
  document.querySelector('#duration')!.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  overlay.hidden = false;
  // De fondo, la cámara gira despacio alrededor de la mesa
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.8;
  sounds.win();
  startConfetti();
}

// ---------- Confeti ----------
const confettiCanvas = document.querySelector<HTMLCanvasElement>('#confetti')!;
const confettiCtx = confettiCanvas.getContext('2d')!;
const CONFETTI_COLORS = ['#c9a25a', '#e8cf8f', '#2d5aa8', '#f6f1e4', '#c0392b'];
let confetti: { x: number; y: number; vx: number; vy: number; rot: number; vr: number; w: number; h: number; color: string }[] = [];
let confettiFrame = 0;

function startConfetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  confettiCanvas.width = innerWidth * dpr;
  confettiCanvas.height = innerHeight * dpr;
  confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  confetti = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -6 - Math.random() * 10,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    w: 6 + Math.random() * 6,
    h: 3 + Math.random() * 4,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
  }));
  cancelAnimationFrame(confettiFrame);
  const tick = () => {
    confettiCtx.clearRect(0, 0, innerWidth, innerHeight);
    confetti = confetti.filter((c) => c.y < innerHeight + 20);
    for (const c of confetti) {
      c.vy += 0.25;
      c.vx *= 0.99;
      c.x += c.vx;
      c.y += c.vy;
      c.rot += c.vr;
      confettiCtx.save();
      confettiCtx.translate(c.x, c.y);
      confettiCtx.rotate(c.rot);
      confettiCtx.scale(1, Math.cos(c.rot * 2)); // el giro del papel
      confettiCtx.fillStyle = c.color;
      confettiCtx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      confettiCtx.restore();
    }
    if (confetti.length) confettiFrame = requestAnimationFrame(tick);
  };
  tick();
}

function stopConfetti() {
  cancelAnimationFrame(confettiFrame);
  confetti = [];
  confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
}

let messageTimer = 0;
function showMessage(text: string) {
  messageEl.textContent = text;
  messageEl.classList.add('visible');
  clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => messageEl.classList.remove('visible'), 2800);
}

const turnBanner = document.querySelector<HTMLDivElement>('#turn-banner')!;
let bannerTimer = 0;
/** Aviso grande en el centro con el jugador que tira ahora. */
function announceTurn(text: string) {
  turnBanner.textContent = text;
  turnBanner.style.setProperty('--pc', PLAYER_COLORS[current]);
  turnBanner.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => turnBanner.classList.remove('show'), 1600);
  (guide.material as THREE.LineDashedMaterial).color.set(PLAYER_COLORS[current]);
}

function renderHud() {
  const tableBalls = onTable();
  document.querySelectorAll<HTMLDivElement>('.player').forEach((el) => {
    const i = Number(el.dataset.player);
    const p = players[i];
    el.classList.toggle('active', i === current);
    const left = p.group ? tableBalls.filter((n) => groupOf(n) === p.group).length : 0;
    el.querySelector('.group')!.textContent = !p.group
      ? 'mesa abierta'
      : left > 0
        ? `${p.group} · quedan ${left}`
        : `${p.group} · ¡a por la 8!`;
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

// El taco apunta siempre al cursor. Con Shift pasa a modo de precisión: el giro es relativo
// y mucho más lento, para afinar sin que importe lo cerca que esté el cursor de la blanca.
let lastAimPoint: THREE.Vector3 | null = null;
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function aimOrPlace(e: PointerEvent, relative: boolean) {
  const p = pointerOnTable(e);
  if (!p) return;
  const c = cueBall().body;
  if (state === 'aiming') {
    const angle = Math.atan2(p.z - c.z, p.x - c.x);
    if (relative && e.shiftKey && lastAimPoint) {
      const prev = Math.atan2(lastAimPoint.z - c.z, lastAimPoint.x - c.x);
      const dist = Math.hypot(p.x - c.x, p.z - c.z);
      // Sensibilidad fija (no depende de la distancia): equivale a tener el cursor a 2 m
      aimAngle += wrapAngle(angle - prev) * Math.min(1, dist / 2) * 0.5;
    } else {
      aimAngle = angle;
    }
    lastAimPoint = p;
  } else if (state === 'placing') {
    const maxX = kitchenOnly ? KITCHEN_X : TABLE_L / 2 - BALL_R;
    c.x = THREE.MathUtils.clamp(p.x, -TABLE_L / 2 + BALL_R, maxX);
    c.z = THREE.MathUtils.clamp(p.z, -TABLE_W / 2 + BALL_R, TABLE_W / 2 - BALL_R);
  }
}

// ---------- Cámara libre (Ctrl) ----------
let freeCam = false;
function setFreeCam(on: boolean) {
  if (on === freeCam || state === 'menu' || state === 'over') return;
  freeCam = on;
  controls.mouseButtons = on ? { ...FREE_BUTTONS } : { ...PLAY_BUTTONS };
  document.body.classList.toggle('free-cam', on);
  if (on && state === 'charging') {
    state = 'aiming'; // si estaba cargando el tiro, se cancela
    power = 0;
  }
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Control') setFreeCam(true);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Control') setFreeCam(false);
});
window.addEventListener('blur', () => setFreeCam(false));

canvas.addEventListener('pointermove', (e) => {
  if (freeCam) return;
  if (e.pointerType === 'touch' && touches.size > 1) return;
  aimOrPlace(e, true);
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || freeCam) return;
  unlockAudio();
  if (e.pointerType === 'touch') {
    touches.add(e.pointerId);
    if (touches.size === 1) aimOrPlace(e, false);
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

// Efecto: altura del golpe en la blanca, de -0.5 (retroceso) a 0.5 (seguir), en radios
let spin = 0;
const spinDot = document.querySelector<HTMLDivElement>('#spin-dot')!;
const spinLabel = document.querySelector<HTMLSpanElement>('#spin-label')!;
function setSpin(value: number) {
  spin = THREE.MathUtils.clamp(Math.round(value * 4) / 4, -0.5, 0.5);
  spinDot.style.transform = `translateY(${-spin * 36}px)`;
  spinLabel.textContent = spin > 0 ? 'Seguir' : spin < 0 ? 'Retroceso' : 'Centro';
}
document.querySelector('#spin')!.addEventListener('click', (e) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const up = (e as MouseEvent).clientY < r.top + r.height / 2;
  setSpin(spin + (up ? 0.25 : -0.25));
  sounds.ui();
});

window.addEventListener('keydown', (e) => {
  if (state === 'aiming') {
    const delta = e.shiftKey ? 0.0008 : 0.004;
    if (e.key === 'ArrowLeft') aimAngle -= delta;
    if (e.key === 'ArrowRight') aimAngle += delta;
  }
  if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') setSpin(spin + 0.25);
  if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') setSpin(spin - 0.25);
  if (state !== 'menu') {
    if (e.key === 'v' || e.key === 'V') setView('cue');
    if (e.key === '1') setView('3d');
    if (e.key === '2') setView('2d');
  }
});

const bottomBar = document.querySelector<HTMLDivElement>('.bottom')!;

/** Alto de pantalla que ocupa la barra inferior (0 si el HUD está oculto). */
function bottomBarHeight() {
  return bottomBar.offsetParent ? window.innerHeight - bottomBar.getBoundingClientRect().top : 0;
}

// Esquinas de la mesa (con raíles) que tienen que verse enteras en la vista inicial
const TABLE_CORNERS = [-1, 1].flatMap((sx) =>
  [-1, 1].map((sz) => new THREE.Vector3(sx * (TABLE_L / 2 + 0.24), 0.05, sz * (TABLE_W / 2 + 0.24))),
);

const BASE_FOV = 42;
const TOP_FOV = 24; // en la vista 2D, poco ángulo para que apenas haya perspectiva

/** Distancia mínima en la dirección `dir` (desde el centro) para que la mesa entera quepa en la zona libre. */
function fitPosition(dir: THREE.Vector3, fov: number) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  let maxX = 0.94;
  let maxY = 0.94;
  const minY = -1 + (2 * (bottomBarHeight() + 8)) / h;
  const panel = document.querySelector<HTMLElement>('.player[data-player="0"]');
  if (panel?.offsetParent) {
    const r = panel.getBoundingClientRect();
    if (w <= 600) maxY = 1 - (2 * (r.bottom + 8)) / h;
    else maxX = 1 - (2 * (r.right + 16)) / w;
  }
  const cam = camera.clone();
  cam.fov = fov;
  cam.updateProjectionMatrix();
  const p = new THREE.Vector3();
  let dist = 1;
  for (; dist < 30; dist += 0.05) {
    cam.position.copy(dir).multiplyScalar(dist);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const fits = TABLE_CORNERS.every((c) => {
      p.copy(c).project(cam);
      return Math.abs(p.x) < maxX && p.y < maxY && p.y > minY;
    });
    if (fits) break;
  }
  return dir.clone().multiplyScalar(dist);
}

// Transición suave de cámara: se interpola en esféricas alrededor del objetivo (gira alrededor
// de la mesa en vez de atravesarla) y el objetivo y el ángulo de visión en lineal.
let camTween: {
  from: THREE.Spherical;
  to: THREE.Spherical;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromFov: number;
  toFov: number;
  start: number;
} | null = null;

function moveCamera(toPos: THREE.Vector3, toTarget: THREE.Vector3, toFov: number, animate: boolean) {
  zoomGoal = null;
  if (!animate) {
    camera.position.copy(toPos);
    controls.target.copy(toTarget);
    camera.fov = toFov;
    camera.updateProjectionMatrix();
    return;
  }
  const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  const to = new THREE.Spherical().setFromVector3(toPos.clone().sub(toTarget));
  // Girar por el camino más corto
  to.theta = from.theta + wrapAngle(to.theta - from.theta);
  camTween = {
    from,
    to,
    fromTarget: controls.target.clone(),
    toTarget,
    fromFov: camera.fov,
    toFov,
    start: performance.now(),
  };
  controls.enabled = false;
}

const tweenSph = new THREE.Spherical();
function updateCameraTween() {
  if (!camTween) return;
  const t = Math.min(1, (performance.now() - camTween.start) / 800);
  const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease-in-out
  const { from, to } = camTween;
  // El radio en escala logarítmica para que el acercamiento tenga velocidad constante a la vista
  tweenSph.radius = Math.exp(THREE.MathUtils.lerp(Math.log(from.radius), Math.log(to.radius), k));
  tweenSph.phi = THREE.MathUtils.lerp(from.phi, to.phi, k);
  tweenSph.theta = THREE.MathUtils.lerp(from.theta, to.theta, k);
  controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, k);
  camera.position.setFromSpherical(tweenSph).add(controls.target);
  camera.fov = THREE.MathUtils.lerp(camTween.fromFov, camTween.toFov, k);
  camera.updateProjectionMatrix();
  if (t >= 1) {
    camTween = null;
    controls.enabled = true;
  }
}

// Zoom suave con la rueda, hacia el punto de la mesa bajo el cursor
let zoomGoal: number | null = null;
const zoomPoint = new THREE.Vector3();
window.addEventListener(
  'wheel',
  (e) => {
    if (e.target !== canvas || state === 'menu') return;
    e.preventDefault();
    e.stopPropagation(); // que no llegue al zoom a saltos de OrbitControls
    if (camTween) return;
    const current = zoomGoal ?? camera.position.distanceTo(controls.target);
    zoomGoal = THREE.MathUtils.clamp(
      current * Math.exp(e.deltaY * 0.0015),
      controls.minDistance,
      controls.maxDistance,
    );
    const p = pointerOnTable(e as unknown as PointerEvent);
    zoomPoint.copy(p ?? controls.target);
  },
  { capture: true, passive: false },
);

function updateZoom(dt: number) {
  if (zoomGoal === null) return;
  const current = camera.position.distanceTo(controls.target);
  const next = THREE.MathUtils.lerp(current, zoomGoal, 1 - Math.exp(-dt * 12));
  const f = next / current;
  // Escalar cámara y objetivo respecto al punto del cursor: ese punto se queda quieto en pantalla
  controls.target.sub(zoomPoint).multiplyScalar(f).add(zoomPoint);
  camera.position.sub(zoomPoint).multiplyScalar(f).add(zoomPoint);
  if (Math.abs(next - zoomGoal) < 0.002) zoomGoal = null;
}

type View = '3d' | '2d' | 'cue';
let view: View = '3d';
function setView(v: View, animate = true) {
  view = v;
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  const origin = new THREE.Vector3(0, 0, 0);
  if (v === '3d') {
    // Mesa en vertical, cámara centrada detrás de la cabecera y algo baja, como un jugador
    const elev = THREE.MathUtils.degToRad(window.innerWidth <= 600 ? 52 : 40);
    const dir = new THREE.Vector3(-Math.cos(elev), Math.sin(elev), 0.0001);
    moveCamera(fitPosition(dir, BASE_FOV), origin, BASE_FOV, animate);
  } else if (v === '2d') {
    // Desde arriba; la mesa a lo largo de la pantalla según la orientación
    const dir = camera.aspect >= 1 ? new THREE.Vector3(0, 1, 0.0001) : new THREE.Vector3(-0.0001, 1, 0);
    moveCamera(fitPosition(dir, TOP_FOV), origin, TOP_FOV, animate);
  } else {
    const { pos, target } = chaseCamera();
    moveCamera(pos, target, BASE_FOV, animate);
  }
}
// Vista tras la bola: posición detrás de la blanca según el ángulo de tiro
const followDist = 0.9;
function chaseCamera() {
  const c = cueBall().body;
  const dx = Math.cos(aimAngle);
  const dz = Math.sin(aimAngle);
  return {
    pos: new THREE.Vector3(c.x - dx * followDist, followDist * 0.45, c.z - dz * followDist),
    target: new THREE.Vector3(c.x + dx * 0.3, 0, c.z + dz * 0.3),
  };
}


document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    sounds.ui();
    setView(b.dataset.view as View);
  }),
);

const muteBtn = document.querySelector<HTMLButtonElement>('#mute')!;
function renderMute() {
  muteBtn.classList.toggle('off', isMuted());
  muteBtn.setAttribute('aria-label', isMuted() ? 'Activar sonido' : 'Silenciar');
  muteBtn.title = isMuted() ? 'Activar sonido (M)' : 'Silenciar (M)';
}
function toggleMute() {
  unlockAudio();
  setMuted(!isMuted());
  renderMute();
  sounds.ui();
}
muteBtn.addEventListener('click', toggleMute);
window.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') toggleMute();
});
renderMute();

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
  // Golpe a una altura h (en radios) sobre el centro: giro = 5·h/2 · velocidad
  c.rx = c.vx * 2.5 * spin;
  c.rz = c.vz * 2.5 * spin;
  sounds.cue(power);
  stats[current].shots++;
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
  stats[current].potted += shot.potted.filter((n) => n !== 0).length;
  if (result.foul) stats[current].fouls++;

  if (result.winner !== null) {
    state = 'over';
    renderHud();
    showVictory(result.winner, result.winner === current, result.foul);
    return;
  }

  const turnChanged = !result.keepTurn;
  if (turnChanged) current = 1 - current;
  if (result.foul) sounds.foul();
  else if (turnChanged) sounds.turn();

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
  if (turnChanged) announceTurn(`Turno de ${players[current].name}`);
  // La vista tras la bola se recoloca detrás de la blanca para el siguiente tiro
  if (view === 'cue') setView('cue');
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
    // El giro visual sigue el giro real (puede no coincidir con la dirección si desliza)
    const spinSpeed = Math.hypot(b.body.rx, b.body.rz);
    if (spinSpeed > 0) {
      tmpAxis.set(b.body.rz, 0, -b.body.rx).divideScalar(spinSpeed);
      tmpQ.setFromAxisAngle(tmpAxis, (spinSpeed * dt) / BALL_R);
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
  guide.visible = objectGuide.visible = cueGuide.visible = aiming;
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
  cue.position.set(c.x - dx * pull, BALL_R + 0.004 + spin * BALL_R, c.z - dz * pull);
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
    // La blanca sale por la tangente (sin efecto); más corta cuanto más de lleno es el golpe
    const along = dx * (nx / len) + dz * (nz / len);
    const tx = dx - along * (nx / len);
    const tz = dz - along * (nz / len);
    setLine(cueGuide, gx, gz, gx + tx * 0.25, gz + tz * 0.25);
  } else {
    objectGuide.visible = cueGuide.visible = false;
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
  Object.assign(ball.body, { x, z: 0, vx: 0, vz: 0, rx: 0, rz: 0, active: true });
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
    // En el saque hay muchos choques a la vez: solo suenan los más fuertes
    [...ev.ballHits].sort((a, b) => b.speed - a.speed).slice(0, 5).forEach((h) => sounds.ball(h.speed));
    for (const hit of ev.ballHits) {
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
  setRolling(state === 'rolling' ? balls.reduce((sum, b) => sum + (b.body.active ? Math.hypot(b.body.vx, b.body.vz) : 0), 0) : 0);

  if (state === 'rolling' && !isMoving(balls.map((b) => b.body)) && balls.every((b) => !b.sinking)) {
    endShot();
  }

  updateAimVisuals();
  updateCameraTween();
  updateZoom(dt);
  controls.update();
  // Que el desplazamiento no saque la mesa de la vista
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, -1.6, 1.6);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, -1, 1);
  controls.target.y = 0;
  // La niebla oscurece la sala, no la mesa: empieza siempre detrás de ella
  const camDist = camera.position.distanceTo(controls.target);
  fog.near = camDist + 1.5;
  fog.far = camDist + 8;
  // Desde arriba las lámparas taparían la mesa
  setLampsOpacity(state === 'menu' ? 1 : 1 - THREE.MathUtils.smoothstep(camera.position.y, 1.0, 1.5));
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Al cambiar el tamaño de la ventana se reencuadra la vista fija actual
  if (state !== 'menu' && view !== 'cue') setView(view, false);
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
  setView('3d', false);
  if (matchMedia('(pointer: coarse)').matches) showMessage('Toca la mesa para colocar la blanca · dos dedos mueven la cámara');
});

resize();
newGame();
state = 'menu';
controls.autoRotate = true;
camera.position.set(-2.6, 1.9, 1.8);
frame();
