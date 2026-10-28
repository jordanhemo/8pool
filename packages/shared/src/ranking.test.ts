import { describe, expect, it } from "vitest";
import { eloDeltas, rankOf, rankProgress } from "./ranking";
import { normalizeCode, isStakeString } from "./tournament";
import { parseClientMessage } from "./protocol";

describe("ranking", () => {
  it("gives equal players a fair split and rewards upsets more", () => {
    const even = eloDeltas({ rating: 1000, games: 20 }, { rating: 1000, games: 20 });
    expect(even.winner).toBe(12);
    expect(even.loser).toBe(-12);
    const upset = eloDeltas({ rating: 900, games: 20 }, { rating: 1300, games: 20 });
    const favourite = eloDeltas({ rating: 1300, games: 20 }, { rating: 900, games: 20 });
    expect(upset.winner).toBeGreaterThan(favourite.winner);
  });

  it("moves placement ratings faster, never makes a win lose points, and never goes below zero", () => {
    expect(eloDeltas({ rating: 1000, games: 0 }, { rating: 1000, games: 50 }).winner).toBe(20);
    expect(eloDeltas({ rating: 2000, games: 50 }, { rating: 800, games: 50 }).winner).toBeGreaterThanOrEqual(1);
    expect(eloDeltas({ rating: 1000, games: 50 }, { rating: 3, games: 50 }).loser).toBe(-1);
  });

  it("maps ratings to tiers", () => {
    expect(rankOf(999).id).toBe("bronze");
    expect(rankOf(1000).id).toBe("silver");
    expect(rankOf(1650).id).toBe("diamond");
    expect(rankOf(2400).id).toBe("master");
    expect(rankProgress(1100)).toBeCloseTo(0.5);
    expect(rankProgress(2400)).toBe(1);
  });
});

describe("private room input", () => {
  it("normalizes codes and validates stakes", () => {
    expect(normalizeCode(" ab-c2d3 ")).toBe("ABC2D");
    expect(isStakeString("0.02")).toBe(true);
    expect(isStakeString("1e5")).toBe(false);
    expect(isStakeString("0.1234567")).toBe(false);
  });

  it("parses the new client messages", () => {
    expect(parseClientMessage('{"t":"private_join","code":"ab c2d"}')).toEqual({ t: "private_join", code: "ABC2D" });
    expect(parseClientMessage('{"t":"private_join","code":"AB"}')).toBeNull();
    expect(parseClientMessage('{"t":"private_create","stake":"0.05"}')).toEqual({ t: "private_create", stake: "0.05" });
    expect(parseClientMessage('{"t":"private_create","stake":-1}')).toBeNull();
    expect(parseClientMessage('{"t":"profile","pid":"0123456789ab"}')).toEqual({ t: "profile", pid: "0123456789ab" });
    expect(parseClientMessage('{"t":"profile","pid":"nope"}')).toBeNull();
    expect(parseClientMessage('{"t":"leaderboard"}')).toEqual({ t: "leaderboard" });
  });
});
