import { BALL_R, CUSHION_W, CUSHIONS, POCKETS, TABLE_L, TABLE_W } from './constants';

export interface Body {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  active: boolean; // false cuando la bola ha entrado en una tronera
}

export interface StepEvents {
  ballHits: { a: Body; b: Body; speed: number }[];
  cushionHits: number[]; // velocidades de impacto
  potted: Body[];
}

const ROLL_DECEL = 0.18; // m/s² — resistencia a la rodadura del paño
const BALL_RESTITUTION = 0.95;
const CUSHION_RESTITUTION = 0.78;
const STOP_SPEED = 0.004;
const MAX_SUBSTEP_TRAVEL = BALL_R * 0.1; // ninguna bola avanza más de esto por subpaso

const HALF_L = TABLE_L / 2;
const HALF_W = TABLE_W / 2;

export function isMoving(bodies: Body[]) {
  return bodies.some((b) => b.active && (b.vx !== 0 || b.vz !== 0));
}

export function step(bodies: Body[], dt: number): StepEvents {
  const events: StepEvents = { ballHits: [], cushionHits: [], potted: [] };
  const active = bodies.filter((b) => b.active);
  const maxSpeed = Math.max(0, ...active.map((b) => Math.hypot(b.vx, b.vz)));
  const substeps = Math.max(4, Math.ceil((maxSpeed * dt) / MAX_SUBSTEP_TRAVEL));
  const h = dt / substeps;

  for (let s = 0; s < substeps; s++) {
    for (const b of active) {
      if (!b.active) continue;
      integrate(b, h);
      collideCushions(b, events);
      if (checkPocket(b)) {
        b.active = false;
        b.vx = b.vz = 0;
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
  const speed = Math.hypot(b.vx, b.vz);
  if (speed === 0) return;
  const newSpeed = speed - ROLL_DECEL * h;
  if (newSpeed < STOP_SPEED) {
    b.vx = b.vz = 0;
    return;
  }
  const k = newSpeed / speed;
  b.vx *= k;
  b.vz *= k;
  b.x += b.vx * h;
  b.z += b.vz * h;
}

// Segmentos contra los que rebota la bola: la cara de cada banda y sus dos bocas.
const SEGMENTS = CUSHIONS.flatMap(([a, b, bb, ba]) => [
  [a, b],
  [b, bb],
  [ba, a],
]);

function collideCushions(b: Body, events: StepEvents) {
  for (const [[x0, z0], [x1, z1]] of SEGMENTS) {
    // Punto del segmento más cercano al centro de la bola
    const sx = x1 - x0;
    const sz = z1 - z0;
    const t = Math.max(0, Math.min(1, ((b.x - x0) * sx + (b.z - z0) * sz) / (sx * sx + sz * sz)));
    const dx = b.x - (x0 + sx * t);
    const dz = b.z - (z0 + sz * t);
    const dist = Math.hypot(dx, dz);
    if (dist >= BALL_R || dist === 0) continue;

    const nx = dx / dist;
    const nz = dz / dist;
    b.x += nx * (BALL_R - dist);
    b.z += nz * (BALL_R - dist);

    const vn = b.vx * nx + b.vz * nz;
    if (vn < 0) {
      events.cushionHits.push(-vn);
      // Rebote con pérdida en la normal y algo de rozamiento en la tangente
      const tx = b.vx - vn * nx;
      const tz = b.vz - vn * nz;
      b.vx = tx * 0.95 - vn * CUSHION_RESTITUTION * nx;
      b.vz = tz * 0.95 - vn * CUSHION_RESTITUTION * nz;
    }
  }
}

function checkPocket(b: Body) {
  for (const p of POCKETS) {
    if (Math.hypot(b.x - p.x, b.z - p.z) < p.r) return true;
  }
  // Si ha pasado la línea del raíl solo puede estar dentro de una tronera
  return Math.abs(b.x) > HALF_L + CUSHION_W || Math.abs(b.z) > HALF_W + CUSHION_W;
}

function collideBalls(a: Body, b: Body, events: StepEvents) {
  if (!a.active || !b.active) return;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
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
