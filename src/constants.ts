// Medidas reales de una mesa de pool de 9 pies, en metros.
export const TABLE_L = 2.54;
export const TABLE_W = 1.27;
export const BALL_R = 0.028575;

export const CUSHION_W = 0.09; // fondo de la banda (de la línea de juego al raíl)
export const RAIL_W = 0.13;
export const CORNER_GAP = 0.08; // de la esquina a la punta de la banda, en cada lado de la tronera
export const SIDE_GAP = 0.062; // media boca de las troneras centrales
const JAW_BACK = 0.02; // cuánto pasa la trasera de la banda de la esquina: las bocas se estrechan hacia dentro

const HL = TABLE_L / 2;
const HW = TABLE_W / 2;
const O = CUSHION_W;

// Agujeros: los de esquina centrados en la esquina del raíl, los centrales metidos en el raíl.
export const POCKETS = [
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ x: sx * (HL + O), z: sz * (HW + O), r: 0.065 }))),
  ...[-1, 1].map((sz) => ({ x: 0, z: sz * (HW + O + 0.01), r: 0.055 })),
];

type P = [number, number]; // (x, z)
/**
 * Bandas en planta: [puntaA, puntaB, traseraB, traseraA].
 * La cara de juego es puntaA→puntaB; los lados puntaB→traseraB y traseraA→puntaA son las bocas.
 */
export const CUSHIONS: P[][] = [
  ...[-1, 1].flatMap((sz): P[][] => [
    [[-HL + CORNER_GAP, sz * HW], [-SIDE_GAP, sz * HW], [-SIDE_GAP, sz * (HW + O)], [-HL - JAW_BACK, sz * (HW + O)]],
    [[SIDE_GAP, sz * HW], [HL - CORNER_GAP, sz * HW], [HL + JAW_BACK, sz * (HW + O)], [SIDE_GAP, sz * (HW + O)]],
  ]),
  ...[-1, 1].map((sx): P[] => [
    [sx * HL, -HW + CORNER_GAP], [sx * HL, HW - CORNER_GAP], [sx * (HL + O), HW + JAW_BACK], [sx * (HL + O), -HW - JAW_BACK],
  ]),
];

export const HEAD_SPOT = { x: -TABLE_L / 4, z: 0 };
export const FOOT_SPOT = { x: TABLE_L / 4, z: 0 };

export const MAX_SHOT_SPEED = 6.5;
