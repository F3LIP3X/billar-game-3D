import * as THREE from 'three';

// Texturas generadas por código (sin imágenes que descargar). Todas se repiten sin costuras.

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Ruido suave periódico: se repite cada `px` x `py` celdas. */
function valueNoise(x: number, y: number, px: number, py: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number) => hash(((i % px) + px) % px, ((j % py) + py) % py);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number, px: number, py: number, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, y, px, py) * amp;
    norm += amp;
    x *= 2;
    y *= 2;
    px *= 2;
    py *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

function toTexture(canvas: HTMLCanvasElement, srgb: boolean) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Fieltro: fibra fina + manchas suaves. Devuelve el color (gris, se tiñe con el material) y el relieve. */
export function feltTextures() {
  const size = 512;
  const color = document.createElement('canvas');
  const bump = document.createElement('canvas');
  color.width = color.height = bump.width = bump.height = size;
  const cImg = color.getContext('2d')!.createImageData(size, size);
  const bImg = bump.getContext('2d')!.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fiber = hash(x * 1.7, y * 2.3);
      const mottle = fbm(x / 64, y / 64, 8, 8, 3);
      const c = 215 + (fiber - 0.5) * 34 + (mottle - 0.5) * 18;
      const b = 128 + (fiber - 0.5) * 200;
      const i = (y * size + x) * 4;
      cImg.data[i] = cImg.data[i + 1] = cImg.data[i + 2] = c;
      bImg.data[i] = bImg.data[i + 1] = bImg.data[i + 2] = b;
      cImg.data[i + 3] = bImg.data[i + 3] = 255;
    }
  }
  color.getContext('2d')!.putImageData(cImg, 0, 0);
  bump.getContext('2d')!.putImageData(bImg, 0, 0);
  return { map: toTexture(color, true), bump: toTexture(bump, false) };
}

/** Madera de cerezo: vetas largas en la dirección de la textura (u) con poros finos. */
export function cherryTexture() {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const img = canvas.getContext('2d')!.createImageData(w, h);
  const light = [150, 62, 34];
  const dark = [78, 24, 12];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      // Anillos deformados por ruido: líneas largas y onduladas a lo largo de u
      const warp = fbm(u * 4, v * 6, 4, 6, 4);
      const ring = v * 14 + warp * 3;
      const t = ring - Math.floor(ring);
      const line = Math.pow(Math.abs(Math.sin(t * Math.PI)), 6); // 1 en el centro de la veta
      const pores = hash(Math.floor(u * 900), y) * 0.12;
      const figure = fbm(u * 2, v * 3, 2, 3, 2) * 0.35;
      const k = Math.min(1, Math.max(0, 0.25 + line * 0.5 + figure - pores));
      const i = (y * w + x) * 4;
      img.data[i] = dark[0] + (light[0] - dark[0]) * k;
      img.data[i + 1] = dark[1] + (light[1] - dark[1]) * k;
      img.data[i + 2] = dark[2] + (light[2] - dark[2]) * k;
      img.data[i + 3] = 255;
    }
  }
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return toTexture(canvas, true);
}
