// Medidas reales de una mesa de pool de 9 pies, en metros.
export const TABLE_L = 2.54;
export const TABLE_W = 1.27;
export const BALL_R = 0.028575;

export const CUSHION_W = 0.09; // fondo de la banda (de la línea de juego al raíl)
export const RAIL_W = 0.13;
export const CORNER_GAP = 0.08; // de la esquina a la punta de la banda, en cada lado de la tronera
export const SIDE_GAP = 0.062; // media boca de las troneras centrales
const JAW_BACK = 0.02; // cuánto pasa la trasera de la banda de la esquina: las bocas se estrechan hacia dentro
const SIDE_FLARE = 0.014; // las bocas centrales se abren hacia el agujero (≈100°), no son un pasillo recto

const HL = TABLE_L / 2;
const HW = TABLE_W / 2;
const O = CUSHION_W;

// El agujero empieza justo detrás de la boca: la bola cae en cuanto pasa las puntas de las bandas.
export const POCKETS = [
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ x: sx * (HL + 0.045), z: sz * (HW + 0.045), r: 0.065 }))),
  ...[-1, 1].map((sz) => ({ x: 0, z: sz * (HW + 0.06), r: 0.056 })),
];

type P = [number, number]; // (x, z)
const JAW_R = 0.022; // radio con el que la punta de la banda se curva hacia la tronera

/** Redondea la esquina V (entre los lados que van a A y a B) con un arco tangente a ambos. */
function fillet(a: P, v: P, b: P, r: number, steps = 10): P[] {
  const ul = Math.hypot(a[0] - v[0], a[1] - v[1]);
  const wl = Math.hypot(b[0] - v[0], b[1] - v[1]);
  const u = [(a[0] - v[0]) / ul, (a[1] - v[1]) / ul];
  const w = [(b[0] - v[0]) / wl, (b[1] - v[1]) / wl];
  const half = Math.acos(u[0] * w[0] + u[1] * w[1]) / 2;
  const t = r / Math.tan(half); // de la esquina a donde empieza el arco
  const bl = Math.hypot(u[0] + w[0], u[1] + w[1]);
  const d = r / Math.sin(half);
  const c = [v[0] + ((u[0] + w[0]) / bl) * d, v[1] + ((u[1] + w[1]) / bl) * d];
  const a0 = Math.atan2(v[1] + u[1] * t - c[1], v[0] + u[0] * t - c[0]);
  let da = Math.atan2(v[1] + w[1] * t - c[1], v[0] + w[0] * t - c[0]) - a0;
  if (da > Math.PI) da -= Math.PI * 2;
  if (da < -Math.PI) da += Math.PI * 2;
  const out: P[] = [];
  for (let k = 0; k <= steps; k++) {
    const ang = a0 + (da * k) / steps;
    out.push([c[0] + Math.cos(ang) * r, c[1] + Math.sin(ang) * r]);
  }
  return out;
}

/**
 * Bandas en planta, de [puntaA, puntaB, traseraB, traseraA] a una línea abierta
 * traseraA → punta A redondeada → cara de juego → punta B redondeada → traseraB.
 * La bola choca con toda la línea; el lado trasero (traseraB→traseraA) queda contra el raíl.
 */
const rounded = ([a, b, bb, ba]: P[]): P[] => [ba, ...fillet(ba, a, b, JAW_R), ...fillet(a, b, bb, JAW_R), bb];

export const CUSHIONS: P[][] = [
  ...[-1, 1].flatMap((sz): P[][] => [
    [[-HL + CORNER_GAP, sz * HW], [-SIDE_GAP, sz * HW], [-SIDE_GAP - SIDE_FLARE, sz * (HW + O)], [-HL - JAW_BACK, sz * (HW + O)]],
    [[SIDE_GAP, sz * HW], [HL - CORNER_GAP, sz * HW], [HL + JAW_BACK, sz * (HW + O)], [SIDE_GAP + SIDE_FLARE, sz * (HW + O)]],
  ]),
  ...[-1, 1].map((sx): P[] => [
    [sx * HL, -HW + CORNER_GAP], [sx * HL, HW - CORNER_GAP], [sx * (HL + O), HW + JAW_BACK], [sx * (HL + O), -HW - JAW_BACK],
  ]),
].map(rounded);

export const HEAD_SPOT = { x: -TABLE_L / 4, z: 0 };
export const FOOT_SPOT = { x: TABLE_L / 4, z: 0 };

export const MAX_SHOT_SPEED = 6.5;
