import * as THREE from "three";
import {
  FeltStyle, FloorKind, RailKind, floorTexture, neonTextTexture, planetTexture, railTexture, skyTexture, skylineTexture, starsTexture, wavesTexture,
} from "./textures";

export type RoomId = "local" | "vegas" | "dubai" | "hawaii" | "space";

export interface RoomProps {
  group: THREE.Group;
  /** Per-frame animation, `t` in seconds. */
  tick?: (t: number, dt: number) => void;
}

export interface RoomTheme {
  id: RoomId;
  name: string;
  tagline: string;
  /** CSS accent colour for the UI while this room is selected. */
  accent: string;
  /** Preview colours for menu cards: [sky/surroundings, cloth, rails]. */
  swatch: [string, string, string];
  felt: FeltStyle;
  rail: RailKind;
  railPbr: { roughness: number; metalness: number };
  cushion: number;
  frame: number;
  frameMetal: number;
  diamond: number;
  diamondGlow: boolean;
  legs: boolean;
  bg: number;
  fog: [number, number, number];
  exposure: number;
  env: number;
  light: { spot: number; spotI: number; fill: [number, number]; fillI: number; hemiSky: number; hemiGround: number; hemiI: number };
  build(): RoomProps;
}

const FLOOR_Y = -0.8;

const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
const basic = (o: THREE.MeshBasicMaterialParameters) => new THREE.MeshBasicMaterial({ toneMapped: false, ...o });

function floor(kind: FloorKind, radius: number, rough = 1, metal = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 64), std({ map: floorTexture(kind), roughness: rough, metalness: metal }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = FLOOR_Y;
  m.receiveShadow = true;
  return m;
}

function dome(tex: THREE.Texture): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 20), basic({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }));
  m.renderOrder = -1;
  return m;
}

// ------------------------------------------------------------------ rooms

function buildLocal(): RoomProps {
  const group = new THREE.Group();
  group.add(floor("local", 9));
  return { group };
}

function buildVegas(): RoomProps {
  const group = new THREE.Group();
  group.add(floor("carpet", 9, 0.9));

  const wall = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 6.4, 48, 1, true), std({ color: 0x1c0610, roughness: 0.9, side: THREE.BackSide }));
  wall.position.y = 2.4;
  group.add(wall);
  const ceiling = new THREE.Mesh(new THREE.CircleGeometry(9, 48), basic({ color: 0x05020a }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 5.6;
  group.add(ceiling);

  const neon = (y: number, color: number, tube = 0.045) => {
    const t = new THREE.Mesh(new THREE.TorusGeometry(8.85, tube, 8, 96).rotateX(Math.PI / 2), basic({ color }));
    t.position.y = y;
    group.add(t);
  };
  neon(0.2, 0x2be7ff);
  neon(2.9, 0xff2bd6, 0.07);
  neon(5.0, 0xffc53d);

  // Slot machines around the edge, screens facing the table.
  const body = std({ color: 0x4a0d18, roughness: 0.4, metalness: 0.5 });
  const trim = std({ color: 0xffc53d, roughness: 0.25, metalness: 1 });
  const screens = [0xff2bd6, 0x2be7ff, 0xffc53d, 0x5dff7a].map((c) => basic({ color: c }));
  const N = 14;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + 0.2;
    const m = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.7, 0.6), body);
    b.position.y = 0.05;
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.22, 0.66), trim);
    top.position.y = 1.0;
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.5), screens[i % screens.length]);
    scr.position.set(0, 0.35, 0.31);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), basic({ color: screens[(i + 1) % 4].color }));
    lamp.position.set(0, 1.18, 0);
    m.add(b, top, scr, lamp);
    m.position.set(Math.sin(a) * 7.4, FLOOR_Y + 0.9, Math.cos(a) * 7.4);
    m.lookAt(0, FLOOR_Y + 0.9, 0);
    group.add(m);
  }

  for (const [z, rot] of [[-8.7, 0], [8.7, Math.PI]] as const) {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 1.4), basic({ map: neonTextTexture("LAS VEGAS", "#ff2bd6"), transparent: true }));
    sign.position.set(0, 3.9, z);
    sign.rotation.y = rot;
    group.add(sign);
  }

  const pl: THREE.PointLight[] = [];
  for (const [x, z, c] of [[-4, -4, 0xff2bd6], [4, 4, 0x2be7ff], [4, -4, 0xffc53d]] as const) {
    const l = new THREE.PointLight(c, 3, 0, 2);
    l.position.set(x, 2.2, z);
    group.add(l);
    pl.push(l);
  }
  return {
    group,
    tick: (t) => pl.forEach((l, i) => (l.intensity = 2.6 + Math.sin(t * 1.3 + i * 2) * 0.7)),
  };
}

function buildDubai(): RoomProps {
  const group = new THREE.Group();
  group.add(floor("marble", 9, 0.14, 0.05));

  const sky = new THREE.Mesh(
    new THREE.CylinderGeometry(11, 11, 10, 48, 1, true),
    basic({ map: skylineTexture(), side: THREE.BackSide, fog: false }),
  );
  sky.position.y = 3.4;
  group.add(sky);
  const top = dome(skyTexture([[0, "#0e0e3a"], [0.5, "#3a2a6a"], [1, "#9a5a8a"]]));
  group.add(top);

  const gold = std({ color: 0xd4af37, roughness: 0.22, metalness: 1 });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 5.2, 20), gold);
    p.position.set(Math.sin(a) * 6.8, FLOOR_Y + 2.6, Math.cos(a) * 6.8);
    p.castShadow = true;
    group.add(p);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.2, 0.18, 20), gold);
    cap.position.set(p.position.x, FLOOR_Y + 5.2, p.position.z);
    group.add(cap);
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.03, 8, 96).rotateX(Math.PI / 2), gold);
  ring.position.y = FLOOR_Y + 0.01;
  group.add(ring);

  const l = new THREE.PointLight(0xffb86b, 4, 0, 2);
  l.position.set(-3, 2.5, 3);
  group.add(l);
  return { group };
}

function palm(trunkMat: THREE.Material, leafMat: THREE.Material, seed: number): THREE.Group {
  const g = new THREE.Group();
  const h = 3.4 + (seed % 3) * 0.4;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, h, 10), trunkMat);
  trunk.position.y = h / 2;
  trunk.castShadow = true;
  g.add(trunk);
  const crown = new THREE.Group();
  crown.position.y = h;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.018, 0.26), leafMat);
    leaf.geometry.translate(0.75, 0, 0);
    leaf.rotation.set(0, -a, -0.38);
    crown.add(leaf);
  }
  g.add(crown);
  g.rotation.z = ((seed % 5) - 2) * 0.03;
  return g;
}

function buildHawaii(): RoomProps {
  const group = new THREE.Group();
  group.add(floor("sand", 6.2));
  const deck = floor("deck", 3.3, 0.7);
  deck.position.y = FLOOR_Y + 0.01;
  group.add(deck);

  const sea = new THREE.Mesh(new THREE.RingGeometry(6.1, 44, 64).rotateX(-Math.PI / 2), std({ map: wavesTexture(), roughness: 0.2, metalness: 0.3 }));
  sea.position.y = FLOOR_Y - 0.08;
  group.add(sea);

  group.add(dome(skyTexture([[0, "#2f6fc0"], [0.38, "#79b7e8"], [0.5, "#ffd9a0"], [0.58, "#f59e5b"], [0.6, "#2a7fb0"], [1, "#1788b8"]])));
  const sun = new THREE.Mesh(new THREE.CircleGeometry(2.4, 32), basic({ color: 0xfff2c0, fog: false }));
  sun.position.set(-8, 0.5, -34);
  sun.lookAt(0, 0, 0);
  group.add(sun);

  const trunk = std({ color: 0x7a5230, roughness: 0.9 });
  const leaf = std({ color: 0x2f9a4c, roughness: 0.7, side: THREE.DoubleSide });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const p = palm(trunk, leaf, i);
    p.position.set(Math.sin(a) * 5, FLOOR_Y, Math.cos(a) * 5);
    group.add(p);
  }
  const flame = basic({ color: 0xffa33a });
  const stick = std({ color: 0x5a3a1c });
  const flames: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.6, 8), stick);
    s.position.set(Math.sin(a) * 2.9, FLOOR_Y + 0.8, Math.cos(a) * 2.9);
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), flame);
    f.position.set(s.position.x, FLOOR_Y + 1.75, s.position.z);
    flames.push(f);
    group.add(s, f);
  }
  const warm = new THREE.PointLight(0xffa860, 3, 0, 2);
  warm.position.set(0, 1.6, 0);
  group.add(warm);
  return {
    group,
    tick: (t) => {
      const map = (sea.material as THREE.MeshStandardMaterial).map!;
      map.offset.set((t * 0.01) % 1, (t * 0.006) % 1);
      flames.forEach((f, i) => f.scale.setScalar(1 + Math.sin(t * 9 + i * 1.7) * 0.18));
    },
  };
}

function buildSpace(): RoomProps {
  const group = new THREE.Group();
  group.add(dome(starsTexture()));

  const planet = new THREE.Mesh(new THREE.SphereGeometry(4, 48, 32), std({ map: planetTexture(), roughness: 0.9, emissive: 0x2a1408, emissiveIntensity: 0.6 }));
  planet.position.set(-11, 3.5, -17);
  planet.rotation.z = 0.35;
  group.add(planet);
  const ringGeo = new THREE.RingGeometry(5.4, 8.6, 96);
  const ringMesh = new THREE.Mesh(ringGeo, basic({ color: 0xd9b88a, transparent: true, opacity: 0.45, side: THREE.DoubleSide, fog: false }));
  ringMesh.position.copy(planet.position);
  ringMesh.rotation.set(Math.PI / 2 - 0.25, 0, 0.35);
  group.add(ringMesh);

  const moon = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 16), std({ color: 0x9aa4b2, roughness: 1 }));
  moon.position.set(12, 5, -12);
  group.add(moon);

  const COUNT = 46;
  const rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.2, 0), std({ color: 0x6a6270, roughness: 1, flatShading: true }), COUNT);
  const seed = Array.from({ length: COUNT }, () => ({
    r: 5 + Math.random() * 9, a: Math.random() * Math.PI * 2, y: -1.5 + Math.random() * 6,
    s: 0.4 + Math.random() * 1.6, sp: 0.01 + Math.random() * 0.03, rot: Math.random() * 6,
  }));
  const o = new THREE.Object3D();

  // A glass platform with a glowing rim under the table.
  const disc = new THREE.Mesh(new THREE.CircleGeometry(2.6, 64).rotateX(-Math.PI / 2), std({ color: 0x0b1a2c, roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.55 }));
  disc.position.y = FLOOR_Y + 0.4;
  disc.receiveShadow = true;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.03, 8, 96).rotateX(Math.PI / 2), basic({ color: 0x35e8ff }));
  rim.position.y = FLOOR_Y + 0.4;
  group.add(disc, rim, rocks);

  const blue = new THREE.PointLight(0x35e8ff, 3, 0, 2);
  blue.position.set(0, -0.2, 0);
  group.add(blue);

  return {
    group,
    tick: (t) => {
      planet.rotation.y = t * 0.02;
      seed.forEach((s, i) => {
        const a = s.a + t * s.sp;
        o.position.set(Math.sin(a) * s.r, s.y + Math.sin(t * 0.3 + i) * 0.2, Math.cos(a) * s.r);
        o.rotation.set(t * 0.2 + s.rot, t * 0.15, 0);
        o.scale.setScalar(s.s);
        o.updateMatrix();
        rocks.setMatrixAt(i, o.matrix);
      });
      rocks.instanceMatrix.needsUpdate = true;
    },
  };
}

// ------------------------------------------------------------------ themes

export const ROOMS: Record<RoomId, RoomTheme> = {
  local: {
    id: "local", name: "Local Pool", tagline: "Classic corner hall", accent: "#2fcf8a",
    swatch: ["#12161d", "#146b45", "#7d4a24"],
    felt: { base: "#146b45", glow: "rgba(255,255,255,0.06)", line: "rgba(255,255,255,0.25)" },
    rail: "oak", railPbr: { roughness: 0.45, metalness: 0.05 },
    cushion: 0x0f5a3a, frame: 0x2a1a10, frameMetal: 0, diamond: 0xe9ddbf, diamondGlow: false, legs: true,
    bg: 0x07090c, fog: [0x07090c, 7, 16], exposure: 1.05, env: 0.4,
    light: { spot: 0xfff0d6, spotI: 26, fill: [0xffffff, 0xffffff], fillI: 3.5, hemiSky: 0xdfe8ff, hemiGround: 0x1a1208, hemiI: 0.35 },
    build: buildLocal,
  },
  vegas: {
    id: "vegas", name: "Las Vegas", tagline: "Neon casino floor", accent: "#ff2bd6",
    swatch: ["#2a0a22", "#8f1226", "#16161c"],
    felt: { base: "#8f1226", glow: "rgba(255,170,190,0.10)", lattice: "rgba(255,200,90,0.07)", line: "rgba(255,215,120,0.45)" },
    rail: "lacquer", railPbr: { roughness: 0.22, metalness: 0.35 },
    cushion: 0x5a0e1a, frame: 0x0c0c10, frameMetal: 0.4, diamond: 0xffcf4a, diamondGlow: true, legs: true,
    bg: 0x12040a, fog: [0x12040a, 9, 24], exposure: 1.1, env: 0.55,
    light: { spot: 0xffe2a8, spotI: 30, fill: [0xff2bd6, 0x2be7ff], fillI: 3.5, hemiSky: 0xff9ad8, hemiGround: 0x2a0818, hemiI: 0.4 },
    build: buildVegas,
  },
  dubai: {
    id: "dubai", name: "Dubai", tagline: "Skyline penthouse", accent: "#f5c451",
    swatch: ["#3a2a6a", "#0f2a6b", "#f6f2ea"],
    felt: { base: "#0f2a6b", glow: "rgba(150,190,255,0.10)", lattice: "rgba(245,215,122,0.08)", line: "rgba(245,215,122,0.5)" },
    rail: "marble", railPbr: { roughness: 0.18, metalness: 0.1 },
    cushion: 0x0c2350, frame: 0xb89432, frameMetal: 0.9, diamond: 0xf5d77a, diamondGlow: false, legs: true,
    bg: 0x1a1030, fog: [0x2a1a3a, 14, 34], exposure: 1.1, env: 0.65,
    light: { spot: 0xfff0d0, spotI: 30, fill: [0xffb86b, 0xffd9a0], fillI: 3, hemiSky: 0xffd9a0, hemiGround: 0x241838, hemiI: 0.45 },
    build: buildDubai,
  },
  hawaii: {
    id: "hawaii", name: "Hawaii", tagline: "Beach cabana at sunset", accent: "#ff9f43",
    swatch: ["#f59e5b", "#12a3a6", "#d2a955"],
    felt: { base: "#0d8c91", glow: "rgba(255,255,255,0.10)", line: "rgba(255,255,255,0.4)" },
    rail: "bamboo", railPbr: { roughness: 0.55, metalness: 0 },
    cushion: 0x0a7f86, frame: 0x8a5a2b, frameMetal: 0, diamond: 0xffffff, diamondGlow: false, legs: true,
    bg: 0x79b7e8, fog: [0xf0c493, 16, 46], exposure: 1.02, env: 0.55,
    light: { spot: 0xffe6c0, spotI: 30, fill: [0xffa860, 0xffd0a0], fillI: 3, hemiSky: 0xbfe0ff, hemiGround: 0xe6c98b, hemiI: 0.55 },
    build: buildHawaii,
  },
  space: {
    id: "space", name: "Space Station", tagline: "Zero-G orbital lounge", accent: "#35e8ff",
    swatch: ["#120a2a", "#3a1a78", "#9aa4b2"],
    felt: { base: "#2b1457", glow: "rgba(170,120,255,0.14)", stars: true, line: "rgba(120,240,255,0.5)" },
    rail: "metal", railPbr: { roughness: 0.35, metalness: 0.85 },
    cushion: 0x2d1450, frame: 0x2b3340, frameMetal: 0.8, diamond: 0x4df3ff, diamondGlow: true, legs: false,
    bg: 0x04030b, fog: [0x04030b, 60, 120], exposure: 1.0, env: 0.35,
    light: { spot: 0xcfe0ff, spotI: 28, fill: [0x35e8ff, 0x9a6bff], fillI: 3.5, hemiSky: 0x6a8cff, hemiGround: 0x120a2a, hemiI: 0.3 },
    build: buildSpace,
  },
};

export const ROOM_ORDER: RoomId[] = ["local", "vegas", "dubai", "hawaii", "space"];

export { railTexture };
