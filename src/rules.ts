// Reglas simplificadas de bola 8.
export type Group = 'lisas' | 'rayadas';

export interface Player {
  name: string;
  group: Group | null;
}

export interface ShotRecord {
  firstHit: number | null;
  potted: number[];
}

export interface ShotResult {
  foul: boolean;
  respotEight: boolean;
  keepTurn: boolean;
  winner: number | null; // índice del jugador ganador si la partida acaba
  message: string;
}

export const groupOf = (n: number): Group | null =>
  n >= 1 && n <= 7 ? 'lisas' : n >= 9 && n <= 15 ? 'rayadas' : null;

export function remainingOf(group: Group, onTable: number[]) {
  return onTable.filter((n) => groupOf(n) === group).length;
}

export function evaluateShot(
  players: Player[],
  current: number,
  shot: ShotRecord,
  onTableBefore: number[],
  isBreak: boolean,
): ShotResult {
  const p = players[current];
  const other = 1 - current;
  const cuePotted = shot.potted.includes(0);
  const eightPotted = shot.potted.includes(8);
  const clearedBefore = p.group !== null && remainingOf(p.group, onTableBefore) === 0;

  let foul = false;
  let reason = '';
  if (shot.firstHit === null) {
    foul = true;
    reason = 'No has tocado ninguna bola';
  } else if (p.group === null) {
    if (shot.firstHit === 8 && !isBreak) {
      foul = true;
      reason = 'No puedes tocar la 8 primero con la mesa abierta';
    }
  } else if (clearedBefore ? shot.firstHit !== 8 : groupOf(shot.firstHit) !== p.group) {
    foul = true;
    reason = `Tenías que tocar primero ${clearedBefore ? 'la 8' : 'una de tus bolas'}`;
  }
  if (cuePotted) {
    foul = true;
    reason = 'Blanca dentro';
  }

  const objectPotted = shot.potted.filter((n) => n !== 0 && n !== 8);

  // Saque: meter la 8 no pierde (se recoloca) y la mesa sigue abierta pase lo que pase
  if (isBreak) {
    const respotEight = eightPotted;
    const note = respotEight ? 'La 8 entra en el saque y se recoloca. ' : '';
    if (foul) {
      return { foul, respotEight, keepTurn: false, winner: null, message: `${note}Falta en el saque: ${reason}. Bola en mano para ${players[other].name}` };
    }
    if (objectPotted.length > 0 || respotEight) {
      return { foul, respotEight, keepTurn: true, winner: null, message: `${note}${p.name} sigue tirando · mesa abierta` };
    }
    return { foul, respotEight, keepTurn: false, winner: null, message: `Turno de ${players[other].name}` };
  }

  if (eightPotted) {
    const win = clearedBefore && !foul;
    return {
      foul,
      respotEight: false,
      keepTurn: false,
      winner: win ? current : other,
      message: win ? `¡${p.name} mete la 8 y gana!` : `${p.name} mete la 8 antes de tiempo. Gana ${players[other].name}`,
    };
  }

  if (!foul && p.group === null && objectPotted.length > 0) {
    p.group = groupOf(objectPotted[0]);
    players[other].group = p.group === 'lisas' ? 'rayadas' : 'lisas';
  }

  if (foul) {
    return { foul, respotEight: false, keepTurn: false, winner: null, message: `Falta: ${reason}. Bola en mano para ${players[other].name}` };
  }

  const pottedOwn = objectPotted.some((n) => groupOf(n) === p.group);
  if (pottedOwn) return { foul, respotEight: false, keepTurn: true, winner: null, message: `${p.name} sigue tirando` };
  return { foul, respotEight: false, keepTurn: false, winner: null, message: `Turno de ${players[other].name}` };
}
