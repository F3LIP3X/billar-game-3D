import * as THREE from 'three';
import { BALL_R } from './constants';
import { low } from './quality';

export const BALL_COLORS: Record<number, string> = {
  1: '#f2c230',
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
  const ivory = '#f6f1e4';

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
  // orientación aleatoria para que no parezcan todas iguales
  mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  return mesh;
}

export function createCue(): THREE.Group {
  const cue = new THREE.Group();
  const len = 1.45;
  const parts: [number, number, number, number][] = [
    // [radioPunta, radioBase, longitud, color]
    [0.0055, 0.0058, 0.012, 0x3b7bd6], // tiza/suela
    [0.0058, 0.0062, 0.02, 0xf5efe0], // virola
    [0.0062, 0.0095, len * 0.55, 0xd9b77e], // arce
    [0.0095, 0.013, len * 0.42, 0x2a120a], // empuñadura
  ];
  let z = 0;
  for (const [r0, r1, l, color] of parts) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(r0, r1, l, 24),
      low
        ? new THREE.MeshStandardMaterial({ color, roughness: 0.4 })
        : new THREE.MeshPhysicalMaterial({ color, roughness: 0.35, clearcoat: 0.6 }),
    );
    m.rotation.x = Math.PI / 2; // eje del cilindro a lo largo de +z
    m.position.z = z + l / 2;
    m.castShadow = true;
    cue.add(m);
    z += l;
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
