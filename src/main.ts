import './debug';
import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { BALL_R, FOOT_SPOT, HEAD_SPOT, MAX_SHOT_SPEED, POCKETS, TABLE_L, TABLE_W } from './constants';
import { castCueRay, isMoving, step, type Body } from './physics';
import { buildRoom, buildTable } from './table';
import { ballColor, createBallMesh, createBlobShadow, createCue } from './balls';
import { evaluateShot, groupOf, type Player, type ShotRecord } from './rules';
import { isMuted, setMuted, sounds, unlockAudio } from './audio';
import { low, quality, rememberLowQuality, touch } from './quality';

// Línea de cabecera: en el saque (y tras blanca dentro en el saque) la blanca va detrás de ella
const KITCHEN_X = HEAD_SPOT.x;

type State = 'menu' | 'aiming' | 'charging' | 'rolling' | 'placing' | 'over';

interface Ball {
  n: number;
  body: Body;
  mesh: THREE.Mesh;
  blob?: THREE.Mesh; // sombra de contacto (solo en calidad baja)
  sinking: { x: number; z: number } | null;
}

// ---------- Escena ----------
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = !low;
renderer.shadowMap.type = low ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;

/** Resolución del lienzo: la nativa con un tope de píxeles totales para no agotar la memoria de la GPU. */
function pixelRatioFor(w: number, h: number) {
  const budget = low ? 1_300_000 : 9_000_000;
  return Math.min(window.devicePixelRatio, low ? 1.5 : 2, Math.sqrt(budget / (w * h)));
}

// Si el navegador le quita los gráficos a la página (memoria o GPU saturada), se baja la calidad
// y se recarga una vez; si ya estaba en calidad baja, se avisa en pantalla.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.warn('webglcontextlost');
  if (!low) {
    rememberLowQuality();
    location.reload();
  } else {
    document.querySelector<HTMLElement>('#gfx-error')!.hidden = false;
  }
});
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c0a09);
const fog = new THREE.Fog(0x0c0a09, 4, 11);
scene.fog = fog;
if (!low) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.18;
}
// En calidad baja el vidrio de la interfaz es opaco: desenfocar un lienzo 3D que se redibuja
// en cada fotograma es muy caro en móvil
document.documentElement.classList.toggle('low', low);

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
  // En móvil se juega siempre desde arriba: dos dedos solo acercan y desplazan, no giran
  TWO: touch ? THREE.TOUCH.DOLLY_PAN : THREE.TOUCH.DOLLY_ROTATE,
};
if (touch) controls.enableRotate = false;
// En el menú la cámara gira despacio alrededor de la mesa
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;

scene.add(buildTable());
const { setLampsOpacity } = buildRoom(scene);

const cue = createCue();
scene.add(cue);

// Guía de tiro: líneas gruesas (en píxeles) que se dibujan por encima de todo para que
// ni las bandas ni las bolas las tapen al acercar la cámara
function guideLine(color: number, opacity: number, width: number) {
  const line = new Line2(
    new LineGeometry().setPositions([0, 0, 0, 1, 0, 0]),
    new LineMaterial({
      color,
      linewidth: width,
      dashed: true,
      dashSize: 0.025,
      gapSize: 0.015,
      transparent: true,
      opacity,
      depthTest: false,
    }),
  );
  line.renderOrder = 10;
  return line;
}
const guide = guideLine(0xffffff, 0.85, 2.5);
const objectGuide = guideLine(0xffffff, 0.9, 2.5);
const cueGuide = guideLine(0xffffff, 0.4, 2);
const ghost = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }),
);
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
  for (const b of balls) {
    scene.remove(b.mesh);
    if (b.blob) scene.remove(b.blob);
  }
  balls = [];
  const add = (n: number, x: number, z: number) => {
    const mesh = createBallMesh(n);
    scene.add(mesh);
    const blob = low ? createBlobShadow() : undefined;
    if (blob) scene.add(blob);
    balls[n] = { n, body: { id: n, x, z, vx: 0, vz: 0, rx: 0, rz: 0, active: true }, mesh, blob, sinking: null };
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
  setView(startView, false);
  cameraForPlacing();
});
document.querySelector('#to-menu')!.addEventListener('click', () => {
  newGame();
  state = 'menu';
  hud.hidden = true;
  startScreen.hidden = false;
  startScreen.classList.remove('leaving');
  controls.autoRotate = true;
  applyMenuOffset();
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
  guide.material.color.set(PLAYER_COLORS[current]);
}

function renderHud() {
  const tableBalls = onTable();
  document.querySelectorAll<HTMLDivElement>('.player').forEach((el) => {
    const i = Number(el.dataset.player);
    const p = players[i];
    el.classList.toggle('active', i === current);
    const left = p.group ? tableBalls.filter((n) => groupOf(n) === p.group).length : 0;
    const groupEl = el.querySelector<HTMLElement>('.group')!;
    groupEl.textContent = !p.group
      ? 'mesa abierta'
      : left > 0
        ? `${p.group} · quedan ${left}`
        : `${p.group} · ¡a por la 8!`;
    groupEl.dataset.short = !p.group ? '' : left > 0 ? `${p.group} ${left}` : '¡la 8!';
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

// En táctil: un dedo apunta / mueve la blanca, dos dedos acercan y desplazan, y se tira con el botón.
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
  else if (state === 'placing' && placementValid()) finishPlacing();
});

window.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') {
    const wasSingle = touches.size === 1 && touches.has(e.pointerId);
    touches.delete(e.pointerId);
    if (wasSingle && state === 'placing' && placementValid()) finishPlacing();
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
  if (touch) {
    setSpin(spin >= 0.5 ? -0.5 : spin + 0.25); // un toque pasa al siguiente valor y da la vuelta
  } else {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const up = (e as MouseEvent).clientY < r.top + r.height / 2;
    setSpin(spin + (up ? 0.25 : -0.25));
  }
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
/** Hueco vertical libre en pantalla (en px) entre los paneles de jugador de arriba y los controles de abajo. */
function freeRect() {
  const h = window.innerHeight;
  const panel = document.querySelector<HTMLElement>('.player[data-player="0"]');
  const top = panel?.offsetParent ? panel.getBoundingClientRect().bottom + 8 : 0;
  return { top, bottom: h - (bottomBarHeight() + 8) };
}

function fitPosition(dir: THREE.Vector3, fov: number) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  let maxX = 0.96;
  let maxY = 0.94;
  let minY = -1 + (2 * (bottomBarHeight() + 8)) / h;
  const panel = document.querySelector<HTMLElement>('.player[data-player="0"]');
  if (panel?.offsetParent) {
    if (w <= 600) {
      const f = freeRect();
      maxY = 1 - (2 * f.top) / h;
      minY = -1 + (2 * (h - f.bottom)) / h;
    } else maxX = 1 - (2 * (panel.getBoundingClientRect().right + 16)) / w;
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
/** Bolas que el jugador actual puede tocar primero: las de su grupo, la 8 si lo ha terminado, o cualquiera menos la 8 con la mesa abierta. */
function legalTargets() {
  const group = players[current].group;
  const table = onTable();
  if (!group) return table.filter((n) => n !== 8);
  const own = table.filter((n) => groupOf(n) === group);
  return own.length ? own : [8];
}

/**
 * Coloca la cámara junto a la blanca mirando hacia la bola a la que puede tirar el jugador
 * que tenga más cerca, a la altura de un jugador: la blanca en primer plano y esa bola delante.
 */
function focusCueBall() {
  const c = cueBall().body;
  let nearest: Body | null = null;
  let best = Infinity;
  for (const n of legalTargets()) {
    const b = balls[n].body;
    const d = Math.hypot(b.x - c.x, b.z - c.z);
    if (b.active && d < best) {
      best = d;
      nearest = b;
    }
  }
  // Dirección horizontal hacia esa bola (sin bolas válidas, hacia el centro de la mesa)
  const toBall = nearest ? new THREE.Vector3(nearest.x - c.x, 0, nearest.z - c.z) : new THREE.Vector3(-c.x, 0, -c.z);
  if (toBall.length() < 0.01) toBall.set(controls.target.x - camera.position.x, 0, controls.target.z - camera.position.z);
  const dist = toBall.length();
  toBall.normalize();
  // Se mira a un punto entre la blanca y la bola para que se vean las dos
  const lookDist = Math.min(0.5, dist / 2);
  const target = new THREE.Vector3(c.x + toBall.x * lookDist, 0, c.z + toBall.z * lookDist);
  const radius = window.innerWidth <= 600 ? 2.4 : 1.9;
  const elev = THREE.MathUtils.degToRad(35);
  const pos = new THREE.Vector3(
    target.x - toBall.x * radius * Math.cos(elev),
    radius * Math.sin(elev),
    target.z - toBall.z * radius * Math.cos(elev),
  );
  moveCamera(pos, target, BASE_FOV, true);
}

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
/** Vista con la que empieza la partida: en móvil, siempre la cenital. */
const startView: View = touch ? '2d' : '3d';
let view: View = startView;
/** Desde arriba; la mesa a lo largo de la pantalla según la orientación. */
function topCamera(animate: boolean) {
  const dir = camera.aspect >= 1 ? new THREE.Vector3(0, 1, 0.0001) : new THREE.Vector3(-0.0001, 1, 0);
  moveCamera(fitPosition(dir, TOP_FOV), new THREE.Vector3(), TOP_FOV, animate);
}

// Con bola en mano la cámara pasa a vista cenital solo mientras se coloca la blanca
let topForPlacing = false;
function cameraForPlacing() {
  if (view === '2d') return;
  topForPlacing = true;
  topCamera(true);
}

/** La blanca queda colocada: empieza a apuntar y la cámara vuelve a la vista elegida, junto a la blanca. */
function finishPlacing() {
  state = 'aiming';
  if (!topForPlacing) return;
  topForPlacing = false;
  if (view === 'cue') setView('cue');
  else focusCueBall();
}

function setView(v: View, animate = true) {
  topForPlacing = false;
  view = v;
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  const origin = new THREE.Vector3(0, 0, 0);
  if (v === '3d') {
    // Mesa en vertical, cámara centrada detrás de la cabecera y algo baja, como un jugador
    const elev = THREE.MathUtils.degToRad(window.innerWidth <= 600 ? 52 : 40);
    const dir = new THREE.Vector3(-Math.cos(elev), Math.sin(elev), 0.0001);
    moveCamera(fitPosition(dir, BASE_FOV), origin, BASE_FOV, animate);
  } else if (v === '2d') {
    topCamera(animate);
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

// Ventana de controles: botón ?, tecla ? y se cierra con Esc o al volver a la mesa
const helpBtn = document.querySelector<HTMLButtonElement>('#help-btn')!;
const helpPop = document.querySelector<HTMLDivElement>('#help-pop')!;
function setHelp(open: boolean) {
  helpPop.classList.toggle('open', open);
  helpBtn.setAttribute('aria-expanded', String(open));
}
helpBtn.addEventListener('click', () => {
  sounds.ui();
  setHelp(!helpPop.classList.contains('open'));
});
canvas.addEventListener('pointerdown', () => setHelp(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setHelp(false);
  if (e.key === '?') setHelp(!helpPop.classList.contains('open'));
});

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
  stopPip();
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
  // La cámara va a la blanca para el siguiente tiro (o arriba si hay que colocarla)
  if (state === 'placing') cameraForPlacing();
  else if (view === 'cue') setView('cue');
  else if (view === '3d') focusCueBall();
  else if (touch) setView('2d'); // recentra y deshace el zoom del turno anterior
}

// ---------- Bucle ----------
const tmpQ = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();

function syncMeshes(dt: number) {
  for (const b of balls) {
    if (b.blob) {
      b.blob.visible = b.mesh.visible && b.body.active && !b.sinking;
      b.blob.position.set(b.mesh.position.x, 0.0015, b.mesh.position.z);
    }
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
  shootBtn.textContent = state === 'placing' ? 'Arrastra la blanca' : state === 'charging' ? 'Suelta para tirar' : 'Mantén para tirar';

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
  setLine(guide, c.x + dx * BALL_R, c.z + dz * BALL_R, gx, gz);

  if (hit) {
    const nx = hit.x - gx;
    const nz = hit.z - gz;
    const len = Math.hypot(nx, nz) || 1;
    const ux = nx / len;
    const uz = nz / len;
    setLine(objectGuide, hit.x + ux * BALL_R, hit.z + uz * BALL_R, hit.x + ux * 0.4, hit.z + uz * 0.4);
    // La blanca sale por la tangente (sin efecto); más corta cuanto más de lleno es el golpe
    const along = dx * (nx / len) + dz * (nz / len);
    const tx = dx - along * (nx / len);
    const tz = dz - along * (nz / len);
    setLine(cueGuide, gx, gz, gx + tx * 0.25, gz + tz * 0.25);
  } else {
    objectGuide.visible = cueGuide.visible = false;
  }
}

function setLine(line: Line2, x0: number, z0: number, x1: number, z1: number) {
  line.geometry.setPositions([x0, BALL_R, z0, x1, BALL_R, z1]);
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
// Contador de FPS (media de cada medio segundo)
const fpsEl = document.querySelector<HTMLDivElement>('#fps')!;
let fpsFrames = 0;
let fpsSince = performance.now();
let loadedAt = performance.now();
let slowWindows = 0;
let fastWindows = 0;
let lastDrop = 0;
let degradeStep = low ? 2 : 0; // en calidad baja ya no hay reflejos ni sombras
const MIN_SCALE = 0.55;

/** Si faltan recursos para este equipo: primero se baja la resolución y, en el mínimo, se quitan reflejos y sombras. */
function degradeGraphics() {
  if (degradeStep === 0) {
    scene.environment = null;
    console.info('Calidad: sin reflejos de entorno');
  } else if (degradeStep === 1) {
    renderer.shadowMap.enabled = false;
    console.info('Calidad: sin sombras');
  } else return;
  degradeStep++;
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) [o.material].flat().forEach((m: THREE.Material) => (m.needsUpdate = true));
  });
}

/** Resolución dinámica: si los FPS caen se baja la resolución del lienzo; si sobran, se vuelve a subir. */
function adaptResolution(fps: number) {
  const now = performance.now();
  if (now - loadedAt < 3000) return; // el arranque compila shaders y no cuenta
  if (fps < 40) {
    fastWindows = 0;
    if (++slowWindows >= 2) {
      slowWindows = 0;
      lastDrop = now;
      if (resScale > MIN_SCALE) {
        resScale = Math.max(MIN_SCALE, resScale * 0.8);
        applyResolution();
        console.info(`Resolución dinámica: ${Math.round(resScale * 100)}%`);
      } else degradeGraphics();
    }
  } else {
    slowWindows = 0;
    if (fps >= 57 && resScale < 1 && now - lastDrop > 15000 && ++fastWindows >= 6) {
      fastWindows = 0;
      resScale = Math.min(1, resScale * 1.15);
      applyResolution();
    }
  }
}

function countFps() {
  fpsFrames++;
  const now = performance.now();
  if (now - fpsSince >= 500) {
    const fps = (fpsFrames * 1000) / (now - fpsSince);
    fpsEl.textContent = `${Math.round(fps)} FPS`;
    fpsFrames = 0;
    fpsSince = now;
    adaptResolution(fps);
  }
}

function frame() {
  countFps();
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
        startPip(shot.firstHit);
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
  updateCameraTween();
  updateZoom(dt);
  followCueBall(dt);
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
  setLampsOpacity(lampsOpacity());
  renderer.render(scene, camera);
  renderPip(dt);
  requestAnimationFrame(frame);
}

/**
 * Las lámparas se desvanecen si taparían la mesa (cámara por encima de ellas) o si la cámara
 * se acerca demasiado (para no meterse dentro). La lámpara es una barra a 1,28 m de x = -0,95 a 0,95.
 */
function lampsOpacity() {
  const p = camera.position;
  const above = 1 - THREE.MathUtils.smoothstep(p.y, 1.0, 1.5);
  const dx = Math.max(0, Math.abs(p.x) - 0.95);
  const distToLamps = Math.hypot(dx, p.y - 1.28, p.z);
  const near = THREE.MathUtils.smoothstep(distToLamps, 0.35, 0.9);
  return Math.min(above, near);
}

/** Durante el tiro la cámara acompaña suavemente a la blanca (salvo en la vista 2D). */
function followCueBall(dt: number) {
  const c = cueBall().body;
  if (state !== 'rolling' || view === '2d' || camTween || !c.active) return;
  const k = 1 - Math.exp(-dt * 2.5);
  const delta = new THREE.Vector3((c.x - controls.target.x) * k, 0, (c.z - controls.target.z) * k);
  controls.target.add(delta);
  camera.position.add(delta);
}

// ---------- Cámara de detalle (recuadro) ----------
// Cuando la blanca golpea una bola, un recuadro la sigue de cerca hasta que se para o entra.
const pipCam = new THREE.PerspectiveCamera(45, 16 / 10, 0.01, 20);
const pipEl = document.querySelector<HTMLDivElement>('#pip')!;
const pipLabel = document.querySelector<HTMLSpanElement>('#pip-label')!;
let pipBall: Ball | null = null;
let pipLinger = 0; // segundos que sigue visible tras pararse la bola
const pipDir = new THREE.Vector3(1, 0, 0);
const pipLook = new THREE.Vector3();

function startPip(n: number) {
  if (low) return; // vuelve a dibujar toda la escena: no compensa en móvil
  if (shotIsBreak) return; // en el saque no: hasta que el triángulo esté roto
  pipBall = balls[n];
  pipLinger = 1.2;
  pipLabel.textContent = `Bola ${n}`;
  pipEl.style.setProperty('--c', ballColor(n));
  pipEl.classList.add('on');
  const b = pipBall.body;
  const speed = Math.hypot(b.vx, b.vz);
  if (speed > 0) pipDir.set(b.vx / speed, 0, b.vz / speed);
  pipCam.position.set(b.x - pipDir.x * 0.45, 0.2, b.z - pipDir.z * 0.45);
  pipLook.set(b.x, 0, b.z);
}

function stopPip() {
  pipBall = null;
  pipEl.classList.remove('on');
}

function renderPip(dt: number) {
  if (!pipBall) return;
  const b = pipBall.body;
  const moving = b.active && (b.vx !== 0 || b.vz !== 0);
  if (!moving && !pipBall.sinking) {
    pipLinger -= dt;
    if (pipLinger <= 0 || state !== 'rolling') return stopPip();
  }
  // Detrás de la bola según su dirección, con suavizado para que no dé tirones en los rebotes
  const speed = Math.hypot(b.vx, b.vz);
  if (speed > 0.05) pipDir.lerp(new THREE.Vector3(b.vx / speed, 0, b.vz / speed), 1 - Math.exp(-dt * 4)).normalize();
  const m = pipBall.mesh.position;
  const k = 1 - Math.exp(-dt * 6);
  pipCam.position.lerp(new THREE.Vector3(m.x - pipDir.x * 0.45, 0.2, m.z - pipDir.z * 0.45), k);
  pipLook.lerp(new THREE.Vector3(m.x + pipDir.x * 0.15, Math.max(m.y, 0), m.z + pipDir.z * 0.15), k);
  pipCam.lookAt(pipLook);

  // Zona interior del marco (sin el borde de 2 px)
  const r = pipEl.getBoundingClientRect();
  const x = r.left + pipEl.clientLeft;
  const y = r.top + pipEl.clientTop;
  const w = pipEl.clientWidth;
  const h = pipEl.clientHeight;
  pipCam.aspect = w / h;
  pipCam.updateProjectionMatrix();

  // 1) La escena vista desde la cámara de detalle, a una textura
  const dpr = pipScale();
  if (pipTarget.width !== Math.round(w * dpr) || pipTarget.height !== Math.round(h * dpr)) {
    pipTarget.setSize(Math.round(w * dpr), Math.round(h * dpr));
  }
  renderer.shadowMap.autoUpdate = false; // las sombras ya están calculadas en este fotograma
  renderer.setRenderTarget(pipTarget);
  renderer.render(scene, pipCam);
  renderer.setRenderTarget(null);
  renderer.shadowMap.autoUpdate = true;

  // 2) Esa textura sobre la pantalla, recortada con esquinas redondeadas como el marco
  const W = window.innerWidth;
  const H = window.innerHeight;
  pipOverlayCam.right = W;
  pipOverlayCam.top = H;
  pipOverlayCam.updateProjectionMatrix();
  pipQuad.position.set(x + w / 2, H - (y + h / 2), 0);
  pipQuad.scale.set(w, h, 1);
  pipQuadMat.uniforms.size.value.set(w, h);
  renderer.autoClear = false;
  renderer.render(pipOverlay, pipOverlayCam);
  renderer.autoClear = true;
}

const pipTarget = new THREE.WebGLRenderTarget(1, 1, { samples: low ? 0 : 4 });
/** Resolución del recuadro de detalle: en calidad baja, sin multiplicar por la densidad de píxeles. */
const pipScale = () => (low ? 1 : renderer.getPixelRatio());
const pipOverlay = new THREE.Scene();
const pipOverlayCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
const pipQuadMat = new THREE.ShaderMaterial({
  uniforms: {
    map: { value: pipTarget.texture },
    size: { value: new THREE.Vector2(1, 1) },
    radius: { value: 12 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D map;
    uniform vec2 size;
    uniform float radius;
    varying vec2 vUv;
    void main() {
      // Distancia a un rectángulo redondeado (en píxeles) para recortar las esquinas con suavizado
      vec2 p = (vUv - 0.5) * size;
      vec2 q = abs(p) - (size * 0.5 - radius);
      float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
      float alpha = clamp(0.5 - d, 0.0, 1.0);
      if (alpha <= 0.0) discard;
      gl_FragColor = vec4(texture2D(map, vUv).rgb, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true,
  depthTest: false,
  depthWrite: false,
});
pipQuadMat.toneMapped = true;
const pipQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), pipQuadMat);
pipOverlay.add(pipQuad);

/** Prepara el recuadro al cargar (texturas y shaders) para que no dé un tirón la primera vez que se enciende. */
function prewarmPip() {
  const dpr = pipScale();
  pipTarget.setSize(Math.round(320 * dpr), Math.round(200 * dpr));
  pipCam.position.set(0, 0.5, 1);
  pipCam.lookAt(0, 0, 0);
  renderer.setRenderTarget(pipTarget);
  renderer.render(scene, pipCam);
  renderer.setRenderTarget(null);
  renderer.compile(pipOverlay, pipOverlayCam);
}

/**
 * En el menú la mesa se desplaza para no quedar bajo el panel: a la derecha en escritorio y
 * hacia arriba en móvil (el panel va abajo). Durante la partida no hay desplazamiento.
 */
function applyMenuOffset() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (state !== 'menu') {
    if (w <= 600) {
      // Pantalla estrecha: la mesa se centra en el hueco libre, no en el centro de la pantalla
      const f = freeRect();
      camera.setViewOffset(w, h, 0, h / 2 - (f.top + f.bottom) / 2, w, h);
    } else camera.clearViewOffset();
  } else if (w > 600) camera.setViewOffset(w, h, -w * 0.18, 0, w, h);
  else camera.setViewOffset(w, h, 0, h * 0.22, w, h);
  camera.updateProjectionMatrix();
}

let resScale = 1; // factor de resolución dinámica (1 = completa)
function applyResolution() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(pixelRatioFor(w, h) * resScale);
  renderer.setSize(w, h, false);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  applyResolution();
  camera.aspect = w / h;
  applyMenuOffset();
  // Al cambiar el tamaño de la ventana se reencuadra la vista fija actual
  if (state !== 'menu' && view !== 'cue') setView(view, false);
}
window.addEventListener('resize', resize);

const startScreen = document.querySelector<HTMLDivElement>('#start')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;
// Hoja "Cómo se juega": se cierra con la X, con Esc o tocando fuera; el foco vuelve al botón
const howSheet = document.querySelector<HTMLDivElement>('#how')!;
const howBtn = document.querySelector<HTMLButtonElement>('#how-btn')!;
const howClose = document.querySelector<HTMLButtonElement>('#how-close')!;
function setHow(open: boolean) {
  if (open === !howSheet.hidden) return;
  howSheet.hidden = !open;
  if (open) howClose.focus();
  else howBtn.focus();
}
howBtn.addEventListener('click', () => {
  unlockAudio();
  sounds.ui();
  setHow(true);
});
howClose.addEventListener('click', () => setHow(false));
howSheet.addEventListener('click', (e) => {
  if (e.target === howSheet) setHow(false);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setHow(false);
});

document.querySelector('#play')!.addEventListener('click', () => {
  unlockAudio();
  startScreen.classList.add('leaving');
  setTimeout(() => (startScreen.hidden = true), 600);
  hud.hidden = false;
  controls.autoRotate = false;
  newGame();
  resize();
  setView(startView, false);
  cameraForPlacing();
  if (touch) showMessage('Toca la mesa para colocar la blanca · pellizca para acercar');
});

if (touch) {
  // En móvil: el efecto va junto a los botones de tiro y el sonido arriba a la derecha
  const spinBtn = document.querySelector<HTMLElement>('#spin')!;
  spinBtn.classList.add('glass');
  document.querySelector('#touch-controls')!.prepend(spinBtn);
  document.querySelector('#hud')!.append(document.querySelector('#mute')!);
}

resize();
document.querySelector('#gfx-reload')!.addEventListener('click', () => location.reload());
if (new URLSearchParams(location.search).has('debug')) {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  console.info(
    `GPU: ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'n/d'} · calidad ${quality} · ratio ${renderer.getPixelRatio().toFixed(2)} · ${innerWidth}x${innerHeight}`,
  );
}
newGame();
state = 'menu';
controls.autoRotate = true;
applyMenuOffset();
camera.position.set(-2.6, 1.9, 1.8);

// Los shaders se compilan en segundo plano (KHR_parallel_shader_compile): el menú ya responde
// mientras tanto y el primer fotograma no se queda esperando a la compilación.
const compileStart = performance.now();
renderer
  .compileAsync(scene, camera)
  .catch(() => {})
  .finally(() => {
    console.info(`Shaders compilados en ${Math.round(performance.now() - compileStart)} ms`);
    clock.getDelta(); // que el primer fotograma no cuente la espera
    loadedAt = performance.now();
    frame();
    console.info(`Primer fotograma a los ${Math.round(performance.now())} ms desde que se pidió la página`);
    // El recuadro de detalle se prepara un poco después, con el menú ya en marcha
    if (!low) setTimeout(prewarmPip, 2500);
  });
