import * as THREE from 'three';
import {
  BALL_R,
  CORNER_GAP,
  CUSHION_W,
  POCKETS,
  RAIL_W,
  SIDE_GAP,
  TABLE_L,
  TABLE_W,
} from './constants';

const HALF_L = TABLE_L / 2;
const HALF_W = TABLE_W / 2;
const CUSHION_H = BALL_R * 1.35;
const RAIL_H = CUSHION_H + 0.006;

export function buildTable(): THREE.Group {
  const table = new THREE.Group();

  const cloth = new THREE.MeshStandardMaterial({ color: 0x15584a, roughness: 0.95 });
  const cushionCloth = new THREE.MeshStandardMaterial({ color: 0x114a3e, roughness: 0.9 });
  const wood = new THREE.MeshPhysicalMaterial({
    color: 0x4a2414,
    roughness: 0.38,
    clearcoat: 0.8,
    clearcoatRoughness: 0.18,
  });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 1, roughness: 0.3 });
  const pocketMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 });

  // Paño con agujeros para las troneras
  const outer = HALF_L + CUSHION_W;
  const outerW = HALF_W + CUSHION_W;
  const shape = new THREE.Shape();
  shape.moveTo(-outer, -outerW);
  shape.lineTo(outer, -outerW);
  shape.lineTo(outer, outerW);
  shape.lineTo(-outer, outerW);
  shape.closePath();
  for (const p of POCKETS) {
    const hole = new THREE.Path();
    hole.absarc(p.x, -p.z, p.r, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const clothGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false, curveSegments: 32 });
  clothGeo.rotateX(-Math.PI / 2);
  clothGeo.translate(0, -0.03, 0);
  const clothMesh = new THREE.Mesh(clothGeo, cloth);
  clothMesh.receiveShadow = true;
  table.add(clothMesh);

  // Troneras: cilindros negros bajo los agujeros + aro de latón
  for (const p of POCKETS) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 0.85, 0.16, 32), pocketMat);
    cup.position.set(p.x, -0.11, p.z);
    table.add(cup);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(p.r + 0.002, 0.004, 12, 40), brass);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(p.x, 0.001, p.z);
    table.add(ring);
  }

  // Bandas (cojines) con huecos en las troneras
  const addCushion = (x0: number, x1: number, z0: number, z1: number) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(Math.abs(x1 - x0), CUSHION_H, Math.abs(z1 - z0)),
      cushionCloth,
    );
    m.position.set((x0 + x1) / 2, CUSHION_H / 2, (z0 + z1) / 2);
    m.castShadow = true;
    m.receiveShadow = true;
    table.add(m);
  };
  for (const s of [-1, 1]) {
    // largas: dos tramos cada una
    addCushion(-HALF_L + CORNER_GAP, -SIDE_GAP, s * HALF_W, s * (HALF_W + CUSHION_W));
    addCushion(SIDE_GAP, HALF_L - CORNER_GAP, s * HALF_W, s * (HALF_W + CUSHION_W));
    // cortas
    addCushion(s * HALF_L, s * (HALF_L + CUSHION_W), -HALF_W + CORNER_GAP, HALF_W - CORNER_GAP);
  }

  // Raíles de madera
  const railOuterL = HALF_L + CUSHION_W + RAIL_W;
  const railOuterW = HALF_W + CUSHION_W + RAIL_W;
  const railShape = new THREE.Shape();
  railShape.moveTo(-railOuterL, -railOuterW);
  railShape.lineTo(railOuterL, -railOuterW);
  railShape.lineTo(railOuterL, railOuterW);
  railShape.lineTo(-railOuterL, railOuterW);
  railShape.closePath();
  const inner = new THREE.Path();
  inner.moveTo(-outer, -outerW);
  inner.lineTo(-outer, outerW);
  inner.lineTo(outer, outerW);
  inner.lineTo(outer, -outerW);
  inner.closePath();
  railShape.holes.push(inner);
  const railDepth = RAIL_H + 0.22;
  const railGeo = new THREE.ExtrudeGeometry(railShape, {
    depth: railDepth,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 4,
  });
  railGeo.rotateX(-Math.PI / 2);
  railGeo.translate(0, RAIL_H - railDepth, 0);
  const rails = new THREE.Mesh(railGeo, wood);
  rails.castShadow = true;
  rails.receiveShadow = true;
  table.add(rails);

  // Superficie del raíl entre paño y madera (tapa el hueco bajo las troneras)
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(2 * outer, 0.2, 2 * outerW),
    new THREE.MeshStandardMaterial({ color: 0x0b0b0b }),
  );
  deck.position.y = -0.2;
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
    new THREE.BoxGeometry(2 * railOuterL - 0.08, 0.32, 2 * railOuterW - 0.08),
    wood,
  );
  body.position.y = -0.36;
  body.castShadow = true;
  table.add(body);

  const legGeo = new THREE.CylinderGeometry(0.07, 0.055, 0.5, 24);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, wood);
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
  const shadeMat = new THREE.MeshStandardMaterial({
    color: 0x0f3d2e,
    roughness: 0.5,
    metalness: 0.3,
    side: THREE.DoubleSide,
  });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xfff3d6 });
  for (const x of [-0.75, 0, 0.75]) {
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.16, 32, 1, true), shadeMat);
    shade.position.set(x, 1.25, 0);
    scene.add(shade);
    const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.17, 32), glowMat);
    bulb.rotation.x = Math.PI / 2;
    bulb.position.set(x, 1.172, 0);
    scene.add(bulb);
  }
  const bar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.01, 0.01, 1.9, 8),
    new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 1, roughness: 0.3 }),
  );
  bar.rotation.z = Math.PI / 2;
  bar.position.y = 1.34;
  scene.add(bar);

  const key = new THREE.SpotLight(0xfff1d8, 16, 6, Math.PI / 3.2, 0.55, 1.4);
  key.position.set(0, 1.2, 0);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0002;
  key.shadow.radius = 4;
  scene.add(key, key.target);

  scene.add(new THREE.HemisphereLight(0x3a4a5a, 0x120c08, 0.35));
}
