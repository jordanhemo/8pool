import { describe, expect, it } from "vitest";
import { EMOTES, parseClientMessage } from "./protocol";
import { TOURNAMENT_SIZE, VENUES } from "./tournament";

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));

describe("protocol", () => {
  it("accepts a jump flag only as a boolean", () => {
    expect(parse({ t: "shot", angle: 1, power: 0.5, jump: true })).toMatchObject({ jump: true });
    expect(parse({ t: "shot", angle: 1, power: 0.5, jump: "yes" })).toBeNull();
  });

  it("accepts a shot with and without spin", () => {
    expect(parse({ t: "shot", angle: 1, power: 0.5 })).toMatchObject({ t: "shot", angle: 1, power: 0.5, spin: undefined });
    expect(parse({ t: "shot", angle: 1, power: 0.5, spin: { x: 0.3, y: -0.4 } })).toMatchObject({ spin: { x: 0.3, y: -0.4 } });
  });

  it("rejects malformed or out-of-range spin", () => {
    expect(parse({ t: "shot", angle: 1, power: 0.5, spin: { x: 1, y: 1 } })).toBeNull();
    expect(parse({ t: "shot", angle: 1, power: 0.5, spin: { x: "a", y: 0 } })).toBeNull();
    expect(parse({ t: "shot", angle: 1, power: 0.5, spin: null })).toBeNull();
    expect(parse({ t: "shot", angle: 1, power: 0.5, spin: 3 })).toBeNull();
  });

  it("only accepts preset emotes", () => {
    for (const id of EMOTES) expect(parse({ t: "emote", id })).toEqual({ t: "emote", id });
    expect(parse({ t: "emote", id: "<script>" })).toBeNull();
    expect(parse({ t: "emote" })).toBeNull();
    expect(parse({ t: "emote", id: 5 })).toBeNull();
  });

  it("parses tournament join and leave", () => {
    expect(parse({ t: "tournament_join", venue: "vegas" })).toEqual({ t: "tournament_join", venue: "vegas" });
    expect(parse({ t: "tournament_join" })).toBeNull();
    expect(parse({ t: "tournament_join", venue: 5 })).toBeNull();
    expect(parse({ t: "tournament_join", venue: "x".repeat(40) })).toBeNull();
    expect(parse({ t: "tournament_leave" })).toEqual({ t: "tournament_leave" });
  });
});

describe("venues", () => {
  it("get more expensive up the list, so each venue has a bigger pot", () => {
    const prices = VENUES.map((v) => Number(v.buyIn));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(new Set(prices).size).toBe(prices.length);
    expect(new Set(VENUES.map((v) => v.id)).size).toBe(VENUES.length);
    expect(TOURNAMENT_SIZE).toBe(4);
  });
});
