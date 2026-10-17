import * as THREE from 'three';
import { BALL_R, CUSHION_W, CUSHIONS, POCKETS, RAIL_W, TABLE_L, TABLE_W } from './constants';
import { cherryTexture, feltTextures } from './textures';
import { low } from './quality';

const HALF_L = TABLE_L / 2;
const HALF_W = TABLE_W / 2;
const CUSHION_H = BALL_R * 1.35;
const RAIL_H = CUSHION_H + 0.006;
const OUTER_L = HALF_L + CUSHION_W; // línea donde empieza la madera
const OUTER_W = HALF_W + CUSHION_W;

type Pocket = (typeof POCKETS)[number];
const insidePocket = (x: number, z: number) => POCKETS.find((p) => Math.hypot(x - p.x, z - p.z) < p.r);

/**
 * Contorno del rectángulo del paño con las troneras: 'union' lo amplía con los agujeros
 * (hueco de los raíles) y 'subtract' se los quita (borde del paño).
 * Se recorre el perímetro y, al cruzar un agujero, se sustituye ese tramo por su arco.
 */
function pocketContour(mode: 'union' | 'subtract'): THREE.Vector2[] {
  const corners: [number, number][] = [
    [-OUTER_L, 0],
    [-OUTER_L, -OUTER_W],
    [OUTER_L, -OUTER_W],
    [OUTER_L, OUTER_W],
    [-OUTER_L, OUTER_W],
    [-OUTER_L, 0],
  ];
  const perimeter: [number, number][] = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[i + 1];
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.002);
    for (let k = 0; k < n; k++) perimeter.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
  }

  const out: THREE.Vector2[] = [];
  let current: Pocket | undefined;
  let entry: [number, number] = [0, 0];
  for (const pt of perimeter) {
    const pocket = insidePocket(pt[0], pt[1]);
    if (!current && pocket) {
      current = pocket;
      entry = pt;
    } else if (current && !pocket) {
      const a0 = Math.atan2(entry[1] - current.z, entry[0] - current.x);
      let a1 = Math.atan2(pt[1] - current.z, pt[0] - current.x);
      if (mode === 'union') while (a1 <= a0) a1 += Math.PI * 2;
      else while (a1 >= a0) a1 -= Math.PI * 2;
      for (let k = 0; k <= 48; k++) {
        const a = a0 + ((a1 - a0) * k) / 48;
        out.push(new THREE.Vector2(current.x + Math.cos(a) * current.r, -(current.z + Math.sin(a) * current.r)));
      }
      current = undefined;
    }
    if (!current) out.push(new THREE.Vector2(pt[0], -pt[1]));
  }
  return out;
}

/** Puntos del borde de un agujero que quedan dentro de la madera (para el embellecedor). */
function pocketRimArc(p: Pocket): THREE.Vector3[] {
  const n = 96;
  const inRail = (k: number) => {
    const a = (k / n) * Math.PI * 2;
    const x = p.x + Math.cos(a) * p.r;
    const z = p.z + Math.sin(a) * p.r;
    return Math.abs(x) > OUTER_L - 1e-6 || Math.abs(z) > OUTER_W - 1e-6;
  };
  let start = 0;
  while (inRail(start)) start++;
  const pts: THREE.Vector3[] = [];
  for (let i = 1; i <= n; i++) {
    const k = (start + i) % n;
    if (!inRail(k)) continue;
    const a = (k / n) * Math.PI * 2;
    pts.push(new THREE.Vector3(p.x + Math.cos(a) * p.r, RAIL_H + 0.002, p.z + Math.sin(a) * p.r));
  }
  return pts;
}

/** Extruye una forma de planta hacia arriba hasta `top`. Con `bevel` los cantos salen redondeados. */
function extrudeFlat(shape: THREE.Shape, depth: number, top: number, bevel = 0) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 6,
    curveSegments: 48,
  });
  geo.rotateX(-Math.PI / 2); // la forma (x, -z) pasa al plano de la mesa
  geo.translate(0, top - depth - bevel, 0); // el biselado sobresale por arriba: se compensa
  return geo;
}

/** Rectángulo de esquinas redondeadas centrado en el origen. */
function roundedRect(halfL: number, halfW: number, r: number) {
  const s = new THREE.Shape();
  s.moveTo(-halfL + r, -halfW);
  s.lineTo(halfL - r, -halfW);
  s.absarc(halfL - r, -halfW + r, r, -Math.PI / 2, 0, false);
  s.lineTo(halfL, halfW - r);
  s.absarc(halfL - r, halfW - r, r, 0, Math.PI / 2, false);
  s.lineTo(-halfL + r, halfW);
  s.absarc(-halfL + r, halfW - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-halfL, -halfW + r);
  s.absarc(-halfL + r, -halfW + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

export function buildTable(): THREE.Group {
  const table = new THREE.Group();

  // Paño de fieltro azul: textura de fibra + brillo "sheen" de tela en vez de reflejo especular
  const felt = feltTextures();
  // Las UV del paño van en metros: una tesela de fibra cada 25 cm
  felt.map.repeat.set(4, 4);
  felt.bump.repeat.set(4, 4);
  const feltMaterial = (color: number): THREE.MeshStandardMaterial | THREE.MeshLambertMaterial =>
    low
      ? new THREE.MeshLambertMaterial({ color, map: felt.map })
      : new THREE.MeshPhysicalMaterial({
          color,
          map: felt.map,
          bumpMap: felt.bump,
          bumpScale: 0.6,
          roughness: 1,
          sheen: 1,
          sheenRoughness: 0.75,
          sheenColor: new THREE.Color(0x5a7fc4),
        });
  const cloth = feltMaterial(low ? 0x142b55 : 0x1d3f78);
  const cushionCloth = feltMaterial(low ? 0x10244a : 0x183668);

  // Cerezo barnizado: veta de la textura + capa de barniz (clearcoat)
  const cherry = cherryTexture();
  cherry.repeat.set(1 / 1.2, 1 / 0.35); // 1,2 m de veta a lo largo, 35 cm de ancho
  const wood: THREE.MeshStandardMaterial | THREE.MeshLambertMaterial = low
    ? new THREE.MeshLambertMaterial({ map: cherry, color: 0xb59a8c }) // oscurece la veta, como el barniz
    : new THREE.MeshPhysicalMaterial({ map: cherry, roughness: 0.55, clearcoat: 1, clearcoatRoughness: 0.06 });
  // Cuerpo y patas tienen UV de 0 a 1: otra repetición de la misma veta
  const bodyCherry = cherryTexture();
  bodyCherry.repeat.set(2, 1);
  const bodyWood = wood.clone();
  bodyWood.map = bodyCherry;
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 1, roughness: 0.3 });
  const pocketMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, side: THREE.DoubleSide });

  // Paño: rectángulo hasta la madera con los agujeros recortados
  const clothMesh = new THREE.Mesh(extrudeFlat(new THREE.Shape(pocketContour('subtract')), 0.03, 0), cloth);
  clothMesh.receiveShadow = true;
  table.add(clothMesh);

  // Troneras: pozo negro y embellecedor de latón siguiendo el corte de la madera
  for (const p of POCKETS) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 0.85, 0.18, 40, 1, true), pocketMat);
    cup.position.set(p.x, -0.09, p.z);
    table.add(cup);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(p.r * 0.85, 32), pocketMat);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(p.x, -0.17, p.z);
    table.add(bottom);

    const rim = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pocketRimArc(p)), 64, 0.006, 10, false),
      brass,
    );
    rim.castShadow = true;
    table.add(rim);
  }

  // Bandas: prismas con las bocas en ángulo hacia las troneras
  for (const quad of CUSHIONS) {
    const shape = new THREE.Shape(quad.map(([x, z]) => new THREE.Vector2(x, -z)));
    const m = new THREE.Mesh(extrudeFlat(shape, CUSHION_H, CUSHION_H, 0.004), cushionCloth);
    m.castShadow = true;
    m.receiveShadow = true;
    table.add(m);
  }

  // Raíles de madera con el hueco de la mesa y las troneras cortadas
  const railOuterL = OUTER_L + RAIL_W;
  const railOuterW = OUTER_W + RAIL_W;
  // Esquinas exteriores redondeadas (el biselado añade 1 cm más de radio y redondea el canto)
  const railShape = roundedRect(railOuterL - 0.01, railOuterW - 0.01, 0.08);
  railShape.holes.push(new THREE.Path(pocketContour('union')));
  const rails = new THREE.Mesh(extrudeFlat(railShape, RAIL_H + 0.2, RAIL_H, 0.01), wood);
  rails.castShadow = true;
  rails.receiveShadow = true;
  table.add(rails);

  // Superficie del raíl entre paño y madera (tapa el hueco bajo las troneras)
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(2 * OUTER_L, 0.2, 2 * OUTER_W),
    new THREE.MeshStandardMaterial({ color: 0x0b0b0b }),
  );
  deck.position.y = -0.21;
  table.add(deck);

  // Diamantes de nácar
  const pearl = new THREE.MeshStandardMaterial({ color: 0xf3ead8, roughness: 0.25, metalness: 0.1 });
  const diamondGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.002, 4);
  const railMid = CUSHION_W + RAIL_W / 2;
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue;
    const x = -HALF_L + (i * TABLE_L) / 8;
    for (const s of [-1, 1]) addDiamond(table, diamondGeo, pearl, x, s * (HALF_W + railMid));
  }
  for (let j = 1; j < 4; j++) {
    const z = -HALF_W + (j * TABLE_W) / 4;
    for (const s of [-1, 1]) addDiamond(table, diamondGeo, pearl, s * (HALF_L + railMid), z);
  }

  // Cuerpo y patas
  const body = new THREE.Mesh(
    extrudeFlat(roundedRect(railOuterL - 0.05, railOuterW - 0.05, 0.06), 0.3, -0.2, 0.012),
    wood, // UV en metros, como los raíles
  );
  body.castShadow = true;
  table.add(body);

  const legGeo = new THREE.CylinderGeometry(0.07, 0.055, 0.5, 24);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, bodyWood);
      leg.position.set(sx * (railOuterL - 0.2), -0.77, sz * (railOuterW - 0.15));
      leg.castShadow = true;
      table.add(leg);
    }
  }

  // Punto de salida y de pie
  const spotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
  for (const x of [-TABLE_L / 4, TABLE_L / 4]) {
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 16), spotMat);
    spot.rotation.x = -Math.PI / 2;
    spot.position.set(x, 0.0005, 0);
    table.add(spot);
  }

  return table;
}

function addDiamond(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number,
  z: number,
) {
  const d = new THREE.Mesh(geo, mat);
  d.position.set(x, RAIL_H + 0.001, z);
  parent.add(d);
}

export function buildRoom(scene: THREE.Scene) {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(12, 64),
    new THREE.MeshStandardMaterial({ color: 0x1b1512, roughness: 0.85 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.02;
  floor.receiveShadow = true;
  scene.add(floor);

  // Lámpara colgante
  const lamps = new THREE.Group();
  scene.add(lamps);
  const shadeMat = new THREE.MeshStandardMaterial({
    color: 0x14284a,
    roughness: 0.5,
    metalness: 0.3,
    side: THREE.DoubleSide,
  });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xfff3d6 });
  for (const x of [-0.75, 0, 0.75]) {
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.16, 32, 1, true), shadeMat);
    shade.position.set(x, 1.25, 0);
    lamps.add(shade);
    const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.17, 32), glowMat);
    bulb.rotation.x = Math.PI / 2;
    bulb.position.set(x, 1.172, 0);
    lamps.add(bulb);
  }
  const bar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.01, 0.01, 1.9, 8),
    new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 1, roughness: 0.3 }),
  );
  bar.rotation.z = Math.PI / 2;
  bar.position.y = 1.34;
  lamps.add(bar);

  const key = new THREE.SpotLight(0xfff1d8, 16, 6, Math.PI / 3.2, 0.55, 1.4);
  key.position.set(0, 1.2, 0);
  key.target.position.set(0, 0, 0);
  key.castShadow = !low;
  key.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048);
  key.shadow.bias = -0.0002;
  key.shadow.radius = 4;
  scene.add(key, key.target);

  // Sin reflejos de entorno (calidad baja) hace falta algo más de luz ambiente
  scene.add(new THREE.HemisphereLight(0x3a4a5a, 0x120c08, low ? 0.6 : 0.35));
  // Materiales con transparencia para poder desvanecer las lámparas sin cortes
  lamps.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.material = (o.material as THREE.Material).clone();
      o.material.transparent = true;
    }
  });
  const setLampsOpacity = (opacity: number) => {
    lamps.visible = opacity > 0.01;
    lamps.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).opacity = opacity;
    });
  };
  return { setLampsOpacity };
}
