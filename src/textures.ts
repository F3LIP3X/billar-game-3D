import * as THREE from 'three';

// Las texturas del paño y la madera se generan una vez con tools/bake-textures.mjs y se cargan
// como imágenes: así el navegador las decodifica en segundo plano en vez de calcularlas
// píxel a píxel en cada visita.
const loader = new THREE.TextureLoader();
const base = import.meta.env.BASE_URL;

function load(file: string, srgb: boolean, onLoad?: (tex: THREE.Texture) => void) {
  const tex = loader.load(`${base}textures/${file}`, onLoad);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let felt: { map: THREE.Texture; bump: THREE.Texture } | null = null;

/** Fieltro: fibra fina + manchas suaves (color en gris, que se tiñe con el material) y relieve. */
export function feltTextures() {
  felt ??= {
    map: load('felt.webp', true, (tex) => {
      feltFibre = tex.image;
      // Si ya se eligió un paño con dibujo antes de que llegara la imagen, manda el dibujo
      if (feltDrawn) showImage([tex], feltDrawn);
    }),
    bump: load('felt-bump.webp', false),
  };
  return felt;
}
let feltFibre: unknown = null; // la imagen original del paño, para volver a ella
let feltDrawn: HTMLCanvasElement | null = null;

function showImage(textures: THREE.Texture[], image: unknown) {
  for (const tex of textures) {
    tex.image = image;
    tex.needsUpdate = true;
  }
}

// ---------- Dibujos compartidos por mesas, paños y palos ----------
// Todos se repiten sin costura y usan un azar fijo: siempre sale el mismo dibujo.
const hash = (i: number, j: number) => {
  const r = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return r - Math.floor(r);
};
type Ctx = CanvasRenderingContext2D;

/** Pixel art: bloques de cw×ch con colores de la lista. */
export function paintBlocks(g: Ctx, w: number, h: number, cw: number, ch: number, colors: string[]) {
  for (let i = 0; i * cw < w; i++) {
    for (let j = 0; j * ch < h; j++) {
      g.fillStyle = colors[Math.floor(hash(i, j) * colors.length)];
      g.fillRect(i * cw, j * ch, cw, ch);
    }
  }
}

/** Fibra de carbono: sarga de dos tonos (cada hilo pasa dos por encima y dos por debajo) con un brillo en cada celda. */
export function paintCarbon(g: Ctx, w: number, h: number, cw: number, ch: number, dark = '#131518', light = '#30343c') {
  for (let i = 0; i * cw < w; i++) {
    for (let j = 0; j * ch < h; j++) {
      g.fillStyle = (i + j) % 4 < 2 ? light : dark;
      g.fillRect(i * cw, j * ch, cw, ch);
      g.fillStyle = 'rgba(255, 255, 255, 0.08)';
      g.fillRect(i * cw, j * ch, cw, ch / 3);
    }
  }
}

/** Galaxia: `n` estrellas sobre el fondo ya pintado; `tall` las estira para superficies que aplastan la textura. */
export function paintStars(g: Ctx, w: number, h: number, n: number, tall: number, colors: string[]) {
  for (let k = 0; k < n; k++) {
    const r = 1 + hash(k, 3) * hash(k, 5) * 5; // muchas pequeñas, pocas grandes
    g.fillStyle = colors[k % colors.length];
    g.globalAlpha = 0.5 + hash(k, 7) * 0.5;
    g.beginPath();
    // Lejos del borde para que ninguna quede cortada al repetirse
    g.ellipse(12 + hash(k, 1) * (w - 24), 12 + hash(k, 2) * (h - 24), r, r * tall, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

export type FeltArt = 'carbon' | 'pixel' | 'galaxy';

/** Dibujo del paño en grises (el color lo pone el material). Contraste bajo: no debe distraer del juego. */
function feltArt(art: FeltArt) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  if (art === 'carbon') paintCarbon(g, 512, 512, 16, 16, '#b4b4b4', '#e6e6e6');
  else if (art === 'pixel') paintBlocks(g, 512, 512, 32, 32, ['#eeeeee', '#dcdcdc', '#c8c8c8', '#b9b9b9']);
  else {
    g.fillStyle = '#a8a8a8';
    g.fillRect(0, 0, 512, 512);
    paintStars(g, 512, 512, 90, 1, ['#ffffff']);
  }
  return c;
}

const WHITE = new THREE.Color(0xffffff);
const BASE_CLOTH = new THREE.Color(0x1d3f78);

/** Tiñe el paño de la mesa (con `null`, el color original) y le pone un dibujo, o la fibra lisa si no hay `art`. */
export function setFeltColor(root: THREE.Object3D, hex: string | null, art?: FeltArt) {
  if (!felt) return;
  feltDrawn = art ? feltArt(art) : null;
  if (feltDrawn ?? feltFibre) showImage([felt.map], feltDrawn ?? feltFibre);
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of [o.material].flat() as (THREE.MeshPhysicalMaterial | THREE.MeshLambertMaterial)[]) {
      if (m.map !== felt!.map) continue;
      m.userData.baseColor ??= m.color.clone(); // se guarda el color original la primera vez
      const base: THREE.Color = m.userData.baseColor;
      // Bandas y calidad baja son más oscuras que el paño: se conserva esa proporción
      if (hex) m.color.set(hex).multiplyScalar(base.b / BASE_CLOTH.b);
      else m.color.copy(base);
      if (m instanceof THREE.MeshPhysicalMaterial) {
        m.userData.baseSheen ??= m.sheenColor.clone();
        if (hex) m.sheenColor.set(hex).lerp(WHITE, 0.4);
        else m.sheenColor.copy(m.userData.baseSheen);
      }
    }
  });
}

const cherryTextures: THREE.Texture[] = [];
let woodImage: unknown = null; // lo que hay puesto ahora en el marco

/** Madera de cerezo: vetas largas en la dirección de la textura (u) con poros finos. */
export function cherryTexture() {
  // Si ya se eligió otra mesa antes de que llegara el cerezo, manda la elegida
  const tex = load('cherry.webp', true, (t) => woodImage && showImage([t], woodImage));
  cherryTextures.push(tex); // se guardan todas para poder cambiarles la imagen después
  return tex;
}

/**
 * Marco de la mesa: otra imagen (`file`), la veta del cerezo recoloreada entre `dark` y `light`,
 * o un dibujo (`art`) pintado con `colors` (el primero es el fondo).
 */
export interface WoodSkin {
  file?: string;
  dark?: string;
  light?: string;
  art?: 'pixel' | 'dots' | 'stripes' | 'carbon' | 'galaxy';
  colors?: string[];
}

/**
 * Dibujos para el marco, que se repiten sin costura. En la mesa un píxel de la textura mide casi
 * el doble de ancho que de alto, así que aquí todo se dibuja el doble de alto para que salga cuadrado.
 */
export function woodArt({ art, colors = [] }: WoodSkin) {
  if (!art) return null;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = colors[0];
  g.fillRect(0, 0, 1024, 512);
  if (art === 'pixel') paintBlocks(g, 1024, 512, 32, 64, colors);
  else if (art === 'carbon') paintCarbon(g, 1024, 512, 16, 32);
  else if (art === 'galaxy') paintStars(g, 1024, 512, 150, 2, colors.slice(1));
  else if (art === 'dots') {
    // Lunares al tresbolillo con contorno
    g.lineWidth = 6;
    g.strokeStyle = colors[2] ?? colors[1];
    g.fillStyle = colors[1];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i <= 16; i++) {
        g.beginPath();
        g.ellipse(i * 64 + (j % 2) * 32, j * 128 + 64, 17, 34, 0, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
  } else {
    // Franjas en diagonal, como un bastón de caramelo
    g.fillStyle = colors[1];
    for (let x = -256; x < 1024; x += 128) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 64, 0);
      g.lineTo(x + 320, 512);
      g.lineTo(x + 256, 512);
      g.fill();
    }
  }
  return c;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Repinta la veta del cerezo (su rojo va de 78 a 150) con otros dos colores. */
function recolor(img: HTMLImageElement, dark: string, light: string) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  const a = rgb(dark);
  const b = rgb(light);
  for (let i = 0; i < d.length; i += 4) {
    const k = Math.min(1, Math.max(0, (d[i] - 78) / 72));
    for (let j = 0; j < 3; j++) d[i + j] = a[j] + (b[j] - a[j]) * k;
  }
  g.putImageData(data, 0, 0);
  return c;
}

let woodRequest = 0;

/** Cambia la madera de la mesa, conservando repetición y orientación de cada textura. */
export function setWoodSkin(skin: WoodSkin) {
  const request = ++woodRequest;
  const show = (image: HTMLImageElement | HTMLCanvasElement) => showImage(cherryTextures, (woodImage = image));
  const art = woodArt(skin);
  if (art) return show(art);
  const { file = 'cherry.webp', dark, light } = skin;
  loader.load(`${base}textures/${file}`, (loaded) => {
    if (request !== woodRequest) return; // se eligió otra mientras cargaba
    show(dark && light ? recolor(loaded.image, dark, light) : loaded.image);
  });
}
