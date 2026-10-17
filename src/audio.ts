// Sonidos sintetizados con WebAudio: sin ficheros que cargar.
// Los golpes se hacen con ráfagas de ruido filtrado (suenan a "clac" y no a pitido)
// y en bandas medias, que se oyen bien también en altavoces de portátil o móvil.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let rolling: GainNode | null = null;
let muted = (() => {
  try {
    return localStorage.getItem('billar-muted') === '1';
  } catch {
    return false;
  }
})();

export function unlockAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);

    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // Rumor de las bolas rodando: ruido continuo filtrado cuyo volumen sigue a la velocidad
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 420;
    band.Q.value = 0.9;
    rolling = ctx.createGain();
    rolling.gain.value = 0;
    src.connect(band).connect(rolling).connect(master);
    src.start();
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
  if (ctx && master) master.gain.setTargetAtTime(value ? 0 : 0.9, ctx.currentTime, 0.02);
}

function noiseBurst(type: BiquadFilterType, freq: number, q: number, dur: number, gain: number, delay = 0) {
  if (!ctx || !master || !noise || gain < 0.005) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.min(gain, 1), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

function toneBurst(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0, endFreq = freq) {
  if (!ctx || !master || gain < 0.005) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.min(gain, 1), t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const sounds = {
  /** Choque entre bolas: "clac" seco y agudo. */
  ball(speed: number) {
    const v = clamp(speed / 2.5, 0.06, 1);
    noiseBurst('bandpass', 3200 + Math.random() * 600, 1.4, 0.04, v * 1.1);
    toneBurst(1750 + Math.random() * 350, 0.045, v * 0.35, 'triangle');
  },
  /** Banda: golpe sordo de goma. */
  cushion(speed: number) {
    const v = clamp(speed / 3, 0.05, 1);
    noiseBurst('lowpass', 900, 0.8, 0.1, v * 0.9);
    toneBurst(320, 0.09, v * 0.35, 'triangle', 0, 210);
  },
  /** Golpe del taco: chasquido de la suela contra la bola. */
  cue(power: number) {
    noiseBurst('highpass', 1400, 0.7, 0.035, 0.35 + power * 0.55);
    toneBurst(1050, 0.05, 0.25 + power * 0.2, 'triangle', 0, 800);
  },
  /** Tronera: la bola golpea el borde un par de veces y cae. */
  pocket() {
    [0, 0.055, 0.12].forEach((d, i) => noiseBurst('bandpass', 900 - i * 150, 2.5, 0.06, 0.7 - i * 0.18, d));
    noiseBurst('lowpass', 500, 0.7, 0.22, 0.6, 0.2);
    toneBurst(190, 0.22, 0.35, 'sine', 0.2, 120);
  },
  /** Cambio de turno: dos notas suaves. */
  turn() {
    toneBurst(660, 0.25, 0.13, 'sine');
    toneBurst(880, 0.35, 0.13, 'sine', 0.11);
  },
  /** Falta: dos notas graves descendentes. */
  foul() {
    toneBurst(330, 0.22, 0.16, 'triangle', 0, 300);
    toneBurst(247, 0.32, 0.16, 'triangle', 0.16, 220);
  },
  /** Clic de botón. */
  ui() {
    toneBurst(1300, 0.04, 0.08, 'sine');
  },
  /** Victoria: arpegio ascendente (do-mi-sol-do). */
  win() {
    [523, 659, 784, 1047].forEach((f, i) => toneBurst(f, 0.6, 0.18, 'triangle', i * 0.11));
  },
};

/** Volumen del rumor de rodadura según la velocidad total de las bolas (m/s). */
export function setRolling(totalSpeed: number) {
  if (!ctx || !rolling) return;
  rolling.gain.setTargetAtTime(Math.min(0.22, totalSpeed * 0.05), ctx.currentTime, 0.08);
}
