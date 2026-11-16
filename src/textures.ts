import * as THREE from 'three';

// Las texturas del paño y la madera se generan una vez con tools/bake-textures.mjs y se cargan
// como imágenes: así el navegador las decodifica en segundo plano en vez de calcularlas
// píxel a píxel en cada visita.
const loader = new THREE.TextureLoader();
const base = import.meta.env.BASE_URL;

function load(file: string, srgb: boolean) {
  const tex = loader.load(`${base}textures/${file}`);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let felt: { map: THREE.Texture; bump: THREE.Texture } | null = null;

/** Fieltro: fibra fina + manchas suaves (color en gris, que se tiñe con el material) y relieve. */
export function feltTextures() {
  felt ??= { map: load('felt.webp', true), bump: load('felt-bump.webp', false) };
  return felt;
}

const WHITE = new THREE.Color(0xffffff);
const BASE_CLOTH = new THREE.Color(0x1d3f78);

/** Tiñe el paño de la mesa. Con `null` vuelve al color original del material. */
export function setFeltColor(root: THREE.Object3D, hex: string | null) {
  if (!felt) return;
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

/** Madera de cerezo: vetas largas en la dirección de la textura (u) con poros finos. */
export function cherryTexture() {
  const tex = load('cherry.webp', true);
  cherryTextures.push(tex); // se guardan todas para poder cambiarles la imagen después
  return tex;
}

/** Madera de la mesa: otra imagen (`file`) o la veta del cerezo recoloreada entre `dark` y `light`. */
export interface WoodSkin {
  file?: string;
  dark?: string;
  light?: string;
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
export function setWoodSkin({ file = 'cherry.webp', dark, light }: WoodSkin) {
  const request = ++woodRequest;
  loader.load(`${base}textures/${file}`, (loaded) => {
    if (request !== woodRequest) return; // se eligió otra mientras cargaba
    const image = dark && light ? recolor(loaded.image, dark, light) : loaded.image;
    for (const tex of cherryTextures) {
      tex.image = image;
      tex.needsUpdate = true;
    }
  });
}
