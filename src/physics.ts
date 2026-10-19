import { BALL_R, CUSHION_W, CUSHIONS, POCKETS, TABLE_L, TABLE_W } from './constants';

export interface Body {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  // Giro de la bola expresado como "velocidad de rodadura": la velocidad que tendría si rodara
  // sin deslizar con su giro actual. Si coincide con (vx, vz) la bola rueda; si no, desliza.
  rx: number;
  rz: number;
  // Efecto lateral (giro sobre el eje vertical) como velocidad del punto de la superficie de la
  // bola: positivo = giro antihorario visto desde arriba (golpe a la derecha de la blanca).
  sw: number;
  active: boolean; // false cuando la bola ha entrado en una tronera
}

export interface StepEvents {
  ballHits: { a: Body; b: Body; speed: number }[];
  cushionHits: number[]; // velocidades de impacto
  potted: Body[];
}

// Paso de simulación fijo: la misma tirada da exactamente el mismo resultado a cualquier FPS.
export const FIXED_DT = 1 / 120;

/**
 * Longitud de un vector 2D. Se usa en lugar de Math.hypot porque este puede dar resultados
 * distintos en el último bit según el navegador, mientras que sqrt, + y * son exactos en IEEE 754.
 * Así la física es idéntica en todos los jugadores (necesario para el multijugador).
 */
function len(x: number, z: number) {
  return Math.sqrt(x * x + z * z);
}

const ROLL_DECEL = 0.2; // m/s² — resistencia a la rodadura del paño
const ROLL_DRAG = 0.2; // 1/s — frenado extra proporcional a la velocidad (el paño se hunde más con bolas rápidas)
const SLIDE_DECEL = 0.2 * 9.81; // μ·g — rozamiento bola-paño mientras desliza
const CUSHION_SPIN_KEEP = 0.5;
const CUSHION_GRIP = 0.05; // fracción de la velocidad lateral que quita el roce de la banda
const CUSHION_SPIN_GRIP = 0.2; // lo mismo para el efecto lateral: es lo que desvía la bola al rebotar
const CUSHION_MU = 0.25; // límite del roce (Coulomb) frente a la fuerza del choque
const SIDE_SPIN_DECAY = 1.6; // el paño frena el efecto lateral (m/s por segundo) // parte del giro que la banda invierte junto con la bola
const BALL_RESTITUTION = 0.95;
const CUSHION_RESTITUTION = 0.78;
const STOP_SPEED = 0.01;
const MAX_SUBSTEP_TRAVEL = BALL_R * 0.1; // ninguna bola avanza más de esto por subpaso

const HALF_L = TABLE_L / 2;
const HALF_W = TABLE_W / 2;

export function isMoving(bodies: Body[]) {
  return bodies.some((b) => b.active && (b.vx !== 0 || b.vz !== 0 || b.rx !== 0 || b.rz !== 0));
}

export function step(bodies: Body[], dt: number): StepEvents {
  const events: StepEvents = { ballHits: [], cushionHits: [], potted: [] };
  const active = bodies.filter((b) => b.active);
  const maxSpeed = Math.max(0, ...active.map((b) => len(b.vx, b.vz)));
  const substeps = Math.max(4, Math.ceil((maxSpeed * dt) / MAX_SUBSTEP_TRAVEL));
  const h = dt / substeps;

  for (let s = 0; s < substeps; s++) {
    for (const b of active) {
      if (!b.active) continue;
      integrate(b, h);
      collideCushions(b, events);
      if (checkPocket(b)) {
        b.active = false;
        b.vx = b.vz = b.rx = b.rz = b.sw = 0;
        events.potted.push(b);
      }
    }

    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        collideBalls(active[i], active[j], events);
      }
    }
  }
  return events;
}

function integrate(b: Body, h: number) {
  if (b.sw !== 0) {
    const d = SIDE_SPIN_DECAY * h;
    b.sw = Math.abs(b.sw) <= d ? 0 : b.sw - Math.sign(b.sw) * d;
  }
  const ux = b.vx - b.rx; // velocidad del punto de contacto con el paño
  const uz = b.vz - b.rz;
  const u = len(ux, uz);

  if (u > 1e-6) {
    // Deslizando: el rozamiento frena la bola y a la vez cambia su giro hasta que rueda.
    // (Para una esfera maciza el giro cambia 5/2 veces más rápido que la velocidad.)
    if (u <= 3.5 * SLIDE_DECEL * h) {
      b.vx = b.rx = (5 * b.vx + 2 * b.rx) / 7;
      b.vz = b.rz = (5 * b.vz + 2 * b.rz) / 7;
    } else {
      const k = (SLIDE_DECEL * h) / u;
      b.vx -= ux * k;
      b.vz -= uz * k;
      b.rx += 2.5 * ux * k;
      b.rz += 2.5 * uz * k;
    }
  } else {
    // Rodando: solo la resistencia a la rodadura
    const speed = len(b.vx, b.vz);
    const newSpeed = speed - (ROLL_DECEL + ROLL_DRAG * speed) * h;
    if (newSpeed < STOP_SPEED) {
      b.vx = b.vz = b.rx = b.rz = b.sw = 0;
      return;
    }
    const k = newSpeed / speed;
    b.vx = b.rx = b.vx * k;
    b.vz = b.rz = b.vz * k;
  }
  b.x += b.vx * h;
  b.z += b.vz * h;
}

// Segmentos contra los que rebota la bola: la cara de cada banda, sus puntas redondeadas y sus dos bocas.
const SEGMENTS = CUSHIONS.flatMap((line) => line.slice(1).map((p, i) => [line[i], p]));

function collideCushions(b: Body, events: StepEvents) {
  for (const [[x0, z0], [x1, z1]] of SEGMENTS) {
    // Punto del segmento más cercano al centro de la bola
    const sx = x1 - x0;
    const sz = z1 - z0;
    const t = Math.max(0, Math.min(1, ((b.x - x0) * sx + (b.z - z0) * sz) / (sx * sx + sz * sz)));
    const dx = b.x - (x0 + sx * t);
    const dz = b.z - (z0 + sz * t);
    const dist = len(dx, dz);
    if (dist >= BALL_R || dist === 0) continue;

    const nx = dx / dist;
    const nz = dz / dist;
    b.x += nx * (BALL_R - dist);
    b.z += nz * (BALL_R - dist);

    const vn = b.vx * nx + b.vz * nz;
    if (vn < 0) {
      events.cushionHits.push(-vn);
      // Rebote con pérdida en la normal. A lo largo de la banda actúa el roce: quita velocidad
      // lateral y, si la bola lleva efecto, la empuja hacia un lado (y gasta parte del efecto).
      const tnx = -nz; // tangente de la banda
      const tnz = nx;
      const vt = b.vx * tnx + b.vz * tnz;
      const pMax = CUSHION_MU * (1 + CUSHION_RESTITUTION) * -vn;
      const p = Math.max(-pMax, Math.min(pMax, -(CUSHION_GRIP * vt + CUSHION_SPIN_GRIP * b.sw)));
      b.sw += 2.5 * p; // una esfera maciza cambia su giro 5/2 veces más rápido que su velocidad
      const newVt = vt + p;
      const newVn = -vn * CUSHION_RESTITUTION;
      b.vx = newVn * nx + newVt * tnx;
      b.vz = newVn * nz + newVt * tnz;
      // La banda golpea por encima del centro y le da la vuelta a parte del giro
      const rn = b.rx * nx + b.rz * nz;
      if (rn < 0) {
        b.rx -= rn * (1 + CUSHION_SPIN_KEEP) * nx;
        b.rz -= rn * (1 + CUSHION_SPIN_KEEP) * nz;
      }
    }
  }
}

function checkPocket(b: Body) {
  for (const p of POCKETS) {
    if (len(b.x - p.x, b.z - p.z) < p.r) return true;
  }
  // Si ha pasado la línea del raíl solo puede estar dentro de una tronera
  return Math.abs(b.x) > HALF_L + CUSHION_W || Math.abs(b.z) > HALF_W + CUSHION_W;
}

function collideBalls(a: Body, b: Body, events: StepEvents) {
  if (!a.active || !b.active) return;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = len(dx, dz);
  const minDist = BALL_R * 2;
  if (dist >= minDist || dist === 0) return;

  const nx = dx / dist;
  const nz = dz / dist;

  // Separar para que no queden solapadas
  const overlap = (minDist - dist) / 2;
  a.x -= nx * overlap;
  a.z -= nz * overlap;
  b.x += nx * overlap;
  b.z += nz * overlap;

  const relVel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
  if (relVel <= 0) return;

  // Choque entre masas iguales
  const impulse = ((1 + BALL_RESTITUTION) / 2) * relVel;
  a.vx -= impulse * nx;
  a.vz -= impulse * nz;
  b.vx += impulse * nx;
  b.vz += impulse * nz;
  events.ballHits.push({ a, b, speed: relVel });
}

/** Primera bola que tocaría la bola blanca en la dirección dada (para la guía de tiro). */
export function castCueRay(cue: Body, bodies: Body[], dirX: number, dirZ: number) {
  let best = Infinity;
  let hit: Body | null = null;
  const minDist = BALL_R * 2;
  for (const b of bodies) {
    if (b === cue || !b.active) continue;
    const ox = b.x - cue.x;
    const oz = b.z - cue.z;
    const proj = ox * dirX + oz * dirZ;
    if (proj <= 0) continue;
    const perp2 = ox * ox + oz * oz - proj * proj;
    if (perp2 > minDist * minDist) continue;
    const t = proj - Math.sqrt(minDist * minDist - perp2);
    if (t < best) {
      best = t;
      hit = b;
    }
  }

  // Si no toca ninguna bola, hasta la banda
  if (!hit) {
    const tx = dirX !== 0 ? ((Math.sign(dirX) * (HALF_L - BALL_R) - cue.x) / dirX) : Infinity;
    const tz = dirZ !== 0 ? ((Math.sign(dirZ) * (HALF_W - BALL_R) - cue.z) / dirZ) : Infinity;
    best = Math.min(tx, tz);
  }
  return { distance: best, hit };
}
