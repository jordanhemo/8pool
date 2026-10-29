import { describe, expect, it } from "vitest";
import { BALL_R, TABLE_H, TABLE_W } from "./constants";
import { Balls, CueSpin, ShotEvents, simulateShot, step } from "./physics";
import { newGame } from "./rules";

const emptyBalls = (): Balls =>
  Array.from({ length: 16 }, () => ({ x: 0, y: 0, vx: 0, vy: 0, pocketed: true }));
const place = (b: Balls, id: number, x: number, y: number) => Object.assign(b[id], { x, y, pocketed: false });
const freshEvents = (): ShotEvents => ({ firstContact: null, pocketed: [], railBalls: [], railAfterContact: false });

describe("physics", () => {
  it("is deterministic for identical input", () => {
    const g = newGame(42);
    const shot = { angle: 0.01, power: 0.9 };
    const a = simulateShot(g.balls, shot);
    const b = simulateShot(g.balls, shot);
    expect(a.frames).toEqual(b.frames);
    expect(a.events).toEqual(b.events);
  });

  it("does not mutate the starting balls", () => {
    const g = newGame(1);
    const before = JSON.stringify(g.balls);
    simulateShot(g.balls, { angle: 0, power: 1 });
    expect(JSON.stringify(g.balls)).toBe(before);
  });

  it("conserves momentum in a head-on collision (within one step of friction)", () => {
    const balls = emptyBalls();
    place(balls, 0, 1000, 600);
    place(balls, 1, 1000 + 2 * BALL_R - 0.5, 600);
    balls[0].vx = 2000;
    const ev = freshEvents();
    step(balls, ev);
    expect(ev.firstContact).toBe(1);
    expect(balls[0].vx + balls[1].vx).toBeCloseTo(2000, -1);
    expect(balls[1].vx).toBeGreaterThan(1800); // nearly all energy transfers
  });

  it("pockets a ball rolling into a corner", () => {
    const balls = emptyBalls();
    place(balls, 0, 600, 600);
    place(balls, 1, 200, 200);
    balls[1].vx = -1500;
    balls[1].vy = -1500;
    const ev = freshEvents();
    for (let i = 0; i < 480 && !balls[1].pocketed; i++) step(balls, ev);
    expect(balls[1].pocketed).toBe(true);
    expect(ev.pocketed).toContain(1);
  });

  it("keeps balls on the table and comes to rest", () => {
    const g = newGame(7);
    const r = simulateShot(g.balls, { angle: 0.3, power: 1 });
    for (const b of r.balls) {
      if (b.pocketed) continue;
      expect(b.x).toBeGreaterThanOrEqual(BALL_R - 1e-6);
      expect(b.x).toBeLessThanOrEqual(TABLE_W - BALL_R + 1e-6);
      expect(b.y).toBeGreaterThanOrEqual(BALL_R - 1e-6);
      expect(b.y).toBeLessThanOrEqual(TABLE_H - BALL_R + 1e-6);
      expect(b.vx === 0 && b.vy === 0).toBe(true);
    }
  });

  it("rejects invalid shots", () => {
    const g = newGame(1);
    expect(() => simulateShot(g.balls, { angle: NaN, power: 0.5 })).toThrow();
    expect(() => simulateShot(g.balls, { angle: 0, power: 2 })).toThrow();
  });

  describe("spin", () => {
    const cueSpin = (side: number, vert: number): CueSpin => ({ side, vert, dx: 1, dy: 0, used: false });
    const headOn = (spin?: CueSpin) => {
      const balls = emptyBalls();
      place(balls, 0, 1000, 600);
      place(balls, 1, 1000 + 2 * BALL_R - 0.5, 600);
      balls[0].vx = 2000;
      step(balls, freshEvents(), undefined, 0, spin);
      return balls;
    };

    it("follow pushes the cue ball on through the object ball, draw pulls it back", () => {
      const stun = headOn()[0].vx;
      const follow = headOn(cueSpin(0, 1))[0].vx;
      const draw = headOn(cueSpin(0, -1))[0].vx;
      expect(Math.abs(stun)).toBeLessThan(200);
      expect(follow).toBeGreaterThan(stun + 800);
      expect(draw).toBeLessThan(stun - 800);
    });

    it("applies follow/draw only on the first ball contact", () => {
      const spin = cueSpin(0, 1);
      headOn(spin);
      expect(spin.used).toBe(true);
      const after = cueSpin(0, 1);
      after.used = true;
      expect(headOn(after)[0].vx).toBeCloseTo(headOn()[0].vx, 6);
    });

    it("side spin kicks the cue ball along the cushion, in opposite directions for opposite spin", () => {
      const hit = (side: number) => {
        const balls = emptyBalls();
        place(balls, 0, TABLE_W - BALL_R - 2, 600);
        balls[0].vx = 2000;
        step(balls, freshEvents(), undefined, 0, cueSpin(side, 0));
        return balls[0];
      };
      const right = hit(1);
      const left = hit(-1);
      const none = hit(0);
      expect(none.vy).toBe(0);
      expect(right.vy).toBeLessThan(-100);
      expect(left.vy).toBeGreaterThan(100);
      expect(right.vx).toBeLessThan(0); // still bounced back off the rail
    });

    it("treats a centre hit exactly like no spin", () => {
      const g = newGame(7);
      const a = simulateShot(g.balls, { angle: 0.02, power: 0.8 });
      const b = simulateShot(g.balls, { angle: 0.02, power: 0.8, spin: { x: 0, y: 0 } });
      expect(b.frames).toEqual(a.frames);
    });

    it("changes the outcome when spin is applied and stays deterministic", () => {
      const g = newGame(7);
      const shot = { angle: 0.02, power: 0.8, spin: { x: 0.6, y: -0.5 } };
      const a = simulateShot(g.balls, shot);
      const b = simulateShot(g.balls, shot);
      const plain = simulateShot(g.balls, { angle: 0.02, power: 0.8 });
      expect(a.frames).toEqual(b.frames);
      expect(a.frames).not.toEqual(plain.frames);
    });

    it("rejects spin outside the cue ball face or non-finite", () => {
      const g = newGame(1);
      expect(() => simulateShot(g.balls, { angle: 0, power: 0.5, spin: { x: 1, y: 1 } })).toThrow("invalid shot");
      expect(() => simulateShot(g.balls, { angle: 0, power: 0.5, spin: { x: NaN, y: 0 } })).toThrow("invalid shot");
    });
  });

  it("a jump shot passes over a ball in its way, a normal shot hits it", () => {
    const balls = emptyBalls();
    place(balls, 0, 600, 600);
    place(balls, 1, 760, 600); // 160mm ahead: the cue ball is still in the air when it gets there
    place(balls, 2, 1900, 600);
    const flat = simulateShot(balls, { angle: 0, power: 0.5 });
    expect(flat.events.firstContact).toBe(1);
    const hop = simulateShot(balls, { angle: 0, power: 0.5, jump: true });
    expect(hop.events.firstContact).not.toBe(1);
    expect(hop.air).toBeGreaterThan(0);
    expect(flat.air).toBeUndefined();
  });

  it("a jumping cue ball is not pocketed while airborne", () => {
    const balls = emptyBalls();
    place(balls, 0, 150, 150);
    const r = simulateShot(balls, { angle: Math.PI * 1.25, power: 0.5, jump: true });
    expect(r.events.pocketed).not.toContain(0);
  });
});
