import * as THREE from 'three';
import { BALL_R } from './constants';
import { low } from './quality';

export const BALL_COLORS: Record<number, string> = {
  1: '#e8a600', // ámbar profundo: así la lisa se distingue de la de rayas (más clara)
  2: '#1f4fb8',
  3: '#d23a2b',
  4: '#5a2a8a',
  5: '#ef7a22',
  6: '#1d7a45',
  7: '#7a2a20',
  8: '#111111',
};

export const ballColor = (n: number) => (n === 0 ? '#f6f1e4' : BALL_COLORS[n > 8 ? n - 8 : n]);

function makeTexture(n: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  // En calidad baja la mitad de resolución: son 16 texturas y las bolas ocupan poco en pantalla
  const k = low ? 0.5 : 1;
  c.width = 1024 * k;
  c.height = 512 * k;
  const g = c.getContext('2d')!;
  g.scale(k, k); // el resto se dibuja con las medidas de 1024x512
  const ivory = '#fbf8ef';

  if (n === 0) {
    g.fillStyle = ivory;
    g.fillRect(0, 0, 1024, 512);
    // punto rojo de referencia para ver el giro
    for (const u of [0.25, 0.75]) {
      g.fillStyle = '#c0392b';
      g.beginPath();
      g.arc(u * 1024, 256, 14, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    const color = ballColor(n);
    const stripe = n > 8;
    g.fillStyle = stripe ? ivory : color;
    g.fillRect(0, 0, 1024, 512);
    if (stripe) {
      g.fillStyle = color;
      g.fillRect(0, 512 * 0.27, 1024, 512 * 0.46);
    }
    for (const u of [0.25, 0.75]) {
      const cx = u * 1024;
      const cy = 256;
      g.fillStyle = ivory;
      g.beginPath();
      g.ellipse(cx, cy, 64, 70, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#151515';
      g.font = `700 ${n > 9 ? 72 : 84}px Inter, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(n), cx, cy + 4);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const geometry = low ? new THREE.SphereGeometry(BALL_R, 24, 16) : new THREE.SphereGeometry(BALL_R, 48, 32);

export function createBallMesh(n: number): THREE.Mesh {
  const mat = low
    ? new THREE.MeshStandardMaterial({ map: makeTexture(n), roughness: 0.3 })
    : new THREE.MeshPhysicalMaterial({ map: makeTexture(n), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.castShadow = true;
  // Con el círculo del número hacia arriba (en la textura está en el ecuador): desde arriba se ve el
  // número con la franja atravesándolo, y así las rayas se distinguen de las lisas. El giro
  // sobre la vertical es aleatorio para que no parezcan todas iguales.
  mesh.rotation.set(-Math.PI / 2, Math.random() * Math.PI * 2, 0, 'YXZ');
  return mesh;
}

/** Lienzo de w×h dibujado con `draw` y convertido en textura que se repite. */
function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// En las texturas del taco, x = alrededor del taco y y = a lo largo (arriba = hacia la culata).
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Arce: veta fina a lo largo del taco. */
function mapleTexture() {
  return canvasTexture(512, 64, (g) => {
    g.fillStyle = '#e4cc98';
    g.fillRect(0, 0, 512, 64);
    for (let i = 0; i < 140; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '150,105,50' : '255,240,205'},${rand(0.04, 0.14)})`;
      g.fillRect(rand(0, 512), 0, rand(0.6, 2.4), 64);
    }
  });
}

/** Antebrazo de arce con cuatro picos de ébano ribeteados de chapa, de la empuñadura hacia la unión. */
function forearmTexture() {
  return canvasTexture(512, 512, (g) => {
    g.drawImage(mapleTexture().image as HTMLCanvasElement, 0, 0, 512, 512);
    const veneers: [string, number][] = [['#f3ead6', 16], ['#9c2a22', 11], ['#f3ead6', 6], ['#17100c', 0]];
    for (let k = 0; k < 4; k++) {
      const cx = 64 + k * 128;
      for (const [color, pad] of veneers) {
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(cx - 52 - pad, 0);
        g.lineTo(cx + 52 + pad, 0);
        g.lineTo(cx, 430 + pad * 1.6);
        g.closePath();
        g.fill();
      }
    }
    // Veta suave del ébano
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(90,60,40,${rand(0.05, 0.15)})`;
      g.fillRect(rand(0, 512), 0, 1, rand(80, 400));
    }
  });
}

/** Hilo de lino enrollado: vueltas apretadas en diagonal. */
function linenTexture() {
  return canvasTexture(128, 128, (g) => {
    g.fillStyle = '#15171b';
    g.fillRect(0, 0, 128, 128);
    for (let y = -128; y < 256; y += 4) {
      g.strokeStyle = `rgba(255,255,255,${rand(0.05, 0.11)})`;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(128, y + 22);
      g.stroke();
    }
    for (let i = 0; i < 600; i++) {
      g.fillStyle = `rgba(0,0,0,${rand(0.1, 0.35)})`;
      g.fillRect(rand(0, 128), rand(0, 128), 1, 1);
    }
  });
}

/** Franjas de color `ring` sobre `base`, una por cada [desde, hasta] (0..1 a lo largo de la pieza); con `grain`, veta de ébano debajo. */
function ringsTexture(base: string, ring: string, bands: [number, number][], grain = false) {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = base;
    g.fillRect(0, 0, 256, 256);
    if (grain) {
      for (let i = 0; i < 70; i++) {
        g.fillStyle = `rgba(110,72,45,${rand(0.06, 0.2)})`;
        g.fillRect(rand(0, 256), 0, rand(0.6, 2.5), 256);
      }
    }
    g.fillStyle = ring;
    for (const [a, b] of bands) g.fillRect(0, 256 * (1 - b), 256, 256 * (b - a));
  });
}

/**
 * Taco de billar: suela con tiza, virola, eje de arce, unión de acero, antebrazo con picos,
 * empuñadura de lino, culata de ébano con anillos y contera de goma. La punta está en z = 0 y
 * el taco sigue hacia +z. Cada pieza es un perfil torneado (radio a lo largo de z) cerrado por los dos extremos.
 */
export function createCue(): THREE.Group {
  const cue = new THREE.Group();
  const wood = (map: THREE.Texture) =>
    low
      ? new THREE.MeshStandardMaterial({ map, roughness: 0.45 })
      : new THREE.MeshPhysicalMaterial({ map, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.12 });
  const linen = linenTexture();
  linen.repeat.set(3, 26);
  const pieces: { profile: [number, number][]; mat: THREE.Material }[] = [
    // Suela: cara redondeada azul de tiza y lateral de cuero
    {
      profile: [[0, 0], [0.0035, 0.0005], [0.0058, 0.0016], [0.0062, 0.0026]],
      mat: new THREE.MeshStandardMaterial({ color: 0x3f7fd4, roughness: 0.95 }),
    },
    { profile: [[0.0062, 0.0026], [0.0063, 0.011]], mat: new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8 }) },
    { profile: [[0.0064, 0.011], [0.0064, 0.033]], mat: low ? new THREE.MeshStandardMaterial({ color: 0xf1ead9, roughness: 0.35 }) : new THREE.MeshPhysicalMaterial({ color: 0xf1ead9, roughness: 0.3, clearcoat: 0.5 }) },
    // Eje: estrechamiento progresivo, casi recto en los primeros 30 cm
    { profile: [[0.0064, 0.033], [0.0066, 0.33], [0.0083, 0.56], [0.0102, 0.733]], mat: wood(mapleTexture()) },
    // Unión de acero
    {
      profile: [[0.0105, 0.733], [0.0106, 0.745]],
      mat: new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: low ? 0.5 : 0.95, roughness: 0.22 }),
    },
    { profile: [[0.0106, 0.745], [0.0107, 0.762]], mat: wood(ringsTexture('#f1ead9', '#17100c', [[0.25, 0.35], [0.65, 0.75]])) },
    // Antebrazo con picos
    { profile: [[0.0107, 0.762], [0.0119, 1.06]], mat: wood(forearmTexture()) },
    { profile: [[0.0119, 1.06], [0.012, 1.068]], mat: wood(ringsTexture('#17100c', '#f1ead9', [[0.3, 0.7]])) },
    // Empuñadura de lino
    {
      profile: [[0.0119, 1.068], [0.0121, 1.32]],
      mat: new THREE.MeshStandardMaterial({ map: linen, roughness: 0.92 }),
    },
    { profile: [[0.0121, 1.32], [0.0122, 1.328]], mat: wood(ringsTexture('#17100c', '#f1ead9', [[0.3, 0.7]])) },
    // Culata de ébano con anillos de marfil
    { profile: [[0.0122, 1.328], [0.0129, 1.455]], mat: wood(ringsTexture('#1a120d', '#efe6d2', [[0.12, 0.14], [0.17, 0.19], [0.9, 0.93]], true)) },
    { profile: [[0.0129, 1.455], [0.0127, 1.464], [0.0105, 1.472], [0, 1.474]], mat: new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.7 }) },
  ];
  for (const { profile, mat } of pieces) {
    // Cerrado por los dos extremos para que no se vea el hueco donde cambia el radio
    const pts = [[0, profile[0][1]], ...profile, [0, profile[profile.length - 1][1]]].map(([r, z]) => new THREE.Vector2(r, z));
    const geo = new THREE.LatheGeometry(pts, low ? 20 : 40);
    // La textura se reparte por longitud (el torno la reparte por número de puntos)
    const z0 = profile[0][1];
    const z1 = profile[profile.length - 1][1];
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, (pos.getY(i) - z0) / (z1 - z0));
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = Math.PI / 2; // eje del torno (y) a lo largo de +z
    m.castShadow = true;
    cue.add(m);
  }
  return cue;
}

/**
 * Sombra de contacto dibujada (un círculo difuso bajo la bola). En calidad baja sustituye a las
 * sombras reales, que obligan a dibujar la escena otra vez desde la luz.
 */
let blobTexture: THREE.CanvasTexture | null = null;
export function createBlobShadow(): THREE.Mesh {
  if (!blobTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    blobTexture = new THREE.CanvasTexture(c);
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BALL_R * 3.4, BALL_R * 3.4),
    new THREE.MeshBasicMaterial({ map: blobTexture, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}
