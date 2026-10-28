import {
  BALL_R, BALL_RESTITUTION, CUSHION_RESTITUTION, DT, FRAME_EVERY, FRICTION,
  MAX_SPEED, MAX_STEPS, POCKETS, REST_SPEED, SPIN_FOLLOW, SPIN_RAIL, SPIN_RAIL_DECAY, TABLE_H, TABLE_W,
} from "./constants";

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pocketed: boolean;
}

/** Index = ball id: 0 cue, 1-7 solids, 8 eight, 9-15 stripes. */
export type Balls = Ball[];

/** Where the cue tip hits the cue ball, as a point on its face with |(x, y)| <= 1. */
export interface Spin {
  x: number; // side: +1 = right-hand english (clockwise seen from above), -1 = left
  y: number; // vertical: +1 = follow (top), -1 = draw (bottom)
}

export interface Shot {
  angle: number; // radians
  power: number; // 0..1
  spin?: Spin;
}

/** Spin state of the cue ball while a shot plays out. */
export interface CueSpin {
  side: number;
  vert: number;
  dx: number; // unit shot direction
  dy: number;
  used: boolean; // follow/draw is applied once, on the first ball contact
}

export interface ShotEvents {
  firstContact: number | null; // first ball the cue ball touched
  pocketed: number[]; // ids in pocketing order
  railBalls: number[]; // distinct numbered balls (not cue) that hit a rail
  railAfterContact: boolean; // any ball hit a rail after the cue made contact
}

export interface ShotResult {
  balls: Balls;
  events: ShotEvents;
  /** Each frame is [x0, y0, x1, y1, ...] for all 16 balls, sampled at 60fps. */
  frames: number[][];
  /** Frame index at which each ball was pocketed. */
  pocketFrames: Record<number, number>;
}

export const cloneBalls = (balls: Balls): Balls => balls.map((b) => ({ ...b }));

function snapshot(balls: Balls): number[] {
  const f: number[] = [];
  for (const b of balls) f.push(round(b.x), round(b.y));
  return f;
}
const round = (n: number) => Math.round(n * 100) / 100;

export function isAtRest(balls: Balls): boolean {
  return balls.every((b) => b.pocketed || (b.vx === 0 && b.vy === 0));
}

/** Advance the simulation by one fixed step. Mutates balls and events. */
export function step(balls: Balls, ev: ShotEvents, pocketFrames?: Record<number, number>, frame = 0, spin?: CueSpin): void {
  const r = BALL_R;

  for (let id = 0; id < balls.length; id++) {
    const b = balls[id];
    if (b.pocketed) continue;
    b.x += b.vx * DT;
    b.y += b.vy * DT;

    const s = Math.hypot(b.vx, b.vy);
    if (s > 0) {
      const ds = FRICTION * DT;
      if (s - ds < REST_SPEED) {
        b.vx = 0;
        b.vy = 0;
      } else {
        const k = (s - ds) / s;
        b.vx *= k;
        b.vy *= k;
      }
    }

    // Pockets are checked before cushions so balls near the mouth drop in.
    for (const p of POCKETS) {
      if (Math.hypot(b.x - p.x, b.y - p.y) < p.r) {
        b.pocketed = true;
        b.vx = b.vy = 0;
        b.x = p.x;
        b.y = p.y;
        ev.pocketed.push(id);
        if (pocketFrames) pocketFrames[id] = frame;
        break;
      }
    }
    if (b.pocketed) continue;

    let hitRail = false;
    // Side spin kicks the cue ball along the cushion. (nx, ny) points into the table; `vn` is the speed into the rail.
    const english = (nx: number, ny: number, vn: number) => {
      if (id !== 0 || !spin || spin.side === 0) return;
      const k = SPIN_RAIL * spin.side * vn;
      b.vx += -k * ny;
      b.vy += k * nx;
      spin.side *= SPIN_RAIL_DECAY;
    };
    if (b.x < r) { b.x = r; if (b.vx < 0) { const vn = -b.vx; b.vx = vn * CUSHION_RESTITUTION; english(1, 0, vn); } hitRail = true; }
    else if (b.x > TABLE_W - r) { b.x = TABLE_W - r; if (b.vx > 0) { const vn = b.vx; b.vx = -vn * CUSHION_RESTITUTION; english(-1, 0, vn); } hitRail = true; }
    if (b.y < r) { b.y = r; if (b.vy < 0) { const vn = -b.vy; b.vy = vn * CUSHION_RESTITUTION; english(0, 1, vn); } hitRail = true; }
    else if (b.y > TABLE_H - r) { b.y = TABLE_H - r; if (b.vy > 0) { const vn = b.vy; b.vy = -vn * CUSHION_RESTITUTION; english(0, -1, vn); } hitRail = true; }
    if (hitRail) {
      if (id !== 0 && !ev.railBalls.includes(id)) ev.railBalls.push(id);
      if (ev.firstContact !== null) ev.railAfterContact = true;
    }
  }

  // Ball-ball collisions (equal mass). Fixed i<j order keeps this deterministic.
  const minD = 2 * r;
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (a.pocketed) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const c = balls[j];
      if (c.pocketed) continue;
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD || d2 === 0) continue;

      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const overlap = (minD - d) / 2;
      a.x -= nx * overlap; a.y -= ny * overlap;
      c.x += nx * overlap; c.y += ny * overlap;

      const vn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
      if (vn >= 0) continue; // already separating
      const imp = (-(1 + BALL_RESTITUTION) * vn) / 2;
      a.vx -= imp * nx; a.vy -= imp * ny;
      c.vx += imp * nx; c.vy += imp * ny;

      if (i === 0 && spin && !spin.used) {
        spin.used = true;
        const extra = spin.vert * SPIN_FOLLOW * -vn;
        a.vx += spin.dx * extra;
        a.vy += spin.dy * extra;
      }
      if (i === 0 && ev.firstContact === null) ev.firstContact = j;
    }
  }
}

/** Simulate one shot to rest. Does not mutate `start`. */
export function simulateShot(start: Balls, shot: Shot): ShotResult {
  if (!Number.isFinite(shot.angle) || !Number.isFinite(shot.power) || shot.power < 0 || shot.power > 1) {
    throw new Error("invalid shot");
  }
  let spin: CueSpin | undefined;
  if (shot.spin !== undefined) {
    const { x, y } = shot.spin;
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) > 1.0001) throw new Error("invalid shot");
    if (x !== 0 || y !== 0) spin = { side: x, vert: y, dx: Math.cos(shot.angle), dy: Math.sin(shot.angle), used: false };
  }
  const balls = cloneBalls(start);
  const cue = balls[0];
  if (cue.pocketed) throw new Error("cue ball is pocketed");
  cue.vx = Math.cos(shot.angle) * shot.power * MAX_SPEED;
  cue.vy = Math.sin(shot.angle) * shot.power * MAX_SPEED;

  const events: ShotEvents = { firstContact: null, pocketed: [], railBalls: [], railAfterContact: false };
  const frames: number[][] = [snapshot(balls)];
  const pocketFrames: Record<number, number> = {};

  for (let n = 1; n <= MAX_STEPS; n++) {
    step(balls, events, pocketFrames, frames.length, spin);
    if (n % FRAME_EVERY === 0) frames.push(snapshot(balls));
    if (isAtRest(balls)) break;
  }
  for (const b of balls) { b.vx = 0; b.vy = 0; }
  frames.push(snapshot(balls));
  return { balls, events, frames, pocketFrames };
}
