import * as THREE from "three";
import { HEAD_SPOT, FOOT_SPOT, POCKETS, TABLE_H, TABLE_W } from "@8pool/shared";

export const BALL_COLORS = [0xf5f5f5, 0xf2c200, 0x1f4fd8, 0xd62828, 0x5b2a86, 0xf27a1a, 0x1e8a3c, 0x7a1f1f, 0x111111];
export const colorOf = (id: number): number => BALL_COLORS[id > 8 ? id - 8 : id];
export const cssColor = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

export function finish(c: HTMLCanvasElement, srgb = true, repeat?: [number, number]): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/** Equirectangular ball skin (1024x512). Number discs sit at u=0.25 and u=0.75 on the equator. */
export function ballTexture(id: number): THREE.CanvasTexture {
  const W = 1024, H = 512;
  const [c, g] = canvas(W, H);
  const cream = "#f5f1e6";
  const col = id === 0 ? cream : cssColor(colorOf(id));

  g.fillStyle = id === 0 || id > 8 ? cream : col;
  g.fillRect(0, 0, W, H);
  if (id > 8) {
    // Stripe band with a hair of anti-aliased edge so it stays crisp at distance.
    g.fillStyle = col;
    g.fillRect(0, H * 0.25, W, H * 0.5);
  }
  // A little depth toward the poles, and a soft tonal sweep so the colour isn't flat.
  const pole = g.createLinearGradient(0, 0, 0, H);
  pole.addColorStop(0, "rgba(0,0,0,0.2)");
  pole.addColorStop(0.2, "rgba(0,0,0,0)");
  pole.addColorStop(0.8, "rgba(0,0,0,0)");
  pole.addColorStop(1, "rgba(0,0,0,0.2)");
  g.fillStyle = pole;
  g.fillRect(0, 0, W, H);

  for (const x of [W * 0.25, W * 0.75]) {
    if (id === 0) {
      g.fillStyle = "#b73a3a";
      g.beginPath();
      g.arc(x, H / 2, 15, 0, Math.PI * 2);
      g.fill();
      continue;
    }
    g.fillStyle = "#f8f5ec";
    g.beginPath();
    g.arc(x, H / 2, 92, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = "rgba(0,0,0,0.22)";
    g.stroke();
    g.fillStyle = "#13161a";
    g.font = '900 132px "Arial Black", "Helvetica Neue", Arial, sans-serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(id), x, H / 2 + 6);
    if (id === 6 || id === 9) g.fillRect(x - 34, H / 2 + 74, 68, 9); // underline so 6 and 9 can't be confused
  }
  const t = finish(c);
  t.anisotropy = 16;
  return t;
}

const PPM = 600; // felt texture pixels per metre
export const FELT_MARGIN = 0.07;

export interface FeltStyle {
  base: string;
  glow: string;
  /** Faint lattice lines, for the fancier cloths. */
  lattice?: string;
  /** Speckle of tiny stars. */
  stars?: boolean;
  line: string;
}

/** Cloth covering the playfield plus the strip under the cushions, with pockets and markings painted in. */
export function feltTexture(s: FeltStyle): THREE.CanvasTexture {
  const w = Math.round((TABLE_W / 1000 + 2 * FELT_MARGIN) * PPM);
  const h = Math.round((TABLE_H / 1000 + 2 * FELT_MARGIN) * PPM);
  const [c, g] = canvas(w, h);
  const px = (mmX: number) => (mmX / 1000 + FELT_MARGIN) * PPM;

  g.fillStyle = s.base;
  g.fillRect(0, 0, w, h);
  const glow = g.createRadialGradient(w / 2, h / 2, 40, w / 2, h / 2, w * 0.6);
  glow.addColorStop(0, s.glow);
  glow.addColorStop(1, "rgba(0,0,0,0.2)");
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);

  if (s.lattice) {
    g.strokeStyle = s.lattice;
    g.lineWidth = 1.5;
    const step = 90;
    g.beginPath();
    for (let x = -h; x < w + h; x += step) {
      g.moveTo(x, 0);
      g.lineTo(x + h, h);
      g.moveTo(x, h);
      g.lineTo(x + h, 0);
    }
    g.stroke();
  }

  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  if (s.stars) {
    for (let i = 0; i < 700; i++) {
      g.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.6})`;
      const r = Math.random() < 0.1 ? 2.2 : 1.1;
      g.beginPath();
      g.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  g.strokeStyle = s.line;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(px(HEAD_SPOT.x), px(0));
  g.lineTo(px(HEAD_SPOT.x), px(TABLE_H));
  g.stroke();
  g.fillStyle = s.line;
  for (const sp of [HEAD_SPOT, FOOT_SPOT]) {
    g.beginPath();
    g.arc(px(sp.x), px(sp.y), 4, 0, Math.PI * 2);
    g.fill();
  }
  for (const p of POCKETS) {
    const r = (p.r / 1000) * PPM * 1.08;
    const grad = g.createRadialGradient(px(p.x), px(p.y), r * 0.2, px(p.x), px(p.y), r);
    grad.addColorStop(0, "#000");
    grad.addColorStop(0.85, "#020202");
    grad.addColorStop(1, "rgba(0,0,0,0.6)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(px(p.x), px(p.y), r, 0, Math.PI * 2);
    g.fill();
  }
  return finish(c);
}

export type RailKind = "oak" | "lacquer" | "marble" | "bamboo" | "metal";

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Rail surface strip (1024x128). */
export function railTexture(kind: RailKind): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 128);
  const fill = (stops: [number, string][]) => {
    const grad = g.createLinearGradient(0, 0, 0, 128);
    for (const [o, col] of stops) grad.addColorStop(o, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, 1024, 128);
  };
  const strokes = (n: number, color: () => string, w: [number, number], wobble: number) => {
    for (let i = 0; i < n; i++) {
      g.strokeStyle = color();
      g.lineWidth = rnd(w[0], w[1]);
      const y = Math.random() * 128;
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(340, y + rnd(-wobble, wobble), 680, y + rnd(-wobble, wobble), 1024, y + rnd(-wobble / 2, wobble / 2));
      g.stroke();
    }
  };
  switch (kind) {
    case "oak":
      fill([[0, "#6b3d1c"], [0.5, "#7d4a24"], [1, "#5d3317"]]);
      strokes(90, () => `rgba(${20 + Math.random() * 30},10,0,${0.05 + Math.random() * 0.12})`, [0.6, 2.6], 12);
      break;
    case "lacquer":
      fill([[0, "#16161c"], [0.35, "#2a2a33"], [0.55, "#0b0b0e"], [1, "#050507"]]);
      g.fillStyle = "rgba(255,255,255,0.07)";
      g.fillRect(0, 10, 1024, 14);
      g.fillStyle = "#d4af37";
      g.fillRect(0, 30, 1024, 4);
      g.fillRect(0, 104, 1024, 4);
      break;
    case "marble":
      fill([[0, "#f6f2ea"], [1, "#e4ded2"]]);
      strokes(26, () => `rgba(${110 + Math.random() * 40},${105 + Math.random() * 30},${100 + Math.random() * 30},${0.12 + Math.random() * 0.25})`, [0.6, 2.2], 40);
      strokes(5, () => "rgba(212,175,55,0.5)", [0.8, 1.6], 30);
      g.fillStyle = "#d4af37";
      g.fillRect(0, 0, 1024, 5);
      g.fillRect(0, 123, 1024, 5);
      break;
    case "bamboo":
      fill([[0, "#e3c47a"], [0.5, "#d2a955"], [1, "#b98a3c"]]);
      strokes(60, () => `rgba(110,70,20,${0.06 + Math.random() * 0.12})`, [0.5, 1.6], 4);
      for (let x = 90; x < 1024; x += 170) {
        g.fillStyle = "rgba(90,55,15,0.5)";
        g.fillRect(x, 0, 7, 128);
        g.fillStyle = "rgba(255,240,190,0.25)";
        g.fillRect(x + 7, 0, 3, 128);
      }
      break;
    case "metal":
      fill([[0, "#9aa4b2"], [0.3, "#e6ebf2"], [0.55, "#6a7382"], [1, "#3b4350"]]);
      strokes(120, () => `rgba(255,255,255,${0.03 + Math.random() * 0.1})`, [0.4, 1.2], 1);
      g.fillStyle = "#35e8ff";
      g.fillRect(0, 60, 1024, 6);
      break;
  }
  return finish(c, true, [1, 1]);
}

export type FloorKind = "local" | "carpet" | "marble" | "sand" | "deck";

export function floorTexture(kind: FloorKind): THREE.CanvasTexture {
  const [c, g] = canvas(512, 512);
  switch (kind) {
    case "local": {
      const grad = g.createRadialGradient(256, 256, 10, 256, 256, 256);
      grad.addColorStop(0, "#262c36");
      grad.addColorStop(1, "#07090c");
      g.fillStyle = grad;
      g.fillRect(0, 0, 512, 512);
      return finish(c);
    }
    case "carpet": {
      g.fillStyle = "#3b0914";
      g.fillRect(0, 0, 512, 512);
      g.strokeStyle = "rgba(255,196,60,0.75)";
      g.lineWidth = 3;
      for (let i = 0; i <= 512; i += 128) {
        for (let j = 0; j <= 512; j += 128) {
          g.beginPath();
          g.moveTo(i, j - 52); g.lineTo(i + 52, j); g.lineTo(i, j + 52); g.lineTo(i - 52, j); g.closePath();
          g.stroke();
          g.fillStyle = "rgba(255,43,214,0.4)";
          g.beginPath();
          g.arc(i + 64, j + 64, 9, 0, Math.PI * 2);
          g.fill();
        }
      }
      return finish(c, true, [5, 5]);
    }
    case "marble": {
      g.fillStyle = "#efe9de";
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 28; i++) {
        g.strokeStyle = `rgba(${120 + Math.random() * 40},${110 + Math.random() * 30},${100 + Math.random() * 30},${0.1 + Math.random() * 0.25})`;
        g.lineWidth = rnd(0.7, 2.4);
        g.beginPath();
        let x = Math.random() * 512, y = 0;
        g.moveTo(x, y);
        while (y < 512) { x += rnd(-30, 30); y += rnd(20, 60); g.lineTo(x, y); }
        g.stroke();
      }
      g.strokeStyle = "#c9a548";
      g.lineWidth = 3;
      g.strokeRect(0, 0, 512, 512);
      g.beginPath();
      g.moveTo(256, 0); g.lineTo(256, 512); g.moveTo(0, 256); g.lineTo(512, 256);
      g.strokeStyle = "rgba(201,165,72,0.35)";
      g.lineWidth = 1.5;
      g.stroke();
      return finish(c, true, [4, 4]);
    }
    case "sand": {
      g.fillStyle = "#e6c98b";
      g.fillRect(0, 0, 512, 512);
      const img = g.getImageData(0, 0, 512, 512);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 26;
        img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n * 0.8;
      }
      g.putImageData(img, 0, 0);
      return finish(c, true, [8, 8]);
    }
    case "deck": {
      g.fillStyle = "#b07a3e";
      g.fillRect(0, 0, 512, 512);
      for (let y = 0; y < 512; y += 64) {
        g.fillStyle = `rgba(${60 + Math.random() * 30},30,5,${0.15 + Math.random() * 0.2})`;
        g.fillRect(0, y, 512, 64);
        g.fillStyle = "rgba(40,20,5,0.8)";
        g.fillRect(0, y, 512, 3);
        for (let k = 0; k < 6; k++) {
          g.strokeStyle = "rgba(60,30,5,0.25)";
          g.lineWidth = 1;
          const yy = y + rnd(6, 58);
          g.beginPath(); g.moveTo(0, yy); g.lineTo(512, yy + rnd(-3, 3)); g.stroke();
        }
      }
      return finish(c, true, [2, 2]);
    }
  }
}

/** Vertical gradient for a sky dome; stops run from zenith (0) down to the horizon (1) and below. */
export function skyTexture(stops: [number, string][]): THREE.CanvasTexture {
  const [c, g] = canvas(8, 512);
  const grad = g.createLinearGradient(0, 0, 0, 512);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 512);
  return finish(c);
}

export function starsTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(2048, 1024);
  g.fillStyle = "#04030b";
  g.fillRect(0, 0, 2048, 1024);
  const blob = (x: number, y: number, r: number, col: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(500, 380, 420, "rgba(110,40,190,0.35)");
  blob(1500, 600, 480, "rgba(20,110,200,0.28)");
  blob(1100, 250, 360, "rgba(220,60,160,0.18)");
  for (let i = 0; i < 2600; i++) {
    const a = 0.2 + Math.random() * 0.8;
    g.fillStyle = `rgba(${220 + Math.random() * 35},${220 + Math.random() * 35},255,${a})`;
    g.beginPath();
    g.arc(Math.random() * 2048, Math.random() * 1024, Math.random() < 0.06 ? 2.4 : 1.1, 0, Math.PI * 2);
    g.fill();
  }
  return finish(c);
}

export function planetTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 256);
  const bands = ["#e8b27a", "#c9824a", "#f0cf9c", "#b5673a", "#dba46c", "#9a5530"];
  const bh = 256 / 14;
  for (let i = 0; i < 14; i++) {
    g.fillStyle = bands[i % bands.length];
    g.fillRect(0, i * bh, 512, bh + 1);
  }
  const img = g.getImageData(0, 0, 512, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 10; i++) {
    g.fillStyle = "rgba(255,240,220,0.12)";
    g.beginPath();
    g.ellipse(Math.random() * 512, Math.random() * 256, rnd(20, 70), rnd(4, 9), 0, 0, Math.PI * 2);
    g.fill();
  }
  return finish(c);
}

export function wavesTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = "#1788b8";
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.18})`;
    g.lineWidth = rnd(1, 3);
    const x = Math.random() * 256, y = Math.random() * 256;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + 20, y - 6, x + 44, y);
    g.stroke();
  }
  return finish(c, true, [14, 14]);
}

/** Dusk skyline wrapped around a cylinder: tall central spire, lit windows. */
export function skylineTexture(): THREE.CanvasTexture {
  const W = 2048, H = 512;
  const [c, g] = canvas(W, H);
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#1a1a4a");
  sky.addColorStop(0.4, "#7a3f78");
  sky.addColorStop(0.62, "#f08a4b");
  sky.addColorStop(0.7, "#ffc98a");
  sky.addColorStop(0.7001, "#1a1022");
  sky.addColorStop(1, "#0a0710");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  const horizon = H * 0.7;
  const tower = (x: number, w: number, h: number, shade: string) => {
    g.fillStyle = shade;
    g.fillRect(x, horizon - h, w, h + 4);
    for (let wy = horizon - h + 8; wy < horizon - 6; wy += 9) {
      for (let wx2 = x + 4; wx2 < x + w - 4; wx2 += 7) {
        if (Math.random() < 0.55) {
          g.fillStyle = Math.random() < 0.7 ? "rgba(255,214,120,0.9)" : "rgba(180,220,255,0.8)";
          g.fillRect(wx2, wy, 3, 4);
        }
      }
    }
  };
  for (let x = 0; x < W; x += rnd(24, 60)) tower(x, rnd(26, 58), rnd(40, 170), `rgb(${18 + Math.random() * 14},${12 + Math.random() * 10},${34 + Math.random() * 16})`);
  // Spire that tapers in steps.
  for (const cx of [W * 0.25, W * 0.75]) {
    g.fillStyle = "#1c1630";
    let w = 52, y = horizon;
    for (let i = 0; i < 9; i++) {
      const h = 38 + i * 4;
      g.fillRect(cx - w / 2, y - h, w, h + 2);
      y -= h - 2;
      w -= 5.2;
    }
    g.fillRect(cx - 1.5, y - 40, 3, 42);
    g.fillStyle = "rgba(255,214,120,0.55)";
    g.fillRect(cx - 0.8, horizon - 330, 1.6, 300);
  }
  return finish(c);
}

export function neonTextTexture(text: string, color: string): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 256);
  g.font = "900 150px 'Russo One', Impact, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = color;
  g.shadowBlur = 40;
  g.fillStyle = color;
  g.fillText(text, 512, 132);
  g.shadowBlur = 12;
  g.fillStyle = "#fff";
  g.fillText(text, 512, 132);
  return finish(c);
}
