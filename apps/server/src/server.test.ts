import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "./testutil";
import { Config } from "./config";
import { GameServer, startServer } from "./server";
import { RoomResult } from "./room";
import type { ServerMessage } from "@8pool/shared";

const CONFIG: Config = { port: 0, tiers: ["0.001", "0.01"], shotClockMs: 30_000, graceMs: 30_000, maxTimeouts: 3 };

let server: GameServer;
let results: RoomResult[];
let clients: Client[];

async function connect(name: string, token?: string) {
  const c = new Client(server.port);
  clients.push(c);
  await c.open();
  c.send({ t: "hello", name, token });
  const welcome = await c.next("welcome");
  return { c, welcome };
}

beforeEach(async () => {
  results = [];
  clients = [];
  server = await startServer(CONFIG, { onMatchEnd: (r) => results.push(r) });
});
afterEach(async () => {
  clients.forEach((c) => c.close());
  await server.close();
});

async function pairUp() {
  const a = await connect("Ann");
  const b = await connect("Bob");
  a.c.send({ t: "queue", tier: "0.01" });
  b.c.send({ t: "queue", tier: "0.01" });
  const [sa, sb] = await Promise.all([a.c.next("match_start"), b.c.next("match_start")]);
  return { a, b, sa, sb };
}

describe("server", () => {
  it("issues a token and lists the stake tiers on hello", async () => {
    const { welcome } = await connect("Ann");
    expect(welcome.token).toBeTruthy();
    expect(welcome.tiers).toEqual(["0.001", "0.01"]);
  });

  it("rejects messages before hello and malformed messages", async () => {
    const c = new Client(server.port);
    clients.push(c);
    await c.open();
    c.send({ t: "queue", tier: "0.01" });
    expect((await c.next("error")).message).toMatch(/hello/);
    c.ws.send("not json");
    expect((await c.next("error")).message).toMatch(/bad message/);
  });

  it("pairs two players in the same tier with opposite seats", async () => {
    const { sa, sb } = await pairUp();
    expect(sa.matchId).toBe(sb.matchId);
    expect(new Set([sa.seat, sb.seat])).toEqual(new Set([0, 1]));
    expect(sa.names.slice().sort()).toEqual(["Ann", "Bob"]);
  });

  it("does not pair players in different tiers", async () => {
    const a = await connect("Ann");
    const b = await connect("Bob");
    a.c.send({ t: "queue", tier: "0.001" });
    b.c.send({ t: "queue", tier: "0.01" });
    await a.c.next("queued");
    await b.c.next("queued");
    await new Promise((r) => setTimeout(r, 100));
    expect(a.c.msgs.find((m) => m.t === "match_start")).toBeUndefined();
  });

  it("rejects an unknown tier and leaving the queue works", async () => {
    const a = await connect("Ann");
    a.c.send({ t: "queue", tier: "999" });
    expect((await a.c.next("error")).message).toMatch(/tier/);
    a.c.send({ t: "queue", tier: "0.01" });
    await a.c.next("queued");
    a.c.send({ t: "leave_queue" });
    await a.c.next("queue_left");
    const b = await connect("Bob");
    b.c.send({ t: "queue", tier: "0.01" });
    await b.c.next("queued");
    await new Promise((r) => setTimeout(r, 100));
    expect(b.c.msgs.find((m) => m.t === "match_start")).toBeUndefined();
  });

  it("relays a shot to both players and enforces turn order", async () => {
    const { a, b, sa } = await pairUp();
    const [breaker, other] = sa.seat === 0 ? [a, b] : [b, a];
    other.c.send({ t: "shot", angle: 0, power: 0.5 });
    expect((await other.c.next("error")).message).toBe("not your turn");

    breaker.c.send({ t: "shot", angle: 0, power: 0.9 });
    const [r1, r2] = await Promise.all([breaker.c.next("shot_result"), other.c.next("shot_result")]);
    expect(r1.report.frames.length).toBeGreaterThan(2);
    expect(r2.state).toEqual(r1.state);
  });

  it("relays a shot's spin to both players and rejects spin outside the cue ball", async () => {
    const { a, b, sa } = await pairUp();
    const [breaker, other] = sa.seat === 0 ? [a, b] : [b, a];
    breaker.c.send({ t: "shot", angle: 0, power: 0.9, spin: { x: 1, y: 1 } });
    expect((await breaker.c.next("error")).message).toMatch(/bad message/);

    breaker.c.send({ t: "shot", angle: 0, power: 0.9, spin: { x: 0.4, y: -0.6 } });
    const [r1, r2] = await Promise.all([breaker.c.next("shot_result"), other.c.next("shot_result")]);
    expect(r1.shot.spin).toEqual({ x: 0.4, y: -0.6 });
    expect(r2.shot.spin).toEqual({ x: 0.4, y: -0.6 });
  });

  it("broadcasts preset emotes, rate limits them and ignores unknown ones", async () => {
    const { a, b, sa } = await pairUp();
    a.c.send({ t: "emote", id: "gg" });
    const [ea, eb] = await Promise.all([a.c.next("emote"), b.c.next("emote")]);
    expect(ea).toEqual({ t: "emote", seat: sa.seat, id: "gg" });
    expect(eb).toEqual(ea);

    a.c.send({ t: "emote", id: "nice" }); // inside the cooldown
    expect((await a.c.next("error")).message).toBe("slow down");

    b.c.send({ t: "emote", id: "not-an-emote" as never });
    expect((await b.c.next("error")).message).toMatch(/bad message/);
  });

  it("refuses emotes outside a match", async () => {
    const a = await connect("Ann");
    a.c.send({ t: "emote", id: "gg" });
    expect((await a.c.next("error")).message).toBe("not in a match");
  });

  it("ends the match and reports the result when a player resigns", async () => {
    const { a, b, sa } = await pairUp();
    a.c.send({ t: "resign" });
    const [go] = await Promise.all([b.c.next("game_over"), a.c.next("game_over")]);
    const loserSeat = sa.seat;
    expect(go.winner).toBe(loserSeat === 0 ? 1 : 0);
    expect(results).toHaveLength(1);
    expect(results[0].reason).toBe("Ann resigned");
  });

  it("lets a dropped player resume the match with their token", async () => {
    const { a, b, sa } = await pairUp();
    a.c.close();
    const status = await b.c.next("opponent_status");
    expect(status.connected).toBe(false);

    const back = await connect("whoever", a.welcome.token);
    expect(back.welcome.resumed).toBe(true);
    const resumed = await back.c.next("match_start");
    expect(resumed).toMatchObject({ resumed: true, seat: sa.seat, matchId: sa.matchId });
    expect((await b.c.next("opponent_status")).connected).toBe(true);
  });

  it("forfeits a disconnected player after the grace period", async () => {
    await server.close();
    server = await startServer({ ...CONFIG, graceMs: 150 }, { onMatchEnd: (r) => results.push(r) });
    const { a, b } = await pairUp();
    a.c.close();
    const go = await b.c.next("game_over", 3000);
    expect(go.reason).toBe("Ann disconnected");
    expect(results).toHaveLength(1);
  });
});

describe("tournaments", () => {
  type St = Extract<ServerMessage, { t: "tournament_state" }>;

  async function fourPlayers(venue = "local") {
    const names = ["Ann", "Bob", "Cy", "Di"];
    const ps = [];
    for (const n of names) ps.push(await connect(n));
    ps.forEach((p) => p.c.send({ t: "tournament_join", venue }));
    const states = await Promise.all(ps.map((p) => p.c.next("tournament_state")));
    const starts = await Promise.all(ps.map((p) => p.c.next("match_start")));
    return { ps, states, starts };
  }

  const untilState = async (c: Client, pred: (s: St) => boolean) => {
    for (let i = 0; i < 20; i++) {
      const s = await c.next("tournament_state", 3000);
      if (pred(s)) return s;
    }
    throw new Error("no matching tournament_state");
  };

  const semiPairs = (starts: { matchId: string }[]) => {
    const by = new Map<string, number[]>();
    starts.forEach((m, i) => by.set(m.matchId, [...(by.get(m.matchId) ?? []), i]));
    return [...by.values()];
  };

  it("tells players how full the lobby is, and lets them leave before the bracket is drawn", async () => {
    const a = await connect("Ann");
    const b = await connect("Bob");
    a.c.send({ t: "tournament_join", venue: "vegas" });
    expect(await a.c.next("tournament_lobby")).toMatchObject({ venue: "vegas", joined: 1, size: 4 });
    b.c.send({ t: "tournament_join", venue: "vegas" });
    expect((await a.c.next("tournament_lobby")).joined).toBe(2);
    b.c.send({ t: "tournament_leave" });
    await b.c.next("tournament_left");
    expect((await a.c.next("tournament_lobby")).joined).toBe(1);
  });

  it("rejects unknown venues, double joins and leaving a drawn bracket", async () => {
    const a = await connect("Ann");
    a.c.send({ t: "tournament_join", venue: "nowhere" });
    expect((await a.c.next("error")).message).toMatch(/venue/);
    a.c.send({ t: "tournament_join", venue: "local" });
    await a.c.next("tournament_lobby");
    a.c.send({ t: "tournament_join", venue: "local" });
    expect((await a.c.next("error")).message).toMatch(/already/);
    a.c.send({ t: "queue", tier: "0.01" });
    expect((await a.c.next("error")).message).toMatch(/already/);

    const { ps } = await fourPlayers("dubai");
    ps[0].c.send({ t: "tournament_leave" });
    expect((await ps[0].c.next("error")).message).toMatch(/already drawn/);
  });

  it("draws a bracket for four players and starts both semifinals at the buy-in", async () => {
    const { states, starts } = await fourPlayers("vegas");
    expect(states.map((s) => s.you).sort()).toEqual([0, 1, 2, 3]);
    for (const s of states) {
      expect(s).toMatchObject({ venue: "vegas", stage: "semis", buyIn: "0.005", finalStake: "0.01", pot: "0.02", champion: null });
      expect(s.slots).toEqual(states[0].slots);
    }
    expect(starts.every((m) => m.tournament?.round === "semis" && m.tier === "0.005")).toBe(true);
    const pairs = semiPairs(starts);
    expect(pairs).toHaveLength(2);
    // Slots 0-1 and 2-3 share a semifinal.
    for (const [x, y] of pairs) expect(Math.floor(states[x].you / 2)).toBe(Math.floor(states[y].you / 2));
  });

  it("plays semifinals, then the final, and crowns a champion", async () => {
    const { ps, states, starts } = await fourPlayers("local");
    const winners: number[] = [];
    for (const [loser, winner] of semiPairs(starts)) {
      ps[loser].c.send({ t: "resign" });
      winners.push(winner);
    }
    for (const w of winners) await ps[w].c.next("game_over");

    const finals = await Promise.all(winners.map((w) => ps[w].c.next("match_start", 3000)));
    expect(finals.every((m) => m.tournament?.round === "final" && m.tier === "0.002")).toBe(true);
    const mid = await untilState(ps[winners[0]].c, (s) => s.stage === "final");
    expect(mid.semiWinners.every((x) => x !== null)).toBe(true);

    ps[winners[0]].c.send({ t: "resign" });
    const done = await untilState(ps[winners[1]].c, (s) => s.stage === "done");
    expect(done.champion).toBe(states[winners[1]].you);
    expect(done.note).toMatch(/champion/);
    // Everyone can use the normal queue again.
    ps[winners[1]].c.send({ t: "queue", tier: "0.01" });
    expect((await ps[winners[1]].c.next("queued")).tier).toBe("0.01");
  });

  it("frees a knocked-out player to queue elsewhere while the bracket continues", async () => {
    const { ps, starts } = await fourPlayers("local");
    const [loser] = semiPairs(starts)[0];
    ps[loser].c.send({ t: "resign" });
    await ps[loser].c.next("game_over");
    await untilState(ps[loser].c, (s) => s.semiWinners.some((x) => x !== null));
    ps[loser].c.send({ t: "queue", tier: "0.01" });
    expect((await ps[loser].c.next("queued")).tier).toBe("0.01");
  });

  it("restores the bracket for a winner who reconnects between rounds", async () => {
    const { ps, starts } = await fourPlayers("local");
    const [loser, winner] = semiPairs(starts)[0];
    ps[loser].c.send({ t: "resign" });
    await ps[winner].c.next("game_over");
    ps[winner].c.close();
    await new Promise((r) => setTimeout(r, 50));
    const back = await connect("x", ps[winner].welcome.token);
    expect(back.welcome.resumed).toBe(false);
    const st = await back.c.next("tournament_state");
    expect(st.stage).toBe("semis");
    expect(st.semiWinners.some((x) => x === st.you)).toBe(true);
  });
});
