import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Seat, ServerMessage } from "@8pool/shared";
import { Room, RoomResult } from "./room";

const OPTS = { shotClockMs: 10_000, graceMs: 5_000, maxTimeouts: 2, seed: 7 };

function setup() {
  const inbox: [ServerMessage[], ServerMessage[]] = [[], []];
  const ended: RoomResult[] = [];
  const room = new Room("m1", "0.01", ["Ann", "Bob"], (seat, msg) => inbox[seat].push(msg), (r) => ended.push(r), OPTS);
  room.start();
  const last = (seat: Seat, t: ServerMessage["t"]) => [...inbox[seat]].reverse().find((m) => m.t === t);
  return { room, inbox, ended, last };
}

describe("Room", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends match_start to both seats with their seat number", () => {
    const { inbox } = setup();
    expect(inbox[0][0]).toMatchObject({ t: "match_start", seat: 0, tier: "0.01", resumed: false });
    expect(inbox[1][0]).toMatchObject({ t: "match_start", seat: 1 });
  });

  it("rejects a shot out of turn", () => {
    const { room, last } = setup();
    room.handleShot(1, { angle: 0, power: 0.5 });
    expect(last(1, "error")).toMatchObject({ message: "not your turn" });
  });

  it("broadcasts the shot result to both players and advances state", () => {
    const { room, inbox } = setup();
    room.handleShot(0, { angle: 0, power: 0.8 });
    for (const seat of [0, 1] as const) {
      const m = inbox[seat].at(-1)!;
      expect(m.t).toBe("shot_result");
      if (m.t === "shot_result") {
        expect(m.report.frames.length).toBeGreaterThan(2);
        expect(m.state.breakShot).toBe(false);
      }
    }
  });

  it("rejects illegal input without changing state", () => {
    const { room, last } = setup();
    room.handleShot(0, { angle: 0, power: 5 });
    expect(last(0, "error")).toBeDefined();
    expect(room.game.breakShot).toBe(true);
  });

  it("refuses a second shot while the first is still animating", () => {
    const { room, last } = setup();
    room.handleShot(0, { angle: 0, power: 0.8 });
    const next = room.game.current;
    room.handleShot(next, { angle: 0, power: 0.5, placement: undefined });
    expect(last(next, "error")).toMatchObject({ message: "wait for the shot to finish" });
  });

  it("resignation ends the match once", () => {
    const { room, ended, last } = setup();
    room.resign(0);
    room.resign(1);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ winner: 1 });
    expect(last(0, "game_over")).toMatchObject({ winner: 1 });
    room.handleShot(1, { angle: 0, power: 0.5 });
  });

  it("penalises a shot-clock timeout with ball in hand for the opponent", () => {
    const { room, last } = setup();
    vi.advanceTimersByTime(10_001);
    expect(room.game.current).toBe(1);
    expect(room.game.ballInHand).toBe(true);
    expect(last(0, "state")).toMatchObject({ reason: "Ann ran out of time" });
  });

  it("forfeits after maxTimeouts consecutive timeouts by the same player", () => {
    const { room, ended } = setup();
    vi.advanceTimersByTime(10_001); // Ann times out (1)
    vi.advanceTimersByTime(10_001); // Bob times out (1), back to Ann
    vi.advanceTimersByTime(10_001); // Ann times out (2) -> forfeit
    expect(room.ended).toBe(true);
    expect(ended[0]).toMatchObject({ winner: 1, reason: "Ann ran out of time" });
  });

  it("forfeits a player who stays disconnected past the grace period", () => {
    const { room, ended, last } = setup();
    room.setConnected(0, false);
    expect(last(1, "opponent_status")).toMatchObject({ connected: false });
    vi.advanceTimersByTime(5_001);
    expect(ended[0]).toMatchObject({ winner: 1, reason: "Ann disconnected" });
  });

  it("cancels the forfeit when the player reconnects in time", () => {
    const { room, ended, inbox } = setup();
    room.setConnected(1, false);
    vi.advanceTimersByTime(4_000);
    room.setConnected(1, true);
    room.resync(1);
    vi.advanceTimersByTime(2_000); // 6s total: past the 5s grace, inside the 10s shot clock
    expect(ended).toHaveLength(0);
    expect(inbox[1].at(-1)).toMatchObject({ t: "match_start", resumed: true });
  });
});
