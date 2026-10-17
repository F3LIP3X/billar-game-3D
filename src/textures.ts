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

/** Fieltro: fibra fina + manchas suaves (color en gris, que se tiñe con el material) y relieve. */
export function feltTextures() {
  return { map: load('felt.webp', true), bump: load('felt-bump.webp', false) };
}

/** Madera de cerezo: vetas largas en la dirección de la textura (u) con poros finos. */
export function cherryTexture() {
  return load('cherry.webp', true);
}
