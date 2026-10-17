// Sonidos del juego. Los golpes son grabaciones reales (paquete "Pool And Billiards SFX"
// de Suraj Kispotta, CC0).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = (() => {
  try {
    return localStorage.getItem('billar-muted') === '1';
  } catch {
    return false;
  }
})();

const SAMPLE_FILES = {
  ball: ['ball1', 'ball2', 'ball3', 'ball4', 'ball5', 'ball6'],
  cushion: ['cushion1', 'cushion2', 'cushion3'],
  cue: ['cue1', 'cue2', 'cue3', 'cue4'],
  pocket: ['pocket'],
  turn: ['turn'],
  click: ['click'],
  applause: ['applause'],
};
type SampleName = keyof typeof SAMPLE_FILES;
const samples: Partial<Record<SampleName, AudioBuffer[]>> = {};

async function loadSamples(context: AudioContext) {
  const base = `${import.meta.env.BASE_URL}sounds/`;
  await Promise.all(
    (Object.keys(SAMPLE_FILES) as SampleName[]).map(async (name) => {
      const buffers = await Promise.all(
        SAMPLE_FILES[name].map(async (file) => {
          const res = await fetch(`${base}${file}.wav`);
          return context.decodeAudioData(await res.arrayBuffer());
        }),
      );
      samples[name] = buffers;
    }),
  );
}

export function unlockAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    loadSamples(ctx).catch(() => {
      /* sin sonidos si fallan las descargas: el juego sigue */
    });
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

export function isMuted() {
  return muted;
}

export function setMuted(value: boolean) {
  muted = value;
  try {
    localStorage.setItem('billar-muted', value ? '1' : '0');
  } catch {
    /* sin almacenamiento: solo dura esta sesión */
  }
  if (ctx && master) master.gain.setTargetAtTime(value ? 0 : 1, ctx.currentTime, 0.02);
}

/** Reproduce una variante al azar con un poco de variación de tono para que no suene repetido. */
function play(name: SampleName, volume: number, { pitch = 0.06, delay = 0 } = {}) {
  const list = samples[name];
  if (!ctx || !master || !list?.length || volume < 0.01) return;
  const src = ctx.createBufferSource();
  src.buffer = list[Math.floor(Math.random() * list.length)];
  src.playbackRate.value = 1 + (Math.random() * 2 - 1) * pitch;
  const g = ctx.createGain();
  g.gain.value = Math.min(volume, 1.5);
  src.connect(g).connect(master);
  src.start(ctx.currentTime + delay);
}

function tone(freq: number, dur: number, gain: number, delay = 0, endFreq = freq) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// El oído percibe el volumen de forma logarítmica: curva para que los golpes suaves se oigan
const loudness = (v: number) => Math.pow(clamp(v, 0, 1), 0.6);

export const sounds = {
  ball: (speed: number) => play('ball', loudness(speed / 3) * 1.1),
  cushion: (speed: number) => play('cushion', loudness(speed / 3.5) * 0.9),
  cue: (power: number) => play('cue', 0.35 + power * 0.8, { pitch: 0.03 }),
  pocket: () => play('pocket', 0.5, { pitch: 0.04 }),
  turn: () => play('turn', 0.5, { pitch: 0 }),
  /** Falta: dos notas graves descendentes, discretas. */
  foul() {
    tone(330, 0.22, 0.12, 0, 300);
    tone(247, 0.32, 0.12, 0.16, 220);
  },
  ui: () => play('click', 0.4, { pitch: 0 }),
  win: () => play('applause', 0.8, { pitch: 0 }),
};

