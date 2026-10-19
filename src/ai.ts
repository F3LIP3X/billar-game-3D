// Rival controlado por el ordenador. Sin DOM ni Three: usa la misma física y las mismas reglas que
// la partida, así que prueba cada tiro candidato simulándolo de verdad y se queda con el mejor.
import { BALL_R, FOOT_SPOT, HEAD_SPOT, MAX_SHOT_SPEED, POCKETS, TABLE_L, TABLE_W } from './constants';
import { FIXED_DT, isMoving, step, type Body } from './physics';
import { evaluateShot, groupOf, type Player } from './rules';

export type Level = 'facil' | 'normal' | 'experto';

export interface AiInput {
  bodies: Body[]; // indexadas por número de bola (0 = blanca)
  players: Player[];
  current: number;
  isBreak: boolean;
  ballInHand: boolean; // hay que colocar la blanca
  kitchenOnly: boolean;
  level: Level;
}

export interface AiShot {
  angle: number;
  power: number; // 0..1, como el medidor de fuerza
  spin: number;
  side: number;
  cue?: { x: number; z: number }; // dónde coloca la blanca, si tenía bola en mano
}

interface Profile {
  candidates: number; // tiros que se prueban en simulación
  refine: number; // los mejores se prueban otra vez con distinta fuerza y efecto
  leave: boolean; // valora cómo deja la mesa (la siguiente bola propia y lo fácil que lo deja al rival)
  angleNoise: number; // desviación del ángulo al ejecutar (radianes)
  powerNoise: number; // desviación relativa de la fuerza
  pickAmong: number; // elige al azar entre los N mejores
}

const PROFILES: Record<Level, Profile> = {
  facil: { candidates: 4, refine: 0, leave: false, angleNoise: (3 * Math.PI) / 180, powerNoise: 0.15, pickAmong: 3 },
  normal: { candidates: 16, refine: 3, leave: true, angleNoise: (0.8 * Math.PI) / 180, powerNoise: 0.06, pickAmong: 1 },
  experto: { candidates: 30, refine: 7, leave: true, angleNoise: (0.15 * Math.PI) / 180, powerNoise: 0.02, pickAmong: 1 },
};

const HALF_L = TABLE_L / 2;
const HALF_W = TABLE_W / 2;
const D = BALL_R * 2;
const MAX_SIM_STEPS = 120 * 14;

const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface Candidate {
  cue: { x: number; z: number };
  angle: number;
  power: number;
  geo: number; // dificultad geométrica (menor = más fácil)
}

/** Distancia del punto (px, pz) al segmento a→b. */
function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function blocked(bodies: Body[], ax: number, az: number, bx: number, bz: number, ignore: number[], clearance: number) {
  return bodies.some((b) => b.active && !ignore.includes(b.id) && distToSegment(b.x, b.z, ax, az, bx, bz) < clearance);
}

function legalTargets(bodies: Body[], player: Player, isBreak: boolean) {
  const table = bodies.filter((b) => b.active && b.id !== 0).map((b) => b.id);
  if (!player.group) return table.filter((n) => n !== 8 || isBreak);
  const own = table.filter((n) => groupOf(n) === player.group);
  return own.length ? own : table.includes(8) ? [8] : [];
}

function validCue(bodies: Body[], x: number, z: number, kitchenOnly: boolean) {
  const maxX = kitchenOnly ? HEAD_SPOT.x : HALF_L - BALL_R * 1.5;
  if (x < -HALF_L + BALL_R * 1.5 || x > maxX || Math.abs(z) > HALF_W - BALL_R * 1.5) return false;
  return bodies.every((b) => b.id === 0 || !b.active || Math.hypot(b.x - x, b.z - z) > D * 1.1);
}

/** Punto al que apuntar en una tronera: algo hacia dentro para entrar por el centro de la boca. */
function pocketAim(p: { x: number; z: number }) {
  const len = Math.hypot(p.x, p.z) || 1;
  return { x: p.x - (p.x / len) * 0.035, z: p.z - (p.z / len) * 0.035 };
}

function candidatesFor(bodies: Body[], origins: { x: number; z: number }[], targets: number[]): Candidate[] {
  const out: Candidate[] = [];
  for (const n of targets) {
    const t = bodies[n];
    for (const pocket of POCKETS) {
      const pa = pocketAim(pocket);
      const ux = pa.x - t.x;
      const uz = pa.z - t.z;
      const ul = Math.hypot(ux, uz);
      const nx = ux / ul;
      const nz = uz / ul;
      const gx = t.x - nx * D; // donde debe estar la blanca al chocar
      const gz = t.z - nz * D;
      if (Math.abs(gx) > HALF_L || Math.abs(gz) > HALF_W) continue;
      if (blocked(bodies, t.x, t.z, pa.x, pa.z, [0, n], D * 0.98)) continue;
      for (const o of origins) {
        const dx = gx - o.x;
        const dz = gz - o.z;
        const dl = Math.hypot(dx, dz);
        if (dl < 0.05) continue;
        const cos = (dx * nx + dz * nz) / dl;
        if (cos < 0.3) continue; // corte demasiado cerrado
        if (blocked(bodies, o.x, o.z, gx, gz, [0, n], D * 0.98)) continue;
        const dist = dl + ul;
        const power = Math.min(0.8, Math.max(0.2, 0.16 + 0.2 * dist));
        out.push({ cue: o, angle: Math.atan2(dz, dx), power, geo: dist + (1 - cos) * 2.5 });
      }
    }
  }
  return out.sort((a, b) => a.geo - b.geo);
}

/** Dificultad del tiro más fácil que tendría ese jugador con la mesa tal como está (Infinity = ninguno). */
function bestGeo(bodies: Body[], player: Player) {
  if (!bodies[0].active) return Infinity;
  const targets = legalTargets(bodies, player, false);
  const c = candidatesFor(bodies, [{ x: bodies[0].x, z: bodies[0].z }], targets);
  return c.length ? c[0].geo : Infinity;
}

/** Juega el tiro en una copia de la mesa y lo puntúa con las mismas reglas de la partida. */
function score(input: AiInput, c: { cue: { x: number; z: number }; angle: number; power: number }, spin: number, side: number, leave: boolean) {
  const bodies = input.bodies.map((b) => ({ ...b }));
  const cue = bodies[0];
  cue.x = c.cue.x;
  cue.z = c.cue.z;
  cue.active = true;
  const speed = 0.25 + c.power * (MAX_SHOT_SPEED - 0.25);
  cue.vx = Math.cos(c.angle) * speed;
  cue.vz = Math.sin(c.angle) * speed;
  cue.rx = cue.vx * 2.5 * spin;
  cue.rz = cue.vz * 2.5 * spin;
  cue.sw = 2.5 * speed * side;

  const before = bodies.filter((b) => b.active && b.id !== 0).map((b) => b.id);
  const rec: { firstHit: number | null; potted: number[] } = { firstHit: null, potted: [] };
  for (let i = 0; i < MAX_SIM_STEPS && isMoving(bodies); i++) {
    const ev = step(bodies, FIXED_DT);
    if (rec.firstHit === null) {
      const h = ev.ballHits.find((e) => e.a.id === 0 || e.b.id === 0);
      if (h) rec.firstHit = h.a.id === 0 ? h.b.id : h.a.id;
    }
    for (const p of ev.potted) rec.potted.push(p.id);
  }

  const players = input.players.map((p) => ({ ...p }));
  const r = evaluateShot(players, input.current, rec, before, input.isBreak);
  if (r.winner === input.current) return 10000;
  if (r.winner !== null) return -10000;
  let s = 0;
  if (leave && !r.foul) {
    if (r.keepTurn) {
      // Sigue tirando: vale más dejarse una bola fácil
      const g = bestGeo(bodies, players[input.current]);
      s += g === Infinity ? -40 : 70 / (1 + g * 1.5);
    } else if (players[1 - input.current].group || bodies.filter((b) => b.active && b.id).length) {
      // Pasa el turno: vale más dejar al rival sin tiro fácil
      const g = bestGeo(bodies, players[1 - input.current]);
      s -= g === Infinity ? 0 : 45 / (1 + g * 1.5);
    }
  }
  for (const n of rec.potted) {
    if (n === 0 || n === 8) continue;
    const mine = input.players[input.current].group;
    s += mine && groupOf(n) !== mine ? -80 : 100;
  }
  if (r.foul) s -= 400;
  if (r.keepTurn) s += 60;
  return s;
}

/** Posición de la blanca y tiro de saque. */
function breakShot(input: AiInput): AiShot {
  const z = (Math.random() - 0.5) * 0.3;
  const x = HEAD_SPOT.x;
  const angle = Math.atan2(FOOT_SPOT.z - z, FOOT_SPOT.x - x);
  return { angle, power: input.level === 'facil' ? 0.7 : 0.92, spin: 0, side: 0, cue: { x, z } };
}

export async function planShot(input: AiInput): Promise<AiShot> {
  if (input.isBreak && input.ballInHand) return breakShot(input);

  const profile = PROFILES[input.level];
  const { bodies } = input;
  const targets = legalTargets(bodies, input.players[input.current], input.isBreak);

  // Dónde puede estar la blanca: donde ya está, o (con bola en mano) un abanico de sitios
  let origins: { x: number; z: number }[];
  if (input.ballInHand) {
    origins = [];
    const maxX = input.kitchenOnly ? HEAD_SPOT.x : HALF_L - 0.1;
    for (let x = -HALF_L + 0.12; x <= maxX; x += 0.22) {
      for (let z = -HALF_W + 0.12; z <= HALF_W - 0.1; z += 0.2) if (validCue(bodies, x, z, input.kitchenOnly)) origins.push({ x, z });
    }
    // Detrás de cada bola objetivo, en línea recta con alguna tronera
    for (const n of targets) {
      for (const pocket of POCKETS) {
        const pa = pocketAim(pocket);
        const ux = pa.x - bodies[n].x;
        const uz = pa.z - bodies[n].z;
        const ul = Math.hypot(ux, uz);
        for (const back of [0.3, 0.55]) {
          const x = bodies[n].x - (ux / ul) * (D + back);
          const z = bodies[n].z - (uz / ul) * (D + back);
          if (validCue(bodies, x, z, input.kitchenOnly)) origins.push({ x, z });
        }
      }
    }
    if (!origins.length) origins.push({ x: HEAD_SPOT.x - 0.3, z: 0 });
  } else {
    origins = [{ x: bodies[0].x, z: bodies[0].z }];
  }

  const geo = candidatesFor(bodies, origins, targets).slice(0, profile.candidates);
  // Tiros de seguridad: tocar la bola legal con suavidad, desde donde haya línea limpia
  const base = origins[0];
  const safe: Candidate[] = targets
    .map((n) => ({ n, d: Math.hypot(bodies[n].x - base.x, bodies[n].z - base.z) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4)
    .flatMap(({ n }) => {
      const o = origins.find((q) => !blocked(bodies, q.x, q.z, bodies[n].x, bodies[n].z, [0, n], D * 0.98)) ?? base;
      const angle = Math.atan2(bodies[n].z - o.z, bodies[n].x - o.x);
      return [0.25, 0.4].map((power) => ({ cue: o, angle, power, geo: 99 }));
    });

  const tried: { c: Candidate; spin: number; s: number }[] = [];
  const trySim = async (c: Candidate, power: number, spin: number) => {
    const cand = { ...c, power: Math.min(1, Math.max(0.1, power)) };
    // También se prueba un poco desviado a cada lado (el error con el que va a tirar): así descarta
    // los tiros que solo entran rozando la punta de la banda y elige los que entran por el centro de la boca.
    const d = Math.max(profile.angleNoise, (0.25 * Math.PI) / 180);
    let s = score(input, cand, spin, 0, profile.leave);
    if (s > 0 && c.geo < 99) {
      const left = score(input, { ...cand, angle: cand.angle - d }, spin, 0, false);
      const right = score(input, { ...cand, angle: cand.angle + d }, spin, 0, false);
      s = s * 0.5 + Math.min(left, right) * 0.5;
    }
    tried.push({ c: cand, spin, s: s - c.geo * 0.5 });
    await tick(); // que la partida no se congele mientras piensa
  };
  for (const c of [...geo, ...safe]) await trySim(c, c.power, 0);

  // Los mejores se repiten con otra fuerza y con efecto de seguir o de retroceso, que cambian dónde queda la blanca
  const top = [...tried].sort((a, b) => b.s - a.s).slice(0, profile.refine);
  for (const t of top) {
    for (const k of [0.7, 1.3, 1.6]) await trySim(t.c, t.c.power * k, t.spin);
    for (const sp of [0.35, -0.35]) await trySim(t.c, t.c.power, sp);
  }
  tried.sort((a, b) => b.s - a.s);
  const pick = tried[Math.floor(Math.random() * Math.min(profile.pickAmong, tried.length))] ?? {
    c: { cue: base, angle: 0, power: 0.4, geo: 0 },
    spin: 0,
  };

  // La ejecución no es perfecta: más error cuanto más fácil es el nivel
  const angle = pick.c.angle + gauss() * profile.angleNoise;
  const power = Math.min(1, Math.max(0.12, pick.c.power * (1 + gauss() * profile.powerNoise)));
  return { angle, power, spin: pick.spin, side: 0, cue: input.ballInHand ? pick.c.cue : undefined };
}
