import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { BALL_R, GameState, HEAD_SPOT, POCKETS, TABLE_H, TABLE_W } from "@8pool/shared";
import { FELT_MARGIN, ballTexture, feltTexture, railTexture } from "./textures";
import { ROOMS, RoomId, RoomProps } from "./rooms";

function disposeTree(o: THREE.Object3D): void {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      (mat as THREE.MeshStandardMaterial).map?.dispose();
      mat.dispose();
    }
  });
}

const M = 0.001; // mm -> world metres
const BR = BALL_R * M;
const TW = TABLE_W * M;
const TH = TABLE_H * M;
const RAIL_W = 0.12;
const FOV = 40;
const OUTER_W = TW + 2 * (FELT_MARGIN + RAIL_W);
const OUTER_H = TH + 2 * (FELT_MARGIN + RAIL_W);

const ROOM_KEY = "8pool.room";
function readRoom(): RoomId {
  try {
    const v = localStorage.getItem(ROOM_KEY) as RoomId | null;
    if (v && v in ROOMS) return v;
  } catch { /* storage unavailable */ }
  return "local";
}

/** Table mm (origin top-left) to world metres (origin table centre, y up). */
export const wx = (mmX: number): number => mmX * M - TW / 2;
export const wz = (mmY: number): number => mmY * M - TH / 2;

export type CamMode = "menu" | "aim" | "top" | "watch";
export interface Insets { l: number; r: number; t: number; b: number }
export interface Pt { x: number; y: number }
export interface Guide {
  c: Pt;
  e: Pt;
  ghost: boolean;
  /** Object ball centre and the unit direction it will travel after impact. */
  obj?: { x: number; y: number; dx: number; dy: number };
  /** Cue ball direction after impact (unit) and a display length in mm. */
  defl?: { dx: number; dy: number; len: number };
}

/** A thin flat bar lying on the table, used for aim guides. */
class Beam {
  readonly mesh: THREE.Mesh;
  constructor(parent: THREE.Object3D, color: number, opacity: number, width: number, private y = BR) {
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.0012, width),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
    parent.add(this.mesh);
  }
  set(ax: number, ay: number, bx: number, by: number): void {
    const x1 = wx(ax), z1 = wz(ay), x2 = wx(bx), z2 = wz(by);
    const len = Math.hypot(x2 - x1, z2 - z1);
    this.mesh.visible = len > 0.002;
    this.mesh.position.set((x1 + x2) / 2, this.y, (z1 + z2) / 2);
    this.mesh.scale.x = len;
    this.mesh.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
  }
  hide(): void { this.mesh.visible = false; }
}

/** Rounded rectangle centred on the origin, wound counter-clockwise. */
function roundedRect(path: THREE.Path, hw: number, hh: number, r: number): void {
  path.moveTo(-hw + r, -hh);
  path.lineTo(hw - r, -hh);
  path.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);
  path.lineTo(hw, hh - r);
  path.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);
  path.lineTo(-hw + r, hh);
  path.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(-hw, -hh + r);
  path.absarc(-hw + r, -hh + r, r, Math.PI, Math.PI * 1.5, false);
}

interface BallView { mesh: THREE.Mesh; x: number; y: number; drop: number; fx: number; fz: number; tx: number; tz: number }

export class Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 80);
  private tmpCam = new THREE.PerspectiveCamera(FOV, 1, 0.05, 80);
  private balls: BallView[] = [];
  private spot!: THREE.SpotLight;
  private hemi!: THREE.HemisphereLight;
  private fills: THREE.PointLight[] = [];

  // Table skin, retextured when the room changes.
  private feltMat!: THREE.MeshStandardMaterial;
  private woodMat!: THREE.MeshStandardMaterial;
  private cushionMat!: THREE.MeshStandardMaterial;
  private frameMat!: THREE.MeshStandardMaterial;
  private diaMat!: THREE.MeshStandardMaterial;
  private legs: THREE.Mesh[] = [];
  private room: RoomProps | null = null;
  roomId: RoomId = "local";
  private roomTime = 0;
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BR);

  private mode: CamMode = "menu";
  private insets: Insets = { l: 0, r: 0, t: 0, b: 0 };
  private snap = true;
  /** Eased camera move after a mode change, from the pose the camera had when it started. */
  private trans: { t: number; dur: number; pos: THREE.Vector3; quat: THREE.Quaternion } | null = null;
  private time = 0;
  private w = 1;
  private h = 1;
  portrait = false;

  private aim = { x: 0, y: 0, dx: 1, dy: 0 };
  private cueSpin = { x: 0, y: 0 };

  private cue = new THREE.Group();
  private cuePivot = new THREE.Group();
  private cueState = { visible: false, pull: 0, strike: -1, from: 0 };
  private beams!: { main: Beam; obj: Beam; defl: Beam; head: Beam };
  private ring!: THREE.Mesh;
  private ghost!: THREE.Mesh;

  private last = 0;
  private slow = 0;
  private qualityStep = 0;
  private lowQuality = false;
  /** Called every frame before rendering, with the elapsed milliseconds. */
  frameHook: ((dtMs: number) => void) | null = null;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.canvas = this.renderer.domElement;
    this.canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none;outline:none";
    container.appendChild(this.canvas);

    this.scene.background = new THREE.Color(0x07090c);
    this.scene.fog = new THREE.Fog(0x07090c, 7, 16);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.buildLights();
    this.buildTable();
    this.buildBalls();
    this.buildCue();
    this.buildGuides();
    this.setRoom(readRoom());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  // ---------------------------------------------------------------- construction

  private buildLights(): void {
    this.hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1208, 0.35);
    this.scene.add(this.hemi);
    const s = new THREE.SpotLight(0xfff0d6, 26, 0, 1.0, 0.7, 2);
    s.position.set(0, 2.3, 0.05);
    s.castShadow = true;
    s.shadow.mapSize.set(2048, 2048);
    s.shadow.bias = -0.0004;
    s.shadow.radius = 4;
    s.shadow.camera.near = 1;
    s.shadow.camera.far = 4;
    this.scene.add(s, s.target);
    this.spot = s;
    for (const x of [-1.2, 1.2]) {
      const p = new THREE.PointLight(0xffffff, 3.5, 0, 2);
      p.position.set(x, 1.4, 0);
      this.scene.add(p);
      this.fills.push(p);
    }
  }

  /** Swap the surroundings, cloth, rails and lighting. Balls, cue and guides stay as they are. */
  setRoom(id: RoomId, persist = true): void {
    const t = ROOMS[id];
    this.roomId = id;
    if (persist) {
      try { localStorage.setItem(ROOM_KEY, id); } catch { /* storage unavailable */ }
    }

    this.feltMat.map?.dispose();
    this.feltMat.map = feltTexture(t.felt);
    this.woodMat.map?.dispose();
    this.woodMat.map = railTexture(t.rail);
    this.woodMat.roughness = t.railPbr.roughness;
    this.woodMat.metalness = t.railPbr.metalness;
    this.cushionMat.color.setHex(t.cushion);
    this.frameMat.color.setHex(t.frame);
    this.frameMat.metalness = t.frameMetal;
    this.frameMat.roughness = t.frameMetal > 0.5 ? 0.3 : 0.6;
    this.diaMat.color.setHex(t.diamond);
    this.diaMat.emissive.setHex(t.diamondGlow ? t.diamond : 0);
    this.diaMat.emissiveIntensity = 1.4;
    for (const m of [this.feltMat, this.woodMat, this.frameMat, this.diaMat]) m.needsUpdate = true;
    this.legs.forEach((l) => (l.visible = t.legs));

    if (this.room) {
      this.scene.remove(this.room.group);
      disposeTree(this.room.group);
    }
    this.room = t.build();
    this.scene.add(this.room.group);

    (this.scene.background as THREE.Color).setHex(t.bg);
    this.scene.fog = new THREE.Fog(t.fog[0], t.fog[1], t.fog[2]);
    this.scene.environmentIntensity = t.env;
    this.renderer.toneMappingExposure = t.exposure;
    this.hemi.color.setHex(t.light.hemiSky);
    this.hemi.groundColor.setHex(t.light.hemiGround);
    this.hemi.intensity = t.light.hemiI;
    this.spot.color.setHex(t.light.spot);
    this.spot.intensity = t.light.spotI;
    this.fills.forEach((p, i) => {
      p.color.setHex(t.light.fill[i % 2]);
      p.intensity = t.light.fillI;
    });
  }

  private buildTable(): void {
    const g = new THREE.Group();
    this.scene.add(g);

    this.feltMat = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0 });
    const felt = new THREE.Mesh(new THREE.PlaneGeometry(TW + 2 * FELT_MARGIN, TH + 2 * FELT_MARGIN).rotateX(-Math.PI / 2), this.feltMat);
    felt.receiveShadow = true;
    g.add(felt);

    // Cushions: a sloped profile extruded along each side, with gaps at the pockets.
    const T = FELT_MARGIN;
    const profile = new THREE.Shape([
      new THREE.Vector2(0, 0), new THREE.Vector2(T, 0), new THREE.Vector2(T, 0.046), new THREE.Vector2(0, 0.03),
    ]);
    const cushionMat = (this.cushionMat = new THREE.MeshStandardMaterial({ color: 0x0f5a3a, roughness: 0.9 }));
    const cushion = (len: number, rotY: number, x: number, z: number) => {
      const geo = new THREE.ExtrudeGeometry(profile, { depth: len, bevelEnabled: false });
      geo.translate(0, 0, -len / 2);
      const m = new THREE.Mesh(geo, cushionMat);
      m.rotation.y = rotY;
      m.position.set(x, 0, z);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    };
    const cornerGap = 0.078;
    const sideGap = 0.072;
    const half = TW / 2 - cornerGap - sideGap;
    const lenLong = half;
    const centreLong = sideGap + half / 2;
    for (const [rot, z] of [[Math.PI / 2, -TH / 2], [-Math.PI / 2, TH / 2]] as const) {
      cushion(lenLong, rot, -centreLong, z);
      cushion(lenLong, rot, centreLong, z);
    }
    const lenShort = TH - 2 * cornerGap;
    cushion(lenShort, 0, TW / 2, 0);
    cushion(lenShort, Math.PI, -TW / 2, 0);

    // Wood rail frame: one rounded slab. Its opening has rounded corners concentric with the corner pockets,
    // and the outer corners are rounded too, so the table reads as a real, soft-edged cabinet.
    const woodMat = (this.woodMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 }));
    const outer = new THREE.Shape();
    roundedRect(outer, OUTER_W / 2, OUTER_H / 2, 0.21);
    const hole = new THREE.Path();
    roundedRect(hole, TW / 2 + FELT_MARGIN, TH / 2 + FELT_MARGIN, FELT_MARGIN);
    outer.holes.push(hole);
    const BEV = 0.009;
    const frameGeo = new THREE.ExtrudeGeometry(outer, {
      depth: 0.06 - 2 * BEV, bevelEnabled: true, bevelThickness: BEV, bevelSize: BEV, bevelOffset: -BEV, bevelSegments: 4, curveSegments: 28,
      UVGenerator: {
        // Wood grain runs along x, one texture repeat per metre.
        generateTopUV: (_g, v, a, b, c) =>
          [a, b, c].map((i) => {
            const x = v[i * 3], y = v[i * 3 + 1];
            // The short rails get their grain running along y.
            return Math.abs(x) > TW / 2 + FELT_MARGIN ? new THREE.Vector2(y, x * 8) : new THREE.Vector2(x, y * 8);
          }),
        generateSideWallUV: (_g, v, a, b, c, d) => [a, b, c, d].map((i) => new THREE.Vector2(v[i * 3] + v[i * 3 + 1], v[i * 3 + 2] * 8)),
      },
    });
    frameGeo.rotateX(-Math.PI / 2).translate(0, BEV - 0.01, 0); // top surface at y = 0.05
    const frame = new THREE.Mesh(frameGeo, woodMat);
    frame.castShadow = true;
    frame.receiveShadow = true;
    g.add(frame);

    // Dark pocket rims, so each pocket mouth reads as a round opening.
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.5, metalness: 0.3 });
    for (const p of POCKETS) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(p.r * M * 1.1, 0.0075, 10, 40).rotateX(Math.PI / 2), rimMat);
      rim.position.set(wx(p.x), 0.005, wz(p.y));
      g.add(rim);
    }
    const off = FELT_MARGIN + RAIL_W / 2;

    // Diamond sights.
    const dia = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.0085, 16).rotateX(-Math.PI / 2),
      (this.diaMat = new THREE.MeshStandardMaterial({ color: 0xe9ddbf, roughness: 0.3, metalness: 0.4 })),
      7 * 2 + 3 * 2,
    );
    const mtx = new THREE.Matrix4();
    let n = 0;
    for (let i = 1; i <= 7; i++) {
      if (i === 4) continue; // side pocket
      for (const z of [-TH / 2 - off, TH / 2 + off]) dia.setMatrixAt(n++, mtx.makeTranslation(-TW / 2 + (TW * i) / 8, 0.0505, z));
    }
    for (let i = 1; i <= 3; i++) {
      for (const x of [-TW / 2 - off, TW / 2 + off]) dia.setMatrixAt(n++, mtx.makeTranslation(x, 0.0505, -TH / 2 + (TH * i) / 4));
    }
    dia.count = n;
    g.add(dia);

    // Apron and legs, with rounded corners to match the frame.
    const dark = (this.frameMat = new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.6 }));
    const apronShape = new THREE.Shape();
    roundedRect(apronShape, OUTER_W / 2 - 0.035, OUTER_H / 2 - 0.035, 0.18);
    const apron = new THREE.Mesh(new THREE.ExtrudeGeometry(apronShape, { depth: 0.14, bevelEnabled: false, curveSegments: 28 }).rotateX(-Math.PI / 2).translate(0, -0.15, 0), dark);
    apron.castShadow = true;
    g.add(apron);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.045, 0.72, 24), dark);
        leg.position.set(sx * (OUTER_W / 2 - 0.22), -0.45, sz * (OUTER_H / 2 - 0.22));
        leg.castShadow = true;
        this.legs.push(leg);
        g.add(leg);
      }
    }
  }

  private buildBalls(): void {
    const geo = new THREE.SphereGeometry(BR, 56, 40);
    for (let id = 0; id < 16; id++) {
      const mat = new THREE.MeshPhysicalMaterial({
        map: ballTexture(id), roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.025, specularIntensity: 1, sheen: 0.15, sheenRoughness: 0.4,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.position.set(0, BR, 0);
      this.scene.add(mesh);
      this.balls.push({ mesh, x: 0, y: 0, drop: -1, fx: 0, fz: 0, tx: 0, tz: 0 });
      this.orient(id);
    }
  }

  /** Numbers face up, with a random spin so a rack doesn't look stamped. */
  private orient(id: number): void {
    const up = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.9);
    this.balls[id].mesh.quaternion.copy(spin.multiply(up));
  }

  private buildCue(): void {
    const seg = (len: number, rFront: number, rBack: number, color: number, front: number, rough = 0.5) => {
      const geo = new THREE.CylinderGeometry(rFront, rBack, len, 20).rotateZ(-Math.PI / 2).translate(front - len / 2, 0, 0);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 }));
      m.castShadow = true;
      this.cuePivot.add(m);
    };
    seg(0.012, 0.0052, 0.0054, 0x3a74c0, 0, 0.9);
    seg(0.022, 0.0056, 0.0058, 0xf5f2ea, -0.012, 0.3);
    seg(0.72, 0.0060, 0.0098, 0xe9cb97, -0.034);
    seg(0.76, 0.0098, 0.0150, 0x2b1b12, -0.754);
    this.cuePivot.rotation.z = -0.05;
    this.cue.add(this.cuePivot);
    this.cue.visible = false;
    this.scene.add(this.cue);
  }

  private buildGuides(): void {
    this.beams = {
      main: new Beam(this.scene, 0xffffff, 0.9, 0.0048),
      obj: new Beam(this.scene, 0xffe08a, 0.9, 0.0048),
      defl: new Beam(this.scene, 0xffffff, 0.5, 0.0036),
      head: new Beam(this.scene, 0xffd166, 0.55, 0.004, 0.003),
    };
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(BR - 0.0028, BR, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    this.scene.add(this.ring);
    this.ghost = new THREE.Mesh(
      new THREE.SphereGeometry(BR, 28, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  // ---------------------------------------------------------------- public API

  placeBall(id: number, x: number, y: number, visible: boolean, roll = false): void {
    const b = this.balls[id];
    if (roll && b.mesh.visible && b.drop < 0) {
      const dx = (x - b.x) * M;
      const dz = (y - b.y) * M;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-6) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(dz, 0, -dx).normalize(), dist / BR);
        b.mesh.quaternion.premultiply(q);
      }
    }
    b.x = x;
    b.y = y;
    b.drop = -1;
    b.mesh.scale.setScalar(1);
    b.mesh.position.set(wx(x), BR, wz(y));
    b.mesh.visible = visible;
  }

  /** Roll a ball into the nearest pocket and sink it. */
  dropBall(id: number): void {
    const b = this.balls[id];
    if (!b.mesh.visible || b.drop >= 0) return;
    let best: { x: number; y: number } = POCKETS[0];
    let bd = Infinity;
    for (const p of POCKETS) {
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < bd) { bd = d; best = p; }
    }
    b.fx = b.mesh.position.x;
    b.fz = b.mesh.position.z;
    b.tx = wx(best.x);
    b.tz = wz(best.y);
    b.drop = 0;
  }

  /** Set the ball layout from a game state without spin. */
  rack(state: GameState): void {
    state.balls.forEach((b, id) => {
      this.orient(id);
      this.placeBall(id, b.x, b.y, !b.pocketed);
    });
  }

  /** `slow` is for a deliberate 3D/2D switch, which should glide rather than cut. */
  setCamera(mode: CamMode, snap = false, slow = false): void {
    if (mode !== this.mode) {
      this.mode = mode;
      if (!snap && !this.snap) {
        this.trans = { t: 0, dur: slow ? 1.5 : 1.0, pos: this.camera.position.clone(), quat: this.camera.quaternion.clone() };
      }
    }
    if (snap) {
      this.snap = true;
      this.trans = null;
    }
  }

  setInsets(i: Insets): void {
    this.insets = i;
    this.applyView();
  }

  /** Cue ball position and shot direction (radians, table coordinates). Drives the aim camera and the cue. */
  setAim(x: number, y: number, angle: number): void {
    this.aim = { x, y, dx: Math.cos(angle), dy: Math.sin(angle) };
  }

  /** Offset the cue tip on the cue ball face: x right, y up. */
  setCueSpin(x: number, y: number): void {
    this.cueSpin = { x, y };
  }

  showCue(visible: boolean, pull = 0): void {
    if (!visible && this.cueState.strike >= 0) return; // let the strike finish
    this.cueState.visible = visible;
    if (visible) {
      this.cueState.strike = -1;
      this.cueState.pull = pull;
    }
  }

  /** Quick forward jab, then the cue disappears. */
  strikeCue(): void {
    if (!this.cueState.visible) return;
    this.cueState.from = this.cueState.pull;
    this.cueState.strike = 0;
  }

  setGuide(g: Guide | null): void {
    const { main, obj, defl } = this.beams;
    if (!g) {
      main.hide(); obj.hide(); defl.hide();
      this.ring.visible = false;
      return;
    }
    main.set(g.c.x, g.c.y, g.e.x, g.e.y);
    this.ring.visible = g.ghost;
    this.ring.position.set(wx(g.e.x), 0.004, wz(g.e.y));
    if (g.obj) obj.set(g.obj.x, g.obj.y, g.obj.x + g.obj.dx * 260, g.obj.y + g.obj.dy * 260);
    else obj.hide();
    if (g.defl) defl.set(g.e.x, g.e.y, g.e.x + g.defl.dx * g.defl.len, g.e.y + g.defl.dy * g.defl.len);
    else defl.hide();
  }

  setGhostBall(p: (Pt & { ok: boolean }) | null): void {
    if (!p) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.visible = true;
    this.ghost.position.set(wx(p.x), BR, wz(p.y));
    (this.ghost.material as THREE.MeshBasicMaterial).color.set(p.ok ? 0xffffff : 0xe03c3c);
  }

  setBreakLine(on: boolean): void {
    if (on) this.beams.head.set(HEAD_SPOT.x, 0, HEAD_SPOT.x, TABLE_H);
    else this.beams.head.hide();
  }

  /** Client coordinates to table mm on the ball-centre plane, or null when the ray misses. */
  pick(clientX: number, clientY: number): Pt | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, out)) return null;
    return { x: (out.x + TW / 2) / M, y: (out.z + TH / 2) / M };
  }

  // ---------------------------------------------------------------- frame

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.w = w;
    this.h = h;
    this.portrait = h > w * 1.05;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.tmpCam.aspect = w / h;
    this.applyView();
    this.snap = true;
  }

  private applyView(): void {
    const { l, r, t, b } = this.insets;
    if (l || r || t || b) this.camera.setViewOffset(this.w, this.h, (r - l) / 2, (b - t) / 2, this.w, this.h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** Camera height that fits the whole table inside the area not covered by the HUD. */
  private fitDistance(): number {
    const { l, r, t, b } = this.insets;
    const vw = this.portrait ? OUTER_H : OUTER_W; // extent along the screen's horizontal axis
    const vh = this.portrait ? OUTER_W : OUTER_H;
    const aw = Math.max(80, this.w - l - r);
    const ah = Math.max(80, this.h - t - b);
    return (Math.max((vh * this.h) / ah, (vw * this.h) / aw) / (2 * Math.tan((FOV * Math.PI) / 360))) * 1.03;
  }

  private updateCamera(dt: number): void {
    const t = this.tmpCam;
    t.up.set(0, 1, 0);
    let k = 6;
    const topDown = (d: number) => {
      t.up.set(this.portrait ? 1 : 0, 0, this.portrait ? 0 : -1);
      t.position.set(0, d, 0);
      t.lookAt(0, 0, 0);
    };
    switch (this.mode) {
      case "menu": {
        const a = this.time * 0.08;
        t.position.set(Math.sin(a) * 2.5, 1.35, Math.cos(a) * 1.9 + 0.4);
        t.lookAt(0, 0, 0);
        k = 1.5;
        break;
      }
      case "aim": {
        const { x, y, dx, dy } = this.aim;
        const pitch = 0.5;
        const dist = this.portrait ? 1.05 : 0.95;
        const cx = wx(x), cz = wz(y);
        t.position.set(cx - dx * dist * Math.cos(pitch), BR + dist * Math.sin(pitch), cz - dy * dist * Math.cos(pitch));
        t.lookAt(cx + dx * 0.38, 0, cz + dy * 0.38);
        k = 12;
        break;
      }
      case "top":
        topDown(this.fitDistance());
        k = 7;
        break;
      case "watch":
        if (this.portrait) topDown(this.fitDistance());
        else {
          const d = this.fitDistance() * 1.1;
          const el = 1.0;
          t.position.set(0, d * Math.sin(el), d * Math.cos(el));
          t.lookAt(0, 0, 0.02);
        }
        k = 4;
        break;
    }
    if (this.snap) {
      this.snap = false;
      this.trans = null;
      this.camera.position.copy(t.position);
      this.camera.quaternion.copy(t.quaternion);
      return;
    }
    const tr = this.trans;
    if (tr) {
      // Ease in and out; the target is re-evaluated every frame so a moving aim is still followed.
      tr.t += dt / tr.dur;
      const p = Math.min(1, tr.t);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      this.camera.position.lerpVectors(tr.pos, t.position, e);
      this.camera.quaternion.slerpQuaternions(tr.quat, t.quaternion, e);
      if (p >= 1) this.trans = null;
      return;
    }
    const a = 1 - Math.exp(-k * dt);
    this.camera.position.lerp(t.position, a);
    this.camera.quaternion.slerp(t.quaternion, a);
  }

  private updateBalls(dt: number): void {
    for (const b of this.balls) {
      if (b.drop < 0) continue;
      b.drop += dt / 0.38;
      if (b.drop >= 1) {
        b.mesh.visible = false;
        b.mesh.scale.setScalar(1);
        b.drop = -1;
      } else {
        const e = b.drop * b.drop; // ease in: gathers speed toward the hole
        b.mesh.position.set(b.fx + (b.tx - b.fx) * Math.min(1, e * 1.6), BR - e * 0.16, b.fz + (b.tz - b.fz) * Math.min(1, e * 1.6));
        b.mesh.scale.setScalar(1 - e * 0.25);
      }
    }
  }

  private updateCue(dt: number): void {
    const c = this.cueState;
    if (c.strike >= 0) {
      c.strike += dt / 0.09;
      c.pull = c.from * (1 - Math.min(1, c.strike)) - 0.1 * Math.min(1, c.strike);
      if (c.strike >= 1) {
        c.visible = false;
        c.strike = -1;
      }
    }
    this.cue.visible = c.visible;
    if (!c.visible) return;
    const { x, y, dx, dy } = this.aim;
    this.cue.position.set(wx(x), BR + this.cueSpin.y * BR * 0.55, wz(y));
    this.cue.rotation.y = -Math.atan2(dy, dx);
    this.cuePivot.position.z = this.cueSpin.x * BR * 0.55;
    this.cuePivot.position.x = -(BR + 0.008 + Math.max(-0.02, c.pull * 0.17));
  }

  private tick = (ms: number): void => {
    const dt = Math.min(0.05, (ms - this.last) / 1000 || 0.016);
    this.last = ms;
    this.time += dt;
    this.roomTime += dt;
    this.room?.tick?.(this.roomTime, dt);
    this.frameHook?.(dt * 1000);
    this.updateBalls(dt);
    this.updateCue(dt);
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
    this.watchPerformance(dt);
  };

  /** "low" renders at 1x without shadows, for older phones. */
  setQuality(q: "high" | "low"): void {
    const low = q === "low";
    this.lowQuality = low;
    this.renderer.setPixelRatio(low ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.w, this.h, false);
    this.spot.castShadow = !low;
    this.renderer.shadowMap.enabled = !low;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  /** Step quality down when the device can't hold ~40fps. */
  private watchPerformance(dt: number): void {
    this.slow = dt > 0.026 ? this.slow + 1 : Math.max(0, this.slow - 2);
    if (this.lowQuality || this.slow < 90 || this.qualityStep >= 2) return;
    this.slow = 0;
    if (this.qualityStep++ === 0) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(this.w, this.h, false);
    } else {
      this.renderer.shadowMap.enabled = false;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.needsUpdate = true;
      });
    }
  }
}
