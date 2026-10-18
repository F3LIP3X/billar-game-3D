import './debug';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { BALL_R, FOOT_SPOT, HEAD_SPOT, MAX_SHOT_SPEED, POCKETS, TABLE_L, TABLE_W } from './constants';
import { castCueRay, FIXED_DT, isMoving, step, type Body } from './physics';
import type { AimMsg, ChatMsg, Net, NetEvents, ShotMsg, StateMsg } from './net';
import { buildRoom, buildTable } from './table';
import { ballColor, createBallMesh, createBlobShadow, createCue } from './balls';
import { evaluateShot, groupOf, type Group, type Player, type ShotRecord } from './rules';
import { isMuted, setMuted, sounds, unlockAudio } from './audio';
import { CircleSlash, createElement, type IconNode } from 'lucide';
import { planShot, type Level } from './ai';
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
// Neutral conserva el color de las cosas; la curva filmica (ACES) quemaba el amarillo de las bolas hasta dejarlo casi blanco
renderer.toneMapping = THREE.NeutralToneMapping;
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
const { setLampsOpacity, key: keyLight } = buildRoom(scene);

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

// ---------- Multijugador online ----------
// Cada jugador calcula la misma física a partir del mismo tiro (paso fijo, determinista) y quien
// ha tirado publica al acabar el estado oficial, al que todos se ajustan.
let net: Net | null = null;
let mySeat = 0;
let gameId = 0; // partida actual: sube con cada revancha
let stateSeq = 0; // último estado oficial aplicado o publicado
let shotCounter = 0;
let aimCounter = 0;
let lastRemoteShot = 0;
let remoteShot = false; // el tiro en curso es del rival
let remoteDone = false; // ...y mi simulación ya ha terminado
let pendingState: StateMsg | null = null;
let remoteAim: AimMsg | null = null;
let lastAimSent = '';
let onlineNames: [string, string] = ['', ''];
let gameStarted = false;
let hasState = false;
let simAcc = 0; // tiempo de simulación pendiente (paso fijo)
const q6 = (v: number) => Math.round(v * 1e6) / 1e6; // así los dos lados usan exactamente los mismos números
const seatStr = () => String(mySeat) as '0' | '1';
/** ¿Puede este jugador interactuar ahora? En local siempre; online solo en su turno. */
// Contra la máquina: el jugador humano es el 0 y la máquina el 1
let vsAI = false;
let aiLevel: Level = 'normal';
let aiGen = 0; // sube al reiniciar: cancela lo que la máquina estuviera pensando
let aiBusy = false;
const AI_NAMES: Record<Level, string> = { facil: 'Máquina · fácil', normal: 'Máquina', experto: 'Máquina · experta' };
const aiTurn = () => vsAI && current === 1;
/** ¿Es este jugador la persona que está delante de la pantalla? (solo importa online o contra la máquina) */
const isMine = (i: number) => (net ? i === mySeat : vsAI ? i === 0 : false);
const canAct = () =>
  net ? current === mySeat && state !== 'rolling' && state !== 'over' && state !== 'menu' && !remoteShot : !aiTurn();
/** Quién saca: se alterna en cada partida (online según el número de partida; en local, en cada revancha). */
let localBreaker = 0;
const breakerSeat = () => (net ? (Math.max(gameId, 1) - 1) % 2 : localBreaker);
const turnText = () => (isMine(current) ? 'Tu turno' : `Turno de ${players[current].name}`);

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
    balls[n] = { n, body: { id: n, x, z, vx: 0, vz: 0, rx: 0, rz: 0, sw: 0, active: true }, mesh, blob, sinking: null };
  };

  add(0, HEAD_SPOT.x, HEAD_SPOT.z);
  const d = BALL_R * 2 * 1.002;
  let k = 0;
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) {
      add(RACK_ORDER[k++], FOOT_SPOT.x + row * d * Math.cos(Math.PI / 6), (j - row / 2) * d);
    }
  }

  players = [0, 1].map((i) => ({ name: vsAI ? (i === 0 ? 'Tú' : AI_NAMES[aiLevel]) : onlineNames[i] || `Jugador ${i + 1}`, group: null }));
  aiGen++;
  aiBusy = false;
  current = breakerSeat();
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
  announceTurn(isMine(current) ? 'Tu saque' : `Saque de ${players[current].name}`);
}

// ---------- HUD ----------
const overlay = document.querySelector<HTMLDivElement>('#overlay')!;
const messageEl = document.querySelector<HTMLDivElement>('#message')!;
const powerEl = document.querySelector<HTMLDivElement>('#power')!;
const powerFill = document.querySelector<HTMLDivElement>('#power-fill')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
function resetRematchButton() {
  restartBtn.textContent = 'Revancha';
  restartBtn.disabled = false;
}
restartBtn.addEventListener('click', () => {
  if (net) {
    // Online: la revancha empieza cuando los dos la piden
    net.setRematch(true);
    restartBtn.disabled = true;
    restartBtn.textContent = 'Esperando…';
    return;
  }
  localBreaker = 1 - localBreaker;
  newGame();
  setView(startView, false);
  cameraForPlacing();
});
document.querySelector('#to-menu')!.addEventListener('click', () => goToMenu());

function goToMenu() {
  if (net) void leaveOnline();
  vsAI = false;
  newGame();
  state = 'menu';
  hud.hidden = true;
  document.body.classList.remove('playing');
  startScreen.hidden = false;
  startScreen.classList.remove('leaving');
  controls.autoRotate = true;
  applyMenuOffset();
  moveCamera(new THREE.Vector3(-2.6, 1.9, 1.8), new THREE.Vector3(0, 0, 0), BASE_FOV, true);
}

function showVictory(winner: number, shooterWon: boolean, foul: boolean) {
  const machineWon = vsAI && winner === 1;
  document.querySelector('.victory .eyebrow')!.textContent = machineWon ? 'Gana la máquina' : vsAI ? '¡Le has ganado a la máquina!' : 'Victoria';
  const loser = 1 - winner;
  const group = players[winner].group;
  document.querySelector('#winner-name')!.textContent = `¡Gana ${players[winner].name}!`;
  document.querySelector('.victory')!.classList.toggle('long-name', players[winner].name.length > 12);
  document.querySelector('#win-reason')!.textContent = shooterWon
    ? group
      ? `Ha metido la 8 tras limpiar las ${group}`
      : 'Ha metido la 8 y gana la partida'
    : `${players[loser].name} metió la 8 ${foul ? 'con falta' : 'antes de tiempo'}`;
  document.querySelectorAll<HTMLElement>('.stats [data-col]').forEach((el) => {
    const col = Number(el.dataset.col);
    el.classList.toggle('winner', col === winner);
    if (el.tagName === 'TH') {
      el.textContent = players[col].name;
      el.title = players[col].name;
    }
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
  document.querySelector('.victory .emblem')!.classList.add('dance');
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

// ---------- Avisos de jugada ----------
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const fxLayer = document.createElement('div');
fxLayer.id = 'fx';
fxLayer.setAttribute('aria-hidden', 'true');
document.body.append(fxLayer);

function fxAdd(el: HTMLElement, ms: number) {
  fxLayer.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Aviso de cristal bajo el marcador: las bolas metidas (o un icono) y una frase corta. */
function popup(lead: number[] | IconNode, text: string, sub = '') {
  fxLayer.querySelectorAll('.fx-pop').forEach((old) => old.remove()); // solo uno a la vez
  const el = document.createElement('div');
  el.className = 'fx-pop';
  if (Array.isArray(lead) && typeof lead[0] === 'number') {
    const chips = document.createElement('span');
    chips.className = 'chips';
    for (const n of lead as number[]) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (n > 8 ? ' stripe' : '');
      chip.style.setProperty('--c', ballColor(n));
      chip.textContent = String(n);
      chips.append(chip);
    }
    el.append(chips);
  } else {
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.append(createElement(lead as IconNode, { 'stroke-width': 2 }));
    el.append(ico);
  }
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = text;
  el.append(t);
  if (sub) {
    const st = document.createElement('span');
    st.className = 's';
    st.textContent = sub;
    el.append(st);
  }
  fxAdd(el, 2300);
}

/** Onda que se expande desde la tronera con el color de la bola. */
function ripple(x: number, y: number, color: string, double = false) {
  if (reducedMotion) return;
  for (const slow of double ? [false, true] : [false]) {
    const el = document.createElement('span');
    el.className = 'fx-ring' + (slow ? ' slow' : '');
    el.style.cssText = `--x:${x}px;--y:${y}px;--c:${color}`;
    fxAdd(el, 1300);
  }
}

/** Lo que ha pasado en el tiro que acaba de terminar. */
function celebrateShot() {
  const objects = shot.potted.filter((n) => n !== 0 && n !== 8);
  const cheering = !(net || vsAI) || isMine(current);
  if (shot.potted.includes(8) && !shotIsBreak) return; // la 8 la resuelve la pantalla de victoria
  if (shot.potted.includes(0)) {
    sounds.sad();
    popup(CircleSlash, 'Blanca dentro', cheering ? 'falta' : 'falta del rival');
  } else if (objects.length) {
    sounds.boing(objects.length);
    const who = cheering ? '' : 'del rival';
    const text = shotIsBreak
      ? 'Saque con bola'
      : objects.length >= 3
        ? 'Gran racha'
        : objects.length === 2
          ? 'Doblete'
          : pick(['Dentro', 'Bien jugada', 'Limpia']);
    popup(objects, text, who);
  }
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
    el.querySelector('.name')!.textContent = p.name + (net && i === mySeat ? ' (tú)' : '');
    el.querySelector('.turn-tag')!.textContent = isMine(i) ? 'Tu turno' : 'Su turno';
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
let lastAimTurn = -1;
const PRECISION_RADIUS = 0.6; // m: por debajo de esta distancia a la blanca el ratón apunta con precisión
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function aimOrPlace(e: PointerEvent, relative: boolean) {
  if (!canAct()) return;
  const p = pointerOnTable(e);
  if (!p) return;
  const c = cueBall().body;
  if (state === 'aiming') {
    const angle = Math.atan2(p.z - c.z, p.x - c.x);
    const dist = Math.hypot(p.x - c.x, p.z - c.z);
    // Cada tiro empieza apuntando al cursor; después el giro es relativo al movimiento del cursor
    const turnKey = stats[0].shots + stats[1].shots;
    if (!relative || !lastAimPoint || turnKey !== lastAimTurn) {
      aimAngle = angle;
      lastAimTurn = turnKey;
    } else if (e.shiftKey) {
      const prev = Math.atan2(lastAimPoint.z - c.z, lastAimPoint.x - c.x);
      // Sensibilidad fija (no depende de la distancia): equivale a tener el cursor a 2 m
      aimAngle += wrapAngle(angle - prev) * Math.min(1, dist / 2) * 0.5;
    } else {
      // Precisión: cerca de la blanca un pequeño movimiento giraría mucho el taco, así que el giro se
      // reduce (de 100 % a 60 cm hasta ~4 % pegado a la bola) y solo lejos vuelve a apuntar al cursor
      const prev = Math.atan2(lastAimPoint.z - c.z, lastAimPoint.x - c.x);
      const t = THREE.MathUtils.clamp((dist - 0.08) / (PRECISION_RADIUS - 0.08), 0, 1);
      const k = 0.04 + 0.96 * t * t;
      aimAngle += wrapAngle(angle - prev) * k + wrapAngle(angle - aimAngle) * 0.08 * k * k;
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
  if (!canAct()) return;
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
    if (wasSingle && canAct() && state === 'placing' && placementValid()) finishPlacing();
    return;
  }
  if (e.button === 0 && state === 'charging') shoot();
});
window.addEventListener('pointercancel', (e) => touches.delete(e.pointerId));

function startCharge() {
  if (!canAct()) return;
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
    if (state === 'aiming' && canAct()) aimAngle += Number(btn.dataset.fine) * 0.003;
  }),
);

// ---------- Punto de golpeo ----------
// Dónde se golpea la blanca, en radios desde su centro: spin = altura (+ seguir, - retroceso) y
// side = lado (+ derecha, - izquierda). Solo se puede elegir dentro de un círculo de radio 0,5:
// más lejos del centro sería un "pifia" (el taco resbala).
let spin = 0;
let side = 0;
const HIT_MAX = 0.5;
const spinBtn = document.querySelector<HTMLButtonElement>('#spin')!;
const spinLabel = document.querySelector<HTMLSpanElement>('#spin-label')!;
const spinPop = document.querySelector<HTMLDivElement>('#spin-pop')!;
const spinPad = document.querySelector<HTMLDivElement>('#spin-pad')!;
const padLabel = document.querySelector<HTMLParagraphElement>('#pad-label')!;

function hitLabel() {
  const parts: string[] = [];
  if (spin > 0.09) parts.push('Seguir');
  if (spin < -0.09) parts.push('Retroceso');
  if (side > 0.09) parts.push('efecto derecha');
  if (side < -0.09) parts.push('efecto izquierda');
  return parts.length ? parts.join(' · ') : 'Centro';
}

/** Fija el punto de golpeo (redondeado a 0,05 y limitado al círculo permitido). */
function setHit(u: number, v: number) {
  let x = Math.round(u * 20) / 20;
  let y = Math.round(v * 20) / 20;
  const r = Math.sqrt(x * x + y * y);
  if (r > HIT_MAX + 1e-9) {
    x = Math.trunc(((x * HIT_MAX) / r) * 20) / 20;
    y = Math.trunc(((y * HIT_MAX) / r) * 20) / 20;
  }
  side = x === 0 ? 0 : x; // evita el -0
  spin = y === 0 ? 0 : y;
  for (const el of [spinBtn, spinPop]) {
    el.style.setProperty('--hx', String(side));
    el.style.setProperty('--hy', String(-spin));
  }
  const text = hitLabel();
  spinLabel.textContent = text;
  padLabel.textContent = text;
}
function setSpinPop(open: boolean) {
  spinPop.hidden = !open;
  spinBtn.setAttribute('aria-expanded', String(open));
}
spinBtn.addEventListener('click', () => {
  sounds.ui();
  setSpinPop(spinPop.hidden === true);
});
// Se cierra al tocar fuera, con Esc o al tirar
window.addEventListener('pointerdown', (e) => {
  if (!spinPop.hidden && !spinPop.contains(e.target as Node) && !spinBtn.contains(e.target as Node)) setSpinPop(false);
});
window.addEventListener('keydown', (e) => e.key === 'Escape' && setSpinPop(false));

// Arrastrar sobre la bola grande
let padDragging = false;
function padFromPointer(e: PointerEvent) {
  if (!canAct()) return;
  const r = spinPad.getBoundingClientRect();
  const u = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
  const v = -(e.clientY - (r.top + r.height / 2)) / (r.height / 2);
  // cerca del centro se pega al centro: es lo más habitual y así es fácil volver
  if (Math.sqrt(u * u + v * v) < 0.07) setHit(0, 0);
  else setHit(u, v);
}
spinPad.addEventListener('pointerdown', (e) => {
  padDragging = true;
  spinPad.setPointerCapture(e.pointerId);
  padFromPointer(e);
});
spinPad.addEventListener('pointermove', (e) => padDragging && padFromPointer(e));
spinPad.addEventListener('pointerup', () => (padDragging = false));
spinPad.addEventListener('pointercancel', () => (padDragging = false));
document.querySelector('#pad-center')!.addEventListener('click', () => canAct() && setHit(0, 0));
setHit(0, 0);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return; // escribiendo el nombre o el código
  if (state === 'aiming' && canAct()) {
    const delta = e.shiftKey ? 0.0008 : 0.004;
    if (e.key === 'ArrowLeft') aimAngle -= delta;
    if (e.key === 'ArrowRight') aimAngle += delta;
  }
  if (canAct()) {
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') setHit(side, spin + 0.1);
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') setHit(side, spin - 0.1);
    if (e.key === 'd' || e.key === 'D') setHit(side + 0.1, spin);
    if (e.key === 'a' || e.key === 'A') setHit(side - 0.1, spin);
    if (e.key === 'c' || e.key === 'C') setHit(0, 0);
  }
  if (state !== 'menu') {
    if (e.key === 'v' || e.key === 'V') chooseView('cue');
    if (e.key === '1') chooseView('3d');
    if (e.key === '2') chooseView('2d');
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
  let top = panel?.offsetParent ? panel.getBoundingClientRect().bottom + 8 : 0;
  // En pantalla estrecha la pastilla de la sala online queda debajo de los paneles: la mesa no debe tapar ni pisarla
  const pill = document.querySelector<HTMLElement>('#net-status');
  if (pill?.offsetParent && window.innerWidth <= 600) top = Math.max(top, pill.getBoundingClientRect().bottom + 8);
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
/** Ajustes del usuario que se recuerdan en este navegador. */
const SETTINGS_KEY = 'billar-settings';
function loadSettings(): { view?: View } {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function saveSetting<K extends 'view'>(key: K, value: View) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), [key]: value }));
  } catch {
    /* sin almacenamiento: no se recuerda, pero el juego sigue */
  }
}
const savedView = loadSettings().view;
const startView: View = touch ? '2d' : savedView === '2d' || savedView === 'cue' || savedView === '3d' ? savedView : '3d';
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
  lastAimPoint = null; // el primer movimiento apunta al cursor
  if (!topForPlacing) return;
  topForPlacing = false;
  if (view === 'cue') setView('cue');
  else focusCueBall();
}

/** El usuario elige una vista: se aplica y se recuerda para la próxima vez. */
function chooseView(v: View) {
  setView(v);
  if (!touch) saveSetting('view', v); // en móvil siempre es 2D
}

function setView(v: View, animate = true) {
  topForPlacing = false;
  view = v;
  controls.enableRotate = !touch && v !== '2d'; // desde arriba la mesa no gira: así no se queda torcida
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
    chooseView(b.dataset.view as View);
  }),
);

// ---------- Pantalla completa (como F11) ----------
const fsBtn = document.querySelector<HTMLButtonElement>('#fullscreen-btn')!;
function updateFullscreenBtn() {
  const on = document.fullscreenElement !== null;
  fsBtn.classList.toggle('on', on);
  fsBtn.setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Pantalla completa');
  fsBtn.title = on ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)';
}
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}
// iPhone no permite pantalla completa en páginas web: sin soporte no se muestra el botón
if (document.fullscreenEnabled) {
  fsBtn.hidden = false;
  fsBtn.addEventListener('click', () => {
    sounds.ui();
    toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', updateFullscreenBtn);
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'f' || e.key === 'F') && !(e.target instanceof HTMLInputElement) && !e.ctrlKey && !e.metaKey) toggleFullscreen();
  });
  updateFullscreenBtn();
}

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
  if (e.key === '?' && !(e.target instanceof HTMLInputElement)) setHelp(!helpPop.classList.contains('open'));
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
  if ((e.key === 'm' || e.key === 'M') && !(e.target instanceof HTMLInputElement)) toggleMute();
});
renderMute();

function placementValid() {
  const c = cueBall().body;
  return balls.every(
    (b) => b.n === 0 || !b.body.active || Math.hypot(b.body.x - c.x, b.body.z - c.z) > BALL_R * 2.05,
  );
}

/** Arranca la simulación de un tiro. Lo usan el tiro propio y el del rival (online) con los mismos datos. */
function launchShot(m: { vx: number; vz: number; rx: number; rz: number; sw: number; cx: number; cz: number; power: number }) {
  const c = cueBall().body;
  c.x = m.cx;
  c.z = m.cz;
  c.vx = m.vx;
  c.vz = m.vz;
  c.rx = m.rx;
  c.rz = m.rz;
  c.sw = m.sw;
  setHit(0, 0); // tras cada tiro el punto vuelve al centro: no se queda un efecto olvidado
  setSpinPop(false);
  sounds.cue(m.power);
  stats[current].shots++;
  shot = { firstHit: null, potted: [] };
  onTableBefore = onTable();
  shotIsBreak = isBreak;
  isBreak = false;
  state = 'rolling';
  lastAimPoint = null;
  power = 0;
  simAcc = 0;
  remoteAim = null;
}

function shoot(byAI = false) {
  if (!byAI && !canAct()) return;
  const c = cueBall().body;
  const speed = 0.25 + power * (MAX_SHOT_SPEED - 0.25);
  const vx = q6(Math.cos(aimAngle) * speed);
  const vz = q6(Math.sin(aimAngle) * speed);
  // Golpe a una altura h (en radios) sobre el centro: giro = 5·h/2 · velocidad
  const m: ShotMsg = {
    seq: ++shotCounter,
    stateSeq,
    by: seatStr(),
    vx,
    vz,
    rx: q6(vx * 2.5 * spin),
    rz: q6(vz * 2.5 * spin),
    sw: q6(2.5 * speed * side), // golpe a un lado: giro vertical con la misma regla de 5/2
    cx: q6(c.x),
    cz: q6(c.z),
    power: q6(power),
  };
  remoteShot = false;
  launchShot(m);
  net?.sendShot(m);
}

/** Estado oficial a partir del estado local. Las posiciones se redondean (y se aplican aquí también) para que todos tengan los mismos números. */
function buildState(winner: number, shooterWon: boolean, foul: boolean, message: string): StateMsg {
  const flat: number[] = [];
  for (let n = 0; n < 16; n++) {
    const b = balls[n].body;
    b.x = q6(b.x);
    b.z = q6(b.z);
    flat.push(b.x, b.z, b.active ? 1 : 0);
  }
  return {
    seq: ++stateSeq,
    gameId,
    turn: String(current) as '0' | '1',
    phase: state === 'over' ? 'over' : state === 'placing' ? 'placing' : 'aiming',
    isBreak,
    kitchenOnly,
    groups: players.map((p) => p.group ?? ''),
    balls: flat,
    stats: stats.flatMap((st) => [st.shots, st.potted, st.fouls]),
    winner,
    shooterWon,
    foul,
    message,
  };
}

function publishState(winner: number, shooterWon: boolean, foul: boolean, message: string) {
  if (net) net.sendState(buildState(winner, shooterWon, foul, message));
}

/** Aplica el estado oficial publicado por el otro jugador. */
function applyState(m: StateMsg) {
  const prevTurn = current;
  if (m.gameId !== gameId) {
    gameId = m.gameId; // partida nueva (o primera): se recoloca todo desde cero
    newGame();
    net?.setRematch(false);
    resetRematchButton();
    setView(startView, false);
  }
  stateSeq = m.seq;
  hasState = true;
  players[0].group = m.groups[0] ? (m.groups[0] as Group) : null;
  players[1].group = m.groups[1] ? (m.groups[1] as Group) : null;
  current = Number(m.turn);
  isBreak = m.isBreak;
  kitchenOnly = m.kitchenOnly;
  for (let n = 0; n < 16; n++) {
    const ball = balls[n];
    const b = ball.body;
    b.x = m.balls[n * 3];
    b.z = m.balls[n * 3 + 1];
    b.vx = b.vz = b.rx = b.rz = b.sw = 0;
    b.active = m.balls[n * 3 + 2] === 1;
    ball.sinking = null;
    ball.mesh.visible = b.active;
    ball.mesh.position.set(b.x, BALL_R, b.z);
  }
  stats = [0, 1].map((i) => ({ shots: m.stats[i * 3], potted: m.stats[i * 3 + 1], fouls: m.stats[i * 3 + 2] }));
  state = m.phase;
  remoteShot = false;
  remoteDone = false;
  pendingState = null;
  remoteAim = null;
  power = 0;
  if (m.phase === 'over') {
    renderHud();
    showVictory(m.winner, m.shooterWon, m.foul);
    return;
  }
  renderHud();
  if (m.message) showMessage(m.message);
  const turnChanged = current !== prevTurn;
  if (m.foul) sounds.foul();
  else if (turnChanged) sounds.turn();
  if (turnChanged) announceTurn(turnText());
  afterTurnCamera();
}

/** La cámara va a la blanca para el siguiente tiro (o arriba si hay que colocarla). */
function afterTurnCamera() {
  if (state === 'placing') cameraForPlacing();
  else if (view === 'cue') setView('cue');
  else if (view === '3d') focusCueBall();
  else if (touch) setView('2d'); // recentra y deshace el zoom del turno anterior
}

function endShot() {
  stopPip();
  celebrateShot();
  if (remoteShot) {
    // Tiro del rival: no se evalúa nada aquí, se espera a su estado oficial
    remoteDone = true;
    if (pendingState) applyState(pendingState);
    return;
  }
  const result = evaluateShot(players, current, shot, onTableBefore, shotIsBreak);
  const cb = cueBall();

  if (result.respotEight) respot(balls[8]);
  stats[current].potted += shot.potted.filter((n) => n !== 0).length;
  if (result.foul) stats[current].fouls++;

  if (result.winner !== null) {
    state = 'over';
    renderHud();
    showVictory(result.winner, result.winner === current, result.foul);
    publishState(result.winner, result.winner === current, result.foul, result.message);
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
  if (turnChanged) announceTurn(turnText());
  afterTurnCamera();
  publishState(-1, false, result.foul, result.message);
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
  shootBtn.disabled = !aiming || !canAct();
  // El punto de golpeo solo se toca en tu turno: si no, se cierra en vez de ignorar los toques
  spinBtn.disabled = !canAct();
  if (!canAct() && !spinPop.hidden) setSpinPop(false);
  kitchen.visible = state === 'placing' && kitchenOnly;
  shootBtn.textContent = (net || vsAI) && !canAct() && state !== 'rolling'
    ? `Turno de ${players[current].name}`
    : state === 'placing'
      ? 'Arrastra la blanca'
      : state === 'charging'
        ? 'Suelta para tirar'
        : 'Mantén para tirar';

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
  // El taco apunta paralelo a la dirección de tiro, desplazado hacia el lado elegido
  const lx = -dz * side * BALL_R;
  const lz = dx * side * BALL_R;
  cue.position.set(c.x + lx - dx * pull, BALL_R + 0.004 + spin * BALL_R, c.z + lz - dz * pull);
  cue.lookAt(c.x + lx - dx * (pull + 1), BALL_R + 0.12, c.z + lz - dz * (pull + 1));

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
  Object.assign(ball.body, { x, z: 0, vx: 0, vz: 0, rx: 0, rz: 0, sw: 0, active: true });
  ball.sinking = null;
  ball.mesh.visible = true;
}

function nearestPocket(x: number, z: number) {
  return POCKETS.reduce((a, p) => (Math.hypot(p.x - x, p.z - z) < Math.hypot(a.x - x, a.z - z) ? p : a));
}

// Tiempo entre fotogramas (THREE.Clock está obsoleto)
let lastFrameTime = performance.now();
const frameDelta = () => {
  const now = performance.now();
  const d = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  return d;
};
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

/** Sonidos, primera bola tocada y bolas metidas de un paso de simulación. */
function handleSimEvents(ev: ReturnType<typeof step>) {
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
    const v = new THREE.Vector3(pocket.x, 0.05, pocket.z).project(camera);
    ripple(((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight, body.id === 0 ? '#f6f1e4' : ballColor(body.id), body.id !== 0);
  }
  if (ev.potted.length) renderHud();
}

/** El rival apunta: se muestra su taco (suavizado) y, si coloca la blanca, el fantasma. */
function updateRemoteAim(dt: number) {
  if (!net || canAct() || !remoteAim || (state !== 'aiming' && state !== 'placing')) return;
  const m = remoteAim;
  const k = 1 - Math.exp(-dt * 14);
  aimAngle += wrapAngle(m.angle - aimAngle) * k;
  power = m.power;
  if (spin !== m.spin || side !== m.side) setHit(m.side ?? 0, m.spin);
  const c = cueBall().body;
  if (state === 'placing') {
    c.x += (m.cx - c.x) * k;
    c.z += (m.cz - c.z) * k;
    if (!m.placing) state = 'aiming'; // ya ha confirmado la posición
  }
}

/** Envía mi apuntado al rival, solo cuando cambia. */
function sendLocalAim() {
  if (!net || !canAct() || (state !== 'aiming' && state !== 'charging' && state !== 'placing')) return;
  const c = cueBall().body;
  const body = {
    angle: Math.round(aimAngle * 1e4) / 1e4,
    power: state === 'charging' ? Math.round(power * 1e3) / 1e3 : 0,
    spin,
    side,
    cx: q6(c.x),
    cz: q6(c.z),
    placing: state === 'placing',
  };
  const key = JSON.stringify(body);
  if (key === lastAimSent) return;
  if (net.sendAim({ seq: ++aimCounter, stateSeq, by: seatStr(), ...body })) lastAimSent = key;
}

/** Tope del tiempo simulado por fotograma (solo cambia en las pruebas automáticas). */
let maxFrameDt = 1 / 30;

function frame() {
  countFps();
  const dt = Math.min(frameDelta(), maxFrameDt);

  if (state === 'charging') {
    const t = ((performance.now() - chargeStart) / 1100) % 2;
    power = t < 1 ? t : 2 - t;
    powerFill.style.transform = `scaleX(${power})`;
  }

  if (state === 'rolling') {
    // Paso fijo: el mismo tiro da el mismo resultado en todos los dispositivos, vayan a los FPS que vayan
    const bodies = balls.map((b) => b.body);
    simAcc += dt;
    while (simAcc >= FIXED_DT) {
      handleSimEvents(step(bodies, FIXED_DT));
      simAcc -= FIXED_DT;
    }
  }

  updateRemoteAim(dt);
  sendLocalAim();
  aiUpdate();

  syncMeshes(dt);

  if (state === 'rolling' && !remoteDone && !isMoving(balls.map((b) => b.body)) && balls.every((b) => !b.sinking)) {
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

/** Pasa del menú a la partida (la misma transición para el modo local y el online). */
function enterGame() {
  unlockAudio();
  startScreen.classList.add('leaving');
  setTimeout(() => (startScreen.hidden = true), 600);
  hud.hidden = false;
  document.body.classList.add('playing');
  controls.autoRotate = false;
  newGame();
  resize();
  setView(startView, false);
  cameraForPlacing();
  if (touch) showMessage('Toca la mesa para colocar la blanca · pellizca para acercar');
}
document.querySelector('#play')!.addEventListener('click', () => {
  localBreaker = 0;
  vsAI = false;
  enterGame();
});

// ---------- Contra la máquina ----------
const aiSheet = document.querySelector<HTMLDivElement>('#ai-sheet')!;
const setAiSheet = (open: boolean) => (aiSheet.hidden = !open);
document.querySelector('#ai-btn')!.addEventListener('click', () => setAiSheet(true));
document.querySelector('#ai-close')!.addEventListener('click', () => setAiSheet(false));
aiSheet.addEventListener('click', (e) => e.target === aiSheet && setAiSheet(false));
window.addEventListener('keydown', (e) => e.key === 'Escape' && !aiSheet.hidden && setAiSheet(false));
aiSheet.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((btn) =>
  btn.addEventListener('click', () => {
    aiLevel = btn.dataset.level as Level;
    localBreaker = 0; // empieza sacando la persona; en las revanchas se alterna
    vsAI = true;
    setAiSheet(false);
    enterGame();
  }),
);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Turno de la máquina: piensa, coloca la blanca si hace falta, apunta a la vista del jugador y tira. */
async function runAI(gen: number) {
  const stale = () => gen !== aiGen || state === 'menu' || state === 'over';
  await sleep(state === 'placing' ? 900 : 1100);
  if (stale()) return;
  const bodies = balls.map((b) => b.body);
  const plan = await planShot({
    bodies,
    players,
    current,
    isBreak,
    ballInHand: state === 'placing',
    kitchenOnly,
    level: aiLevel,
  });
  if (stale()) return;

  if (state === 'placing' && plan.cue) {
    cueBall().body.x = plan.cue.x;
    cueBall().body.z = plan.cue.z;
    syncMeshes(0);
    await sleep(500);
    if (stale()) return;
    finishPlacing();
  }

  // El taco gira hasta el ángulo elegido y se carga la fuerza antes de soltar
  const from = aimAngle;
  const delta = wrapAngle(plan.angle - from);
  const turnMs = 450 + Math.min(500, Math.abs(delta) * 300);
  const t0 = performance.now();
  setHit(plan.side, plan.spin);
  for (let t = 0; t < turnMs; t = performance.now() - t0) {
    const k = Math.min(1, t / turnMs);
    aimAngle = from + delta * (k * k * (3 - 2 * k));
    await sleep(16);
    if (stale()) return;
  }
  aimAngle = plan.angle;
  const chargeMs = 350 + plan.power * 650;
  const c0 = performance.now();
  for (let t = 0; t < chargeMs; t = performance.now() - c0) {
    power = (t / chargeMs) * plan.power;
    await sleep(16);
    if (stale()) return;
  }
  power = plan.power;
  shoot(true);
  aiBusy = false;
}

function aiUpdate() {
  if (!aiTurn() || aiBusy || (state !== 'aiming' && state !== 'placing')) return;
  aiBusy = true;
  void runAI(aiGen);
}

// ---------- Interfaz del modo online ----------
const onlineSheet = document.querySelector<HTMLDivElement>('#online')!;
const onlineHome = document.querySelector<HTMLDivElement>('#online-home')!;
const onlineWait = document.querySelector<HTMLDivElement>('#online-wait')!;
const onlineError = document.querySelector<HTMLParagraphElement>('#online-error')!;
const nameInput = document.querySelector<HTMLInputElement>('#online-name')!;
const codeInput = document.querySelector<HTMLInputElement>('#join-code')!;
const roomCodeEl = document.querySelector<HTMLDivElement>('#room-code')!;
const waitIntro = document.querySelector<HTMLParagraphElement>('#wait-intro')!;
const waitText = document.querySelector<HTMLParagraphElement>('#wait-text')!;
const copyBtn = document.querySelector<HTMLButtonElement>('#copy-link')!;
const createBtn = document.querySelector<HTMLButtonElement>('#create-room')!;
const joinBtn = document.querySelector<HTMLButtonElement>('#join-room')!;
const netStatus = document.querySelector<HTMLDivElement>('#net-status')!;
const netText = document.querySelector<HTMLSpanElement>('#net-text')!;
const netLeave = document.querySelector<HTMLButtonElement>('#net-leave')!;
let presence: [boolean, boolean] = [false, false];
let rematchFlags: [boolean, boolean] = [false, false];

try {
  nameInput.value = localStorage.getItem('billar-name') ?? '';
} catch {
  /* sin almacenamiento */
}

function setOnlineSheet(open: boolean) {
  onlineSheet.hidden = !open;
  if (!open) return;
  onlineHome.hidden = !!net;
  onlineWait.hidden = !net;
  (net ? copyBtn : nameInput).focus();
}

function updateNetStatus() {
  if (!net) return;
  const rivalIn = presence[1 - mySeat];
  netStatus.classList.toggle('offline', !rivalIn);
  netText.textContent = rivalIn ? `Sala ${net.code}` : `Sala ${net.code} · rival desconectado`;
  if (!gameStarted) {
    waitText.classList.toggle('ready', rivalIn);
    waitText.textContent = rivalIn
      ? 'Rival conectado. Empezando…'
      : net.isHost
        ? 'Esperando al rival…'
        : 'Conectado. Esperando al anfitrión…';
  }
}

function beginOnlineGame() {
  if (gameStarted) return;
  gameStarted = true;
  vsAI = false;
  setOnlineSheet(false);
  document.body.classList.add('online');
  netStatus.hidden = false;
  enterGame();
  updateNetStatus();
}

/** El anfitrión empieza cuando el rival se ha sentado (con una pausa por si es una reconexión con partida en curso). */
function maybeStartAsHost() {
  if (!net || !net.isHost || gameStarted || !presence[0] || !presence[1]) return;
  setTimeout(() => {
    if (net && !gameStarted && !hasState && presence[0] && presence[1]) {
      gameId = 1;
      beginOnlineGame();
      publishState(-1, false, false, '');
    }
  }, 1200);
}

function handleNetState(m: StateMsg) {
  if (m.seq <= stateSeq) return; // ya aplicado (o es el mío)
  hasState = true;
  if (!gameStarted) beginOnlineGame();
  if (remoteShot && !remoteDone) {
    pendingState = m; // mi simulación del tiro del rival aún no ha terminado
    return;
  }
  applyState(m);
}

function handleNetShot(m: ShotMsg) {
  if (!gameStarted || state === 'rolling' || m.stateSeq !== stateSeq || m.stateSeq === lastRemoteShot) return;
  lastRemoteShot = m.stateSeq;
  remoteShot = true;
  remoteDone = false;
  launchShot(m);
}

function handleRematch() {
  if (!net || state !== 'over') return;
  const rival = rematchFlags[1 - mySeat];
  const me = rematchFlags[mySeat];
  restartBtn.disabled = me;
  restartBtn.textContent = me ? 'Esperando…' : rival ? 'Aceptar revancha' : 'Revancha';
  if (net.isHost && rematchFlags[0] && rematchFlags[1]) {
    gameId += 1;
    net.setRematch(false);
    resetRematchButton();
    newGame();
    setView(startView, false);
    cameraForPlacing();
    publishState(-1, false, false, '');
  }
}

// ---------- Chat ----------
const chatBtn = document.querySelector<HTMLButtonElement>('#chat-btn')!;
const chatBadge = document.querySelector<HTMLSpanElement>('#chat-badge')!;
const chatPanel = document.querySelector<HTMLElement>('#chat')!;
const chatLog = document.querySelector<HTMLDivElement>('#chat-log')!;
const chatForm = document.querySelector<HTMLFormElement>('#chat-form')!;
const chatInput = document.querySelector<HTMLInputElement>('#chat-input')!;
let chatUnread = 0;
const chatSeen = new Set<string>();

function setChat(open: boolean) {
  chatPanel.hidden = !open;
  chatBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    chatUnread = 0;
    chatBadge.hidden = true;
    chatLog.scrollTop = chatLog.scrollHeight;
    chatInput.focus();
  }
}
chatBtn.addEventListener('click', () => setChat(chatPanel.hidden === true));
chatPanel.addEventListener('keydown', (e) => {
  e.stopPropagation(); // las teclas de juego (W A S D, V, F...) no deben actuar mientras se escribe
  if (e.key === 'Escape') setChat(false);
});
window.addEventListener('keydown', (e) => {
  if (net && !(e.target instanceof HTMLInputElement) && (e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    setChat(chatPanel.hidden === true);
  }
});
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (net?.sendChat(chatInput.value)) chatInput.value = '';
});
chatPanel.querySelectorAll<HTMLButtonElement>('.chat-quick button').forEach((b) =>
  b.addEventListener('click', () => net?.sendChat(b.textContent ?? '')),
);

function addChat(m: ChatMsg) {
  if (chatSeen.has(m.id)) return;
  chatSeen.add(m.id);
  chatLog.querySelector('.chat-empty')?.remove();
  const mine = Number(m.by) === mySeat;
  const el = document.createElement('div');
  el.className = 'chat-msg' + (mine ? ' me' : '');
  if (mine) el.style.setProperty('--pc', PLAYER_COLORS[mySeat]);
  if (!mine) {
    const who = document.createElement('small');
    who.textContent = onlineNames[Number(m.by)] || 'Rival';
    el.append(who);
  }
  el.append(document.createTextNode(m.text)); // texto plano: nunca HTML
  const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
  chatLog.append(el);
  if (atBottom || mine) chatLog.scrollTop = chatLog.scrollHeight;
  if (!mine && chatPanel.hidden) {
    chatUnread++;
    chatBadge.textContent = String(chatUnread);
    chatBadge.hidden = false;
    sounds.ui();
  }
}

function resetChat() {
  setChat(false);
  chatLog.innerHTML = '<p class="chat-empty">Escribe algo a tu rival</p>';
  chatSeen.clear();
  chatUnread = 0;
  chatBadge.hidden = true;
}

const netEvents: NetEvents = {
  onChat: addChat,
  onNames(names) {
    onlineNames = names;
    players.forEach((p, i) => (p.name = names[i] || `Jugador ${i + 1}`));
    renderHud();
  },
  onPresence(p) {
    presence = p;
    updateNetStatus();
    maybeStartAsHost();
  },
  onState: handleNetState,
  onShot: handleNetShot,
  onAim(m) {
    if (gameStarted && m.stateSeq === stateSeq && current !== mySeat) remoteAim = m;
  },
  onRematch(flags) {
    rematchFlags = flags;
    handleRematch();
  },
  onClosed() {
    if (!gameStarted) {
      void leaveOnline();
      setOnlineSheet(true);
      showOnlineError('La sala ya no existe.');
    }
  },
};

function showOnlineError(text: string) {
  onlineError.textContent = text;
  onlineError.hidden = false;
}

/** Sale de la sala y deja todo listo para una partida nueva. */
async function leaveOnline() {
  const n = net;
  net = null;
  gameStarted = false;
  hasState = false;
  stateSeq = 0;
  gameId = 0;
  lastRemoteShot = 0;
  remoteShot = remoteDone = false;
  pendingState = null;
  remoteAim = null;
  lastAimSent = '';
  onlineNames = ['', ''];
  presence = [false, false];
  rematchFlags = [false, false];
  document.body.classList.remove('online');
  resetChat();
  netStatus.hidden = true;
  resetRematchButton();
  onlineHome.hidden = false;
  onlineWait.hidden = true;
  await n?.leave();
}

async function openRoom(kind: 'create' | 'join') {
  const name = nameInput.value.trim() || 'Jugador';
  try {
    localStorage.setItem('billar-name', name);
  } catch {
    /* sin almacenamiento */
  }
  onlineError.hidden = true;
  createBtn.disabled = joinBtn.disabled = true;
  unlockAudio();
  try {
    const mod = await import('./net'); // el SDK de Firebase solo se descarga al entrar en el modo online
    net =
      kind === 'create'
        ? await mod.createRoom(name, netEvents)
        : await mod.joinRoom(codeInput.value, name, netEvents);
    mySeat = net.seat;
    roomCodeEl.textContent = net.code;
    waitIntro.textContent = kind === 'create' ? 'Comparte este código con tu rival' : 'Sala encontrada';
    onlineHome.hidden = true;
    onlineWait.hidden = false;
    copyBtn.focus();
    updateNetStatus();
  } catch (e) {
    console.error(e);
    net = null;
    const { RoomError } = await import('./net');
    showOnlineError(
      e instanceof RoomError
        ? e.reason === 'missing'
          ? 'No existe ninguna sala con ese código.'
          : 'La sala ya está completa.'
        : 'No se pudo conectar. Comprueba tu conexión e inténtalo de nuevo.',
    );
  } finally {
    createBtn.disabled = joinBtn.disabled = false;
  }
}

createBtn.addEventListener('click', () => void openRoom('create'));
joinBtn.addEventListener('click', () => void openRoom('join'));
codeInput.addEventListener('input', () => (codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && void openRoom('join'));
nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && void openRoom(codeInput.value ? 'join' : 'create'));
document.querySelector('#online-btn')!.addEventListener('click', () => {
  unlockAudio();
  sounds.ui();
  setOnlineSheet(true);
});
function cancelOnline() {
  if (gameStarted) return;
  setOnlineSheet(false);
  if (net) void leaveOnline();
}
document.querySelector('#online-close')!.addEventListener('click', cancelOnline);
onlineSheet.addEventListener('click', (e) => e.target === onlineSheet && cancelOnline());
window.addEventListener('keydown', (e) => e.key === 'Escape' && !onlineSheet.hidden && cancelOnline());

copyBtn.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?sala=${net?.code ?? ''}`;
  try {
    await navigator.clipboard.writeText(url);
    copyBtn.textContent = '¡Enlace copiado!';
  } catch {
    copyBtn.textContent = url; // sin portapapeles (p. ej. HTTP): se muestra para copiarlo a mano
  }
  setTimeout(() => (copyBtn.textContent = 'Copiar enlace'), 2500);
});

// Salir de la sala en mitad de la partida: hay que pulsar dos veces
let leaveArmedAt = 0;
netLeave.addEventListener('click', () => {
  if (performance.now() - leaveArmedAt > 3000) {
    leaveArmedAt = performance.now();
    netLeave.textContent = '¿Seguro?';
    setTimeout(() => (netLeave.textContent = 'Salir'), 3000);
    return;
  }
  leaveArmedAt = 0;
  netLeave.textContent = 'Salir';
  goToMenu();
});

// Enlace de invitación: ?sala=ABCDE abre la hoja con el código ya escrito
const invited = new URLSearchParams(location.search).get('sala');
if (invited) {
  codeInput.value = invited.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  setOnlineSheet(true);
}

if (touch) {
  // En móvil: el efecto va junto a los botones de tiro y el sonido arriba a la derecha
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
    frameDelta(); // que el primer fotograma no cuente la espera
    loadedAt = performance.now();
    frame();
    console.info(`Primer fotograma a los ${Math.round(performance.now())} ms desde que se pidió la página`);
    // El recuadro de detalle se prepara un poco después, con el menú ya en marcha
    if (!low) setTimeout(prewarmPip, 2500);
  });

// Acceso para las pruebas automáticas: solo existe en desarrollo, no en la web publicada
if (import.meta.env.DEV) {
  Object.assign(window, {
    __billar: {
      get state() { return state; },
      get current() { return current; },
      get stateSeq() { return stateSeq; },
      get gameId() { return gameId; },
      get mySeat() { return mySeat; },
      canAct: () => canAct(),
      balls: () => balls.map((b) => [b.body.x, b.body.z, b.body.active ? 1 : 0]),
      groups: () => players.map((p) => p.group),
      names: () => players.map((p) => p.name),
      stats: () => stats.map((st) => [st.shots, st.potted, st.fouls]),
      fastForward: () => (maxFrameDt = 0.25),
      playWin: () => sounds.win(),
      forceOver(winner: number) {
        if (!canAct()) return false;
        state = 'over';
        renderHud();
        showVictory(winner, true, false);
        publishState(winner, true, false, '');
        return true;
      },
      place(x: number, z: number) {
        const c = cueBall().body;
        c.x = x;
        c.z = z;
      },
      confirmPlacement() {
        if (state === 'placing' && placementValid()) finishPlacing();
        return state;
      },
      // ajustes de luz para probar variantes (solo desarrollo)
      tune(o: { tone?: string; exposure?: number; spot?: number; hemi?: number; ballMul?: number; env?: number }) {
        if (o.tone) renderer.toneMapping = { aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping, agx: THREE.AgXToneMapping, none: THREE.NoToneMapping }[o.tone] ?? renderer.toneMapping;
        if (o.exposure !== undefined) renderer.toneMappingExposure = o.exposure;
        if (o.spot !== undefined) keyLight.intensity = o.spot;
        if (o.env !== undefined) scene.environmentIntensity = o.env;
        if (o.ballMul !== undefined) for (const b of balls) (b.mesh.material as THREE.MeshStandardMaterial).color.setScalar(o.ballMul);
        scene.traverse((x) => { if (x instanceof THREE.Mesh) [x.material].flat().forEach((m: THREE.Material) => (m.needsUpdate = true)); });
      },
      hit: () => [side, spin],
      // posición en pantalla (px) de cada bola, para recortar capturas
      screenBalls: () =>
        balls.map((b) => {
          const v = new THREE.Vector3(b.body.x, BALL_R, b.body.z).project(camera);
          return [Math.round(((v.x + 1) / 2) * innerWidth), Math.round(((1 - v.y) / 2) * innerHeight)];
        }),
      fire(angle: number, pw: number, sp: number, sd = 0) {
        aimAngle = angle;
        power = pw;
        setHit(sd, sp);
        shoot();
        return state;
      },
    },
  });
}
