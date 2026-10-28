import { BALL_R, FOOT_SPOT, HEAD_SPOT, TABLE_H, TABLE_W } from "./constants";
import { Ball, Balls, ShotEvents, ShotResult, Shot, simulateShot } from "./physics";
import { mulberry32, shuffle } from "./rng";

export type Group = "solids" | "stripes";
export type Player = 0 | 1;

export interface GameState {
  balls: Balls;
  current: Player;
  groups: [Group | null, Group | null];
  ballInHand: boolean;
  breakShot: boolean;
  winner: Player | null;
  endReason: string | null;
}

export interface TakeShot extends Shot {
  /** Required to move the cue ball when the shooter has ball in hand. */
  placement?: { x: number; y: number };
}

export const groupOf = (id: number): Group | null => (id >= 1 && id <= 7 ? "solids" : id >= 9 && id <= 15 ? "stripes" : null);
const idsOf = (g: Group) => (g === "solids" ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15]);
const other = (p: Player): Player => (p === 0 ? 1 : 0);

export function newGame(seed: number): GameState {
  const rand = mulberry32(seed);
  const solids = shuffle([1, 2, 3, 4, 5, 6, 7], rand);
  const stripes = shuffle([9, 10, 11, 12, 13, 14, 15], rand);
  const slots: number[] = new Array(15).fill(0);
  slots[4] = 8; // centre of third row
  slots[10] = solids.pop()!; // back corners: one of each group
  slots[14] = stripes.pop()!;
  const rest = shuffle([...solids, ...stripes], rand);
  for (let i = 0; i < 15; i++) if (slots[i] === 0) slots[i] = rest.pop()!;

  const balls: Balls = Array.from({ length: 16 }, () => ({ x: 0, y: 0, vx: 0, vy: 0, pocketed: false }));
  balls[0].x = HEAD_SPOT.x;
  balls[0].y = HEAD_SPOT.y;
  const dx = Math.sqrt(3) * (BALL_R + 0.25);
  const dy = BALL_R + 0.25;
  let idx = 0;
  for (let row = 0; row < 5; row++) {
    for (let k = 0; k <= row; k++) {
      const id = slots[idx++];
      balls[id].x = FOOT_SPOT.x + row * dx;
      balls[id].y = FOOT_SPOT.y + (k * 2 - row) * dy;
    }
  }
  return { balls, current: 0, groups: [null, null], ballInHand: true, breakShot: true, winner: null, endReason: null };
}

function isFree(balls: Balls, x: number, y: number, ignore = -1): boolean {
  return balls.every((b, i) => i === ignore || b.pocketed || Math.hypot(b.x - x, b.y - y) >= 2 * BALL_R);
}

function validatePlacement(game: GameState, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("invalid placement");
  if (x < BALL_R || x > TABLE_W - BALL_R || y < BALL_R || y > TABLE_H - BALL_R) throw new Error("placement off table");
  if (game.breakShot && x > HEAD_SPOT.x) throw new Error("break placement must be behind the head string");
  if (!isFree(game.balls, x, y, 0)) throw new Error("placement overlaps a ball");
}

function respotEight(balls: Balls): void {
  let x = FOOT_SPOT.x;
  while (!isFree(balls, x, FOOT_SPOT.y, 8) && x < TABLE_W - BALL_R) x += BALL_R;
  Object.assign(balls[8], { x, y: FOOT_SPOT.y, vx: 0, vy: 0, pocketed: false });
}

/** Pure rules adjudication: given the previous state and what happened, produce the next state. */
export function resolveShot(prev: GameState, balls: Balls, ev: ShotEvents): GameState {
  const shooter = prev.current;
  const opp = other(shooter);
  const groups: [Group | null, Group | null] = [...prev.groups];
  const next: GameState = { ...prev, balls, groups, breakShot: false, ballInHand: false };

  const cueScratch = ev.pocketed.includes(0);
  const eightPocketed = ev.pocketed.includes(8);
  const objectPocketed = ev.pocketed.filter((id) => id !== 0 && id !== 8);
  const anyPocketed = objectPocketed.length > 0 || eightPocketed;

  const finish = (winner: Player, reason: string): GameState => {
    next.winner = winner;
    next.endReason = reason;
    return next;
  };
  const foulOut = (): GameState => {
    next.current = opp;
    next.ballInHand = true;
    if (cueScratch) Object.assign(balls[0], { x: HEAD_SPOT.x, y: HEAD_SPOT.y, vx: 0, vy: 0, pocketed: false });
    return next;
  };

  if (prev.breakShot) {
    if (eightPocketed) respotEight(balls);
    const legalBreak = anyPocketed || ev.railBalls.length >= 4;
    if (cueScratch || !legalBreak) return foulOut();
    if (objectPocketed.length || eightPocketed) return next; // shooter continues, table still open
    next.current = opp;
    return next;
  }

  const myGroup = groups[shooter];
  const cleared = myGroup !== null && idsOf(myGroup).every((id) => prev.balls[id].pocketed);

  let foul = cueScratch || ev.firstContact === null || !(ev.railAfterContact || anyPocketed);
  if (!foul && ev.firstContact !== null) {
    const fc = ev.firstContact;
    foul = myGroup === null ? fc === 8 : cleared ? fc !== 8 : groupOf(fc) !== myGroup;
  }

  if (eightPocketed) {
    if (foul) return finish(opp, "fouled while pocketing the 8-ball");
    if (!cleared) return finish(opp, "pocketed the 8-ball early");
    return finish(shooter, "pocketed the 8-ball");
  }

  if (foul) return foulOut();

  if (myGroup === null && objectPocketed.length) {
    const g = groupOf(objectPocketed[0])!;
    groups[shooter] = g;
    groups[opp] = g === "solids" ? "stripes" : "solids";
  }
  const mine = groups[shooter];
  const continues = objectPocketed.some((id) => groupOf(id) === mine);
  if (!continues) next.current = opp;
  return next;
}

/** Validate and play one shot for the current player. Throws on illegal input. */
export function takeShot(game: GameState, shot: TakeShot): { game: GameState; result: ShotResult } {
  if (game.winner !== null) throw new Error("game is over");
  let balls = game.balls;
  if (shot.placement) {
    if (!game.ballInHand) throw new Error("no ball in hand");
    validatePlacement(game, shot.placement.x, shot.placement.y);
    balls = balls.map((b) => ({ ...b }));
    Object.assign(balls[0], { x: shot.placement.x, y: shot.placement.y, vx: 0, vy: 0, pocketed: false });
  } else if (game.ballInHand) {
    validatePlacement(game, balls[0].x, balls[0].y);
  }
  const result = simulateShot(balls, shot);
  const next = resolveShot({ ...game, balls }, result.balls, result.events);
  return { game: next, result };
}

export type { Ball };

/** True if the shooter may legally put the cue ball at (x, y) right now. */
export function isValidPlacement(game: GameState, x: number, y: number): boolean {
  if (!game.ballInHand) return false;
  try {
    validatePlacement(game, x, y);
    return true;
  } catch {
    return false;
  }
}
