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

/** Tiñe el paño de la mesa. Con `null` vuelve al color original del material. */
export function setFeltColor(root: THREE.Object3D, hex: string | null) {
  if (!felt) return;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of [o.material].flat()) {
      if (m instanceof THREE.MeshStandardMaterial && m.map === felt!.map) {
        m.userData.baseColor ??= m.color.clone(); // se guarda el color original la primera vez
        if (hex) m.color.set(hex);
        else m.color.copy(m.userData.baseColor);
      }
    }
  });
}

const cherryTextures: THREE.Texture[] = [];
let cherryFile = 'cherry.webp';

/** Madera de cerezo: vetas largas en la dirección de la textura (u) con poros finos. */
export function cherryTexture() {
  const tex = load(cherryFile, true);
  cherryTextures.push(tex); // se guardan todas para poder cambiarles la imagen después
  return tex;
}

/** Cambia la madera de la mesa por otra imagen, conservando repetición y orientación de cada textura. */
export function setCherrySkin(file: string) {
  cherryFile = file;
  loader.load(`${base}textures/${file}`, (loaded) => {
    for (const tex of cherryTextures) {
      tex.image = loaded.image;
      tex.needsUpdate = true;
    }
  });
}
