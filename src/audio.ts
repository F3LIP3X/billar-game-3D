// Sonidos sintetizados con WebAudio: sin ficheros que cargar.
let ctx: AudioContext | null = null;

export function unlockAudio() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
}

function click(volume: number, freq: number, decay: number) {
  if (!ctx || volume < 0.01) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + decay);
  gain.gain.setValueAtTime(Math.min(volume, 1) * 0.5, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + decay);
}

export const sounds = {
  ball: (speed: number) => click(speed / 3, 2400 + Math.random() * 400, 0.05),
  cushion: (speed: number) => click(speed / 5, 180, 0.12),
  cue: (power: number) => click(0.3 + power * 0.6, 900, 0.07),
  pocket: () => click(0.6, 120, 0.25),
  win: () => {
    // Arpegio ascendente (do-mi-sol-do)
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.6), i * 110));
  },
};

function tone(freq: number, decay: number) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + decay);
}
