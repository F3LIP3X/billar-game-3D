// Prueba de integración del multijugador contra la base de datos real: dos jugadores anónimos
// crean una sala, juegan un par de turnos y se comprueba que las reglas rechazan lo que no deben.
// Uso (desde la raíz del proyecto, con la base de datos creada y las reglas desplegadas):
//   node tools/net-test.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('.tmp-test', { recursive: true });
for (const f of ['net', 'firebase-config']) {
  const src = readFileSync(`src/${f}.ts`, 'utf8')
    .replace(/from '\.\/firebase-config'/g, "from './firebase-config.ts'")
    // cada instancia del módulo = una app de Firebase propia = un usuario anónimo distinto (como dos navegadores)
    .replace('initializeApp(firebaseConfig)', 'initializeApp(firebaseConfig, `jugador-${Math.random()}`)');
  writeFileSync(`.tmp-test/${f}.ts`, src);
}
const A = await import('../.tmp-test/net.ts?a'); // dos instancias del módulo = dos jugadores distintos
const B = await import('../.tmp-test/net.ts?b');
const C = await import('../.tmp-test/net.ts?c');

const log = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) process.exitCode = 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function events(name) {
  const got = { names: null, presence: null, states: [], shots: [], aims: [], closed: false };
  return {
    got,
    ev: {
      onNames: (n) => (got.names = n),
      onPresence: (p) => (got.presence = p),
      onState: (s) => got.states.push(s),
      onShot: (s) => got.shots.push(s),
      onAim: (a) => got.aims.push(a),
      onRematch: () => {},
      onClosed: () => (got.closed = true),
    },
  };
}
const state = (o) => ({ seq: 1, gameId: 1, turn: '0', phase: 'placing', isBreak: true, kitchenOnly: true, groups: ['', ''], balls: Array(48).fill(0), stats: [0, 0, 0, 0, 0, 0], winner: -1, shooterWon: false, foul: false, message: '', ...o });
const shot = (o) => ({ seq: 1, stateSeq: 1, by: '0', vx: 1, vz: 0, rx: 0, rz: 0, cx: -0.6, cz: 0, power: 0.5, ...o });

const ea = events('A'), eb = events('B'), ec = events('C');
const a = await A.createRoom('Ana', ea.ev);
log(/^[A-HJ-NP-Z2-9]{5}$/.test(a.code), `sala creada con código ${a.code}`);
const b = await B.joinRoom(a.code.toLowerCase(), 'Beto', eb.ev);
log(b.seat === 1 && !b.isHost, 'el segundo jugador se sienta en el asiento 1');
await wait(2500);
log(ea.got.names?.[0] === 'Ana' && ea.got.names?.[1] === 'Beto', `nombres visibles para el anfitrión: ${JSON.stringify(ea.got.names)}`);
log(ea.got.presence?.[0] && ea.got.presence?.[1] && eb.got.presence?.[0] && eb.got.presence?.[1], 'presencia de los dos');

try { await C.joinRoom(a.code, 'Carla', ec.ev); log(false, 'un tercer jugador NO debería poder entrar'); }
catch (e) { log(e.reason === 'full', `tercer jugador rechazado (${e.reason})`); }
try { await C.joinRoom('ZZZZZ', 'Carla', ec.ev); log(false, 'una sala inexistente NO debería abrirse'); }
catch (e) { log(e.reason === 'missing', `sala inexistente rechazada (${e.reason})`); }

a.sendState(state({ seq: 1 }));
await wait(1500);
log(eb.got.states.at(-1)?.seq === 1, 'B recibe el estado inicial del anfitrión');

b.sendShot(shot({ by: '1' })); // no es su turno
await wait(1500);
log(ea.got.shots.length === 0, 'las reglas rechazan el tiro de quien no tiene el turno');

a.sendShot(shot());
a.sendAim({ seq: 1, stateSeq: 1, by: '0', angle: 0.5, power: 0, spin: 0, cx: -0.6, cz: 0, placing: false });
await wait(1500);
log(eb.got.shots.at(-1)?.vx === 1, 'B recibe el tiro de A');
log(eb.got.aims.at(-1)?.angle === 0.5, 'B recibe el apuntado de A');

b.sendState(state({ seq: 2, turn: '1', phase: 'aiming' })); // B no puede publicar el estado de A
await wait(1500);
log(ea.got.states.at(-1)?.seq !== 2, 'las reglas rechazan el estado publicado por quien no tiene el turno');

a.sendState(state({ seq: 2, turn: '1', phase: 'aiming' }));
await wait(1500);
log(eb.got.states.at(-1)?.seq === 2, 'A publica el estado tras su tiro (turno de B)');
b.sendShot(shot({ seq: 1, stateSeq: 2, by: '1', vx: -2 }));
await wait(1500);
log(ea.got.shots.at(-1)?.vx === -2, 'ahora B puede tirar y A lo recibe');

b.sendState(state({ seq: 3, turn: '0', phase: 'over', winner: 1, shooterWon: true }));
await wait(1500);
log(ea.got.states.at(-1)?.phase === 'over', 'B publica el final de la partida');
a.sendState(state({ seq: 4, gameId: 2 })); // el anfitrión puede reiniciar tras el final
await wait(1500);
log(eb.got.states.at(-1)?.gameId === 2, 'el anfitrión inicia la revancha');

await b.leave();
await wait(1500);
log(ea.got.presence?.[1] === false, 'A ve que B se ha desconectado');
console.log(`\nSala de prueba: ${a.code} (bórrala con: firebase database:remove /rooms/${a.code} --project billar-3d-f3lip3x --force)`);
await a.leave();
process.exit(process.exitCode ?? 0);
