// Genera las texturas del paño y la madera, y los iconos, y los guarda como imágenes en public/.
// Se ejecuta una sola vez (el resultado está en el repositorio), así el navegador no las calcula
// píxel a píxel en cada visita. Necesita Chromium: `npm i --no-save playwright` y
//   node tools/bake-textures.mjs <ruta-al-chromium>
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const exe = process.argv[2];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();

// --- Texturas (misma generación que tenía el juego en tiempo de ejecución) ---
const textures = await page.evaluate(() => {
  function hash(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function valueNoise(x, y, px, py) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const h = (i, j) => hash(((i % px) + px) % px, ((j % py) + py) % py);
    const a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  function fbm(x, y, px, py, octaves = 4) {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += valueNoise(x, y, px, py) * amp;
      norm += amp;
      x *= 2; y *= 2; px *= 2; py *= 2; amp *= 0.5;
    }
    return sum / norm;
  }
  function canvas(w, h, pixel) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [r, gg, b] = pixel(x, y);
      const i = (y * w + x) * 4;
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  const size = 512;
  const feltColor = canvas(size, size, (x, y) => {
    const fiber = hash(x * 1.7, y * 2.3);
    const mottle = fbm(x / 64, y / 64, 8, 8, 3);
    const v = 215 + (fiber - 0.5) * 34 + (mottle - 0.5) * 18;
    return [v, v, v];
  });
  const feltBump = canvas(size, size, (x, y) => {
    const v = 128 + (hash(x * 1.7, y * 2.3) - 0.5) * 200;
    return [v, v, v];
  });
  const light = [150, 62, 34], dark = [78, 24, 12];
  const w = 1024, h = 512;
  const cherry = canvas(w, h, (x, y) => {
    const u = x / w, v = y / h;
    const warp = fbm(u * 4, v * 6, 4, 6, 4);
    const ring = v * 14 + warp * 3;
    const t = ring - Math.floor(ring);
    const line = Math.pow(Math.abs(Math.sin(t * Math.PI)), 6);
    const pores = hash(Math.floor(u * 900), y) * 0.12;
    const figure = fbm(u * 2, v * 3, 2, 3, 2) * 0.35;
    const k = Math.min(1, Math.max(0, 0.25 + line * 0.5 + figure - pores));
    return [0, 1, 2].map((i) => dark[i] + (light[i] - dark[i]) * k);
  });
  const webp = (c, q) => c.toDataURL('image/webp', q);
  return { felt: webp(feltColor, 0.85), 'felt-bump': webp(feltBump, 0.8), cherry: webp(cherry, 0.9) };
});
for (const [name, url] of Object.entries(textures)) {
  const buf = Buffer.from(url.split(',')[1], 'base64');
  writeFileSync(`public/textures/${name}.webp`, buf);
  console.log(`textures/${name}.webp`, Math.round(buf.length / 1024), 'KB');
}

// --- Iconos a partir de favicon.svg ---
const svg = readFileSync('public/favicon.svg', 'utf8');
async function icon(file, size, background) {
  const p = await browser.newPage({ viewport: { width: size, height: size } });
  const inset = background ? Math.round(size * 0.14) : 0;
  await p.setContent(
    `<body style="margin:0;background:${background ?? 'transparent'};display:grid;place-items:center;width:${size}px;height:${size}px">` +
      `<div style="width:${size - inset * 2}px;height:${size - inset * 2}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`,
  );
  writeFileSync(file, await p.screenshot({ omitBackground: !background }));
  await p.close();
  console.log(file);
}
await icon('public/favicon-32.png', 32);
await icon('public/apple-touch-icon.png', 180, '#142b55');
await browser.close();
