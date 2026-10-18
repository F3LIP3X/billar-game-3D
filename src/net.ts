// Multijugador online sobre Firebase Realtime Database.
//
// Modelo: cada jugador calcula la misma física (determinista, paso fijo) a partir del mismo
// tiro, y el jugador que ha tirado publica al acabar el estado oficial (posiciones, turno,
// grupos...) al que todos se ajustan. La base de datos solo transporta mensajes; las reglas
// (database.rules.json) limitan quién puede escribir qué.
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  get,
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  remove,
  serverTimestamp,
  set,
  type Database,
  type Unsubscribe,
} from 'firebase/database';
import { firebaseConfig } from './firebase-config';

/** Estado oficial de la partida, publicado por quien ha tirado. Sin nulos: Firebase no los guarda. */
export interface StateMsg {
  seq: number;
  gameId: number; // partida (sube con cada revancha)
  turn: '0' | '1'; // quién tira ahora (texto: las reglas lo usan como clave)
  phase: 'placing' | 'aiming' | 'over';
  isBreak: boolean;
  kitchenOnly: boolean;
  groups: ('lisas' | 'rayadas' | '')[]; // por jugador; '' = mesa abierta
  balls: number[]; // 16 bolas × [x, z, activa(1/0)]
  stats: number[]; // 2 jugadores × [tiros, bolas metidas, faltas]
  winner: number; // -1 si nadie
  shooterWon: boolean;
  foul: boolean;
  message: string;
}

export interface ShotMsg {
  seq: number;
  stateSeq: number; // estado desde el que se tira
  by: '0' | '1';
  vx: number;
  vz: number;
  rx: number;
  rz: number;
  sw: number; // efecto lateral
  cx: number; // posición de la blanca al tirar
  cz: number;
  power: number;
}

export interface AimMsg {
  seq: number;
  stateSeq: number;
  by: '0' | '1';
  angle: number;
  power: number;
  spin: number; // altura del golpe (seguir / retroceso)
  side: number; // lado del golpe (efecto izquierda / derecha)
  cx: number;
  cz: number;
  placing: boolean; // sigue colocando la blanca (aún no ha confirmado)
}

export interface NetEvents {
  onNames(names: [string, string]): void;
  onPresence(present: [boolean, boolean]): void;
  onState(msg: StateMsg): void;
  onShot(msg: ShotMsg): void;
  onAim(msg: AimMsg): void;
  onRematch(flags: [boolean, boolean]): void;
  onClosed(): void;
}

export interface Net {
  code: string;
  seat: 0 | 1;
  isHost: boolean;
  sendState(msg: StateMsg): void;
  sendShot(msg: ShotMsg): void;
  /** Devuelve false si se ha descartado por ir demasiado rápido. */
  sendAim(msg: AimMsg): boolean;
  setRematch(on: boolean): void;
  leave(): Promise<void>;
}

// Sin 0/O ni 1/I para que el código se pueda dictar sin confusiones
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LENGTH);

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

let dbPromise: Promise<{ db: Database; uid: string }> | null = null;
function connect() {
  dbPromise ??= (async () => {
    const app = initializeApp(firebaseConfig);
    const cred = await signInAnonymously(getAuth(app));
    return { db: getDatabase(app), uid: cred.user.uid };
  })();
  return dbPromise;
}

const cleanName = (n: string) => n.trim().slice(0, 20) || 'Jugador';

export async function createRoom(name: string, ev: NetEvents): Promise<Net> {
  const { db, uid } = await connect();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    if ((await get(ref(db, `rooms/${code}/host`))).exists()) continue;
    await set(ref(db, `rooms/${code}`), {
      host: uid,
      createdAt: serverTimestamp(),
      seats: { 0: uid },
      names: { 0: cleanName(name) },
      presence: { 0: true },
    });
    return open(db, code, 0, true, ev);
  }
  throw new Error('No se pudo crear la sala');
}

export class RoomError extends Error {
  reason: 'missing' | 'full';
  constructor(reason: 'missing' | 'full') {
    super(reason);
    this.reason = reason;
  }
}

export async function joinRoom(rawCode: string, name: string, ev: NetEvents): Promise<Net> {
  const code = normalizeCode(rawCode);
  const { db, uid } = await connect();
  const room = (await get(ref(db, `rooms/${code}`))).val();
  if (!room?.host) throw new RoomError('missing');
  // Si ya eras uno de los jugadores (recarga de la página), recuperas tu sitio
  let seat: 0 | 1 | null = room.seats?.[0] === uid ? 0 : room.seats?.[1] === uid ? 1 : null;
  if (seat === null) {
    if (room.seats?.[1]) throw new RoomError('full');
    try {
      await set(ref(db, `rooms/${code}/seats/1`), uid);
    } catch {
      throw new RoomError('full'); // otro jugador se sentó justo antes
    }
    seat = 1;
  }
  await set(ref(db, `rooms/${code}/names/${seat}`), cleanName(name));
  return open(db, code, seat, room.host === uid, ev);
}

function open(db: Database, code: string, seat: 0 | 1, isHost: boolean, ev: NetEvents): Net {
  const base = `rooms/${code}`;
  const unsubs: Unsubscribe[] = [];
  const mine = String(seat) as '0' | '1';
  let closed = false;

  // Presencia: "conectado" mientras haya conexión; Firebase lo pone a false si se corta
  const presenceRef = ref(db, `${base}/presence/${seat}`);
  unsubs.push(
    onValue(ref(db, '.info/connected'), (snap) => {
      if (snap.val() === true) {
        void onDisconnect(presenceRef).set(false);
        void set(presenceRef, true);
      }
    }),
  );

  unsubs.push(
    onValue(ref(db, base), (snap) => {
      const room = snap.val();
      if (!room) {
        if (!closed) ev.onClosed();
        return;
      }
      ev.onNames([room.names?.[0] ?? '', room.names?.[1] ?? '']);
      ev.onPresence([room.presence?.[0] === true, room.presence?.[1] === true]);
      ev.onRematch([room.rematch?.[0] === true, room.rematch?.[1] === true]);
    }),
  );
  unsubs.push(onValue(ref(db, `${base}/state`), (s) => s.exists() && ev.onState(s.val() as StateMsg)));
  unsubs.push(
    onValue(ref(db, `${base}/shot`), (s) => {
      const msg = s.val() as ShotMsg | null;
      if (msg && msg.by !== mine) ev.onShot(msg);
    }),
  );
  unsubs.push(
    onValue(ref(db, `${base}/aim`), (s) => {
      const msg = s.val() as AimMsg | null;
      if (msg && msg.by !== mine) ev.onAim(msg);
    }),
  );

  // Escrituras: se reportan por consola si las reglas las rechazan
  const warn = (what: string) => (e: unknown) => console.warn(`No se pudo enviar ${what}`, e);
  let lastAim = 0;

  return {
    code,
    seat,
    isHost,
    sendState: (msg) => void set(ref(db, `${base}/state`), msg).catch(warn('el estado')),
    sendShot: (msg) => void set(ref(db, `${base}/shot`), msg).catch(warn('el tiro')),
    sendAim(msg) {
      // El cursor del rival se muestra a ~8 Hz: suficiente y no satura la base de datos
      const now = performance.now();
      if (now - lastAim < 120) return false;
      lastAim = now;
      void set(ref(db, `${base}/aim`), msg).catch(() => {});
      return true;
    },
    setRematch: (on) => void set(ref(db, `${base}/rematch/${seat}`), on).catch(warn('la revancha')),
    async leave() {
      closed = true;
      unsubs.forEach((u) => u());
      await onDisconnect(presenceRef).cancel().catch(() => {});
      await set(presenceRef, false).catch(() => {});
      // Si el anfitrión se va antes de que se una nadie, la sala se borra
      if (isHost) {
        const seats = (await get(ref(db, `${base}/seats`)).catch(() => null))?.val();
        if (seats && !seats[1]) await remove(ref(db, base)).catch(() => {});
      }
    },
  };
}
