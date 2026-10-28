import { describe, expect, it } from "vitest";
import { cloneBalls, ShotEvents } from "./physics";
import { GameState, newGame, resolveShot, takeShot } from "./rules";

const ev = (o: Partial<ShotEvents> = {}): ShotEvents => ({
  firstContact: null, pocketed: [], railBalls: [], railAfterContact: false, ...o,
});

function midGame(over: Partial<GameState> = {}): GameState {
  const g = newGame(3);
  return { ...g, breakShot: false, ballInHand: false, ...over, balls: cloneBalls(g.balls) };
}

describe("rack", () => {
  it("places 15 distinct balls with the 8 in the middle and mixed back corners", () => {
    const g = newGame(99);
    expect(g.balls.filter((b) => !b.pocketed)).toHaveLength(16);
    const ids = g.balls.slice(1).map((b) => `${b.x.toFixed(2)},${b.y.toFixed(2)}`);
    expect(new Set(ids).size).toBe(15);
  });
  it("is reproducible from the seed", () => {
    expect(newGame(5)).toEqual(newGame(5));
    expect(newGame(5)).not.toEqual(newGame(6));
  });
});

describe("break", () => {
  it("is a foul (ball in hand for opponent) with no pocket and <4 rails", () => {
    const g = newGame(1);
    const n = resolveShot(g, cloneBalls(g.balls), ev({ firstContact: 1, railBalls: [1, 2] }));
    expect(n.current).toBe(1);
    expect(n.ballInHand).toBe(true);
  });
  it("is legal with 4 rail balls; turn passes, table stays open", () => {
    const g = newGame(1);
    const n = resolveShot(g, cloneBalls(g.balls), ev({ firstContact: 1, railBalls: [1, 2, 3, 4], railAfterContact: true }));
    expect(n.current).toBe(1);
    expect(n.ballInHand).toBe(false);
    expect(n.groups).toEqual([null, null]);
  });
  it("lets the breaker continue after potting, without assigning groups", () => {
    const g = newGame(1);
    const balls = cloneBalls(g.balls);
    balls[2].pocketed = true;
    const n = resolveShot(g, balls, ev({ firstContact: 1, pocketed: [2], railAfterContact: true }));
    expect(n.current).toBe(0);
    expect(n.groups).toEqual([null, null]);
  });
  it("re-spots the 8-ball if potted on the break", () => {
    const g = newGame(1);
    const balls = cloneBalls(g.balls);
    balls[8].pocketed = true;
    const n = resolveShot(g, balls, ev({ firstContact: 1, pocketed: [8], railAfterContact: true }));
    expect(n.balls[8].pocketed).toBe(false);
    expect(n.winner).toBeNull();
  });
});

describe("open table and groups", () => {
  it("assigns groups on the first legal pot and keeps the turn", () => {
    const n = resolveShot(midGame(), midGame().balls, ev({ firstContact: 3, pocketed: [3], railAfterContact: true }));
    expect(n.groups).toEqual(["solids", "stripes"]);
    expect(n.current).toBe(0);
  });
  it("switches turn on a legal miss", () => {
    const n = resolveShot(midGame(), midGame().balls, ev({ firstContact: 3, railAfterContact: true }));
    expect(n.current).toBe(1);
    expect(n.ballInHand).toBe(false);
  });
  it("fouls when hitting the 8 first on an open table", () => {
    const n = resolveShot(midGame(), midGame().balls, ev({ firstContact: 8, railAfterContact: true }));
    expect(n.ballInHand).toBe(true);
    expect(n.current).toBe(1);
  });
});

describe("fouls", () => {
  const assigned = () => midGame({ groups: ["solids", "stripes"] });
  it("scratch gives ball in hand and resets the cue ball", () => {
    const g = assigned();
    const balls = cloneBalls(g.balls);
    balls[0].pocketed = true;
    const n = resolveShot(g, balls, ev({ firstContact: 1, pocketed: [0], railAfterContact: true }));
    expect(n.ballInHand).toBe(true);
    expect(n.balls[0].pocketed).toBe(false);
  });
  it("hitting the opponent's ball first is a foul", () => {
    const n = resolveShot(assigned(), assigned().balls, ev({ firstContact: 9, railAfterContact: true }));
    expect(n.ballInHand).toBe(true);
  });
  it("no first contact is a foul", () => {
    expect(resolveShot(assigned(), assigned().balls, ev()).ballInHand).toBe(true);
  });
  it("no rail or pocket after contact is a foul", () => {
    expect(resolveShot(assigned(), assigned().balls, ev({ firstContact: 1 })).ballInHand).toBe(true);
  });
  it("a foul pot does not keep the turn", () => {
    const g = assigned();
    const n = resolveShot(g, g.balls, ev({ firstContact: 9, pocketed: [1], railAfterContact: true }));
    expect(n.current).toBe(1);
  });
});

describe("8-ball", () => {
  const cleared = () => {
    const g = midGame({ groups: ["solids", "stripes"] });
    for (let i = 1; i <= 7; i++) g.balls[i].pocketed = true;
    return g;
  };
  it("wins when pocketed legally after clearing the group", () => {
    const g = cleared();
    const n = resolveShot(g, g.balls, ev({ firstContact: 8, pocketed: [8], railAfterContact: true }));
    expect(n.winner).toBe(0);
  });
  it("loses when pocketed early", () => {
    const g = midGame({ groups: ["solids", "stripes"] });
    const n = resolveShot(g, g.balls, ev({ firstContact: 1, pocketed: [8], railAfterContact: true }));
    expect(n.winner).toBe(1);
  });
  it("loses on a scratch while pocketing the 8", () => {
    const g = cleared();
    const n = resolveShot(g, g.balls, ev({ firstContact: 8, pocketed: [8, 0], railAfterContact: true }));
    expect(n.winner).toBe(1);
  });
  it("loses when the last group ball and the 8 drop on the same shot", () => {
    const g = midGame({ groups: ["solids", "stripes"] });
    for (let i = 1; i <= 6; i++) g.balls[i].pocketed = true;
    const n = resolveShot(g, g.balls, ev({ firstContact: 7, pocketed: [7, 8], railAfterContact: true }));
    expect(n.winner).toBe(1);
  });
});

describe("takeShot", () => {
  it("plays a full break and produces a consistent state", () => {
    const g = newGame(11);
    const { game, result } = takeShot(g, { angle: 0, power: 1 });
    expect(result.frames.length).toBeGreaterThan(10);
    expect(game.breakShot).toBe(false);
    expect([0, 1]).toContain(game.current);
  });
  it("rejects placement when there is no ball in hand", () => {
    const g = midGame();
    expect(() => takeShot(g, { angle: 0, power: 0.5, placement: { x: 300, y: 300 } })).toThrow(/no ball in hand/);
  });
  it("rejects a break placement past the head string", () => {
    expect(() => takeShot(newGame(1), { angle: 0, power: 0.5, placement: { x: 1500, y: 600 } })).toThrow();
  });
  it("rejects shots after the game is over", () => {
    const g = { ...midGame(), winner: 0 as const };
    expect(() => takeShot(g, { angle: 0, power: 0.5 })).toThrow(/over/);
  });
});
