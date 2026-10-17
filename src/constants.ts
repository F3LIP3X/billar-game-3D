// Medidas reales de una mesa de pool de 9 pies, en metros.
export const TABLE_L = 2.54;
export const TABLE_W = 1.27;
export const BALL_R = 0.028575;

export const CUSHION_W = 0.09; // fondo de la banda (de la línea de juego al raíl)
export const RAIL_W = 0.13;
export const CORNER_GAP = 0.07; // boca de las troneras de esquina, medida sobre cada banda
export const SIDE_GAP = 0.062; // media boca de las troneras centrales

export const POCKETS = [
  { x: -TABLE_L / 2 - 0.012, z: -TABLE_W / 2 - 0.012, r: 0.062 },
  { x: TABLE_L / 2 + 0.012, z: -TABLE_W / 2 - 0.012, r: 0.062 },
  { x: -TABLE_L / 2 - 0.012, z: TABLE_W / 2 + 0.012, r: 0.062 },
  { x: TABLE_L / 2 + 0.012, z: TABLE_W / 2 + 0.012, r: 0.062 },
  { x: 0, z: -TABLE_W / 2 - 0.03, r: 0.056 },
  { x: 0, z: TABLE_W / 2 + 0.03, r: 0.056 },
];

export const HEAD_SPOT = { x: -TABLE_L / 4, z: 0 };
export const FOOT_SPOT = { x: TABLE_L / 4, z: 0 };

export const MAX_SHOT_SPEED = 6.5;
