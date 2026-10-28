import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress, keccak256, parseEther, recoverMessageAddress, toHex, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PLAY_TYPES, bankDomain, type ServerMessage } from "@8pool/shared";
import { Bankroll, Chain, MatchStatus, PlayAuth, ZERO_ADDRESS } from "./chain";
import { Config } from "./config";
import { GameServer, startServer } from "./server";
import { ResultStore, StoredResult } from "./store";
import { Client } from "./testutil";

const CONFIG: Config = {
  port: 0,
  tiers: ["0.001", "0.01"],
  shotClockMs: 30_000,
  graceMs: 30_000,
  maxTimeouts: 3,
  settleRetryMs: 50,
};

const key = (a: string) => a.toLowerCase();

/** In-memory stand-in for PoolBank: balances, locks, and switches to make transactions fail. */
class FakeChain implements Chain {
  info = { chainId: 11155111, bank: "0x000000000000000000000000000000000000dEaD", rpcUrl: "http://fake" };
  balances = new Map<string, bigint>();
  nonces = new Map<string, bigint>();
  matches = new Map<string, { a: string; b: string; stake: bigint; status: MatchStatus }>();
  locked = new Set<string>();
  startError: Error | null = null;
  settleError: Error | null = null;
  startCalls = 0;
  settleCalls: string[] = [];

  fund(addr: string, eth: string) {
    this.balances.set(key(addr), (this.balances.get(key(addr)) ?? 0n) + parseEther(eth));
  }
  balance = (addr: string) => this.balances.get(key(addr)) ?? 0n;

  stakeWei = (tier: string) => parseEther(tier);
  matchIdFor = (a: string, b: string, salt: string) => keccak256(toHex(`${key(a)}|${key(b)}|${salt}`));
  getStatus = async (id: string) => this.matches.get(id)?.status ?? MatchStatus.None;
  getBankroll = async (p: string): Promise<Bankroll> => ({ balance: this.balance(p), inMatch: this.locked.has(key(p)) });
  authNonce = async (p: string) => this.nonces.get(key(p)) ?? 0n;
  verifyPlayAuth = (player: string, a: PlayAuth) =>
    verifyTypedData({
      address: getAddress(player),
      domain: bankDomain(this.info),
      types: PLAY_TYPES,
      primaryType: "Play",
      message: { player: getAddress(player), maxStake: a.maxStake, expiry: BigInt(a.expiry), nonce: a.nonce },
      signature: a.signature as Hex,
    });

  async startMatch({ playerA, playerB, stake, salt }: Parameters<Chain["startMatch"]>[0]) {
    this.startCalls++;
    if (this.startError) throw this.startError;
    if (this.balance(playerA) < stake || this.balance(playerB) < stake) throw new Error("InsufficientBalance");
    this.balances.set(key(playerA), this.balance(playerA) - stake);
    this.balances.set(key(playerB), this.balance(playerB) - stake);
    this.locked.add(key(playerA)).add(key(playerB));
    const matchId = this.matchIdFor(playerA, playerB, salt);
    this.matches.set(matchId, { a: playerA, b: playerB, stake, status: MatchStatus.Active });
    return { matchId, txHash: "0xstart" };
  }

  async settle(matchId: string, winner: string) {
    this.settleCalls.push(matchId);
    if (this.settleError) throw this.settleError;
    const m = this.matches.get(matchId)!;
    m.status = MatchStatus.Settled;
    this.locked.delete(key(m.a));
    this.locked.delete(key(m.b));
    if (winner === ZERO_ADDRESS) {
      this.balances.set(key(m.a), this.balance(m.a) + m.stake);
      this.balances.set(key(m.b), this.balance(m.b) + m.stake);
    } else {
      this.balances.set(key(winner), this.balance(winner) + 2n * m.stake);
    }
    return "0xsettle";
  }

  signResult = async (id: string, winner: string) => `sig:${id}:${winner}`;
  recoverLogin = (message: string, signature: string) => recoverMessageAddress({ message, signature: signature as Hex });
  operatorBalance = async () => 10n ** 16n;
}

const wallet = () => privateKeyToAccount(generatePrivateKey());
type Wallet = ReturnType<typeof wallet>;

let server: GameServer;
let chain: FakeChain;
let store: ResultStore;
let clients: Client[];

async function boot(cfg: Config = CONFIG) {
  chain = new FakeChain();
  store = new ResultStore();
  server = await startServer(cfg, { chain, store });
}

async function connect(name: string, w?: Wallet, token?: string) {
  const c = new Client(server.port);
  clients.push(c);
  await c.open();
  c.send({ t: "hello", name, token });
  const welcome = await c.next("welcome");
  if (w) await login(c, w);
  return { c, welcome, w };
}

async function login(c: Client, w: Wallet) {
  c.send({ t: "auth_request", address: w.address });
  const { message } = await c.next("auth_challenge");
  c.send({ t: "auth", address: w.address, signature: await w.signMessage({ message }) });
  return c.next("authed");
}

/** Answer the server's `play_auth_request` with a real EIP-712 signature. */
async function authorize(c: Client, w: Wallet, over: Partial<{ maxStake: bigint; expiry: number }> = {}) {
  const req = await c.next("play_auth_request");
  const maxStake = over.maxStake ?? BigInt(req.maxStakeWei);
  const expiry = over.expiry ?? req.expiry;
  const nonce = BigInt(req.nonce);
  const signature = await w.signTypedData({
    domain: bankDomain(chain.info),
    types: PLAY_TYPES,
    primaryType: "Play",
    message: { player: w.address, maxStake, expiry: BigInt(expiry), nonce },
  });
  c.send({ t: "play_auth", maxStake: maxStake.toString(), expiry, nonce: nonce.toString(), signature });
}

/** Logged in, funded, and authorized: ready to queue. */
async function ready(name: string, eth = "1") {
  const w = wallet();
  chain.fund(w.address, eth);
  const p = await connect(name, w);
  await authorize(p.c, w);
  for (;;) if ((await p.c.next("bankroll")).authorized) break;
  return p;
}

async function paired() {
  const a = await ready("Ann");
  const b = await ready("Bob");
  a.c.send({ t: "queue", tier: "0.01" });
  b.c.send({ t: "queue", tier: "0.01" });
  const [s1, s2] = await Promise.all([a.c.next("match_start"), b.c.next("match_start")]);
  return { a, b, s1, s2 };
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(() => {
  clients = [];
});
afterEach(async () => {
  clients.forEach((c) => c.close());
  await server.close();
});

describe("wallet login", () => {
  beforeEach(() => boot());

  it("advertises the chain in the welcome message", async () => {
    const { welcome } = await connect("Ann");
    expect(welcome.chain).toMatchObject({ chainId: 11155111 });
  });

  it("refuses to queue until the wallet is verified", async () => {
    const { c } = await connect("Ann");
    c.send({ t: "queue", tier: "0.01" });
    expect((await c.next("error")).message).toMatch(/wallet/);
  });

  it("rejects a signature from a different key", async () => {
    const w = wallet(), imposter = wallet();
    const { c } = await connect("Ann");
    c.send({ t: "auth_request", address: w.address });
    const { message } = await c.next("auth_challenge");
    c.send({ t: "auth", address: w.address, signature: await imposter.signMessage({ message }) });
    expect((await c.next("error")).message).toMatch(/signature/);
  });

  it("makes each challenge single-use", async () => {
    const w = wallet();
    const { c } = await connect("Ann");
    c.send({ t: "auth_request", address: w.address });
    const { message } = await c.next("auth_challenge");
    const signature = await w.signMessage({ message });
    c.send({ t: "auth", address: w.address, signature });
    await c.next("authed");
    c.send({ t: "auth", address: w.address, signature });
    expect((await c.next("error")).message).toMatch(/no login/);
  });

  it("reports the bankroll and asks for a play authorization after login", async () => {
    const w = wallet();
    chain.fund(w.address, "0.5");
    const { c } = await connect("Ann", w);
    const b = await c.next("bankroll");
    expect(b).toMatchObject({ balanceWei: parseEther("0.5").toString(), authorized: false, inMatch: false });
    const req = await c.next("play_auth_request");
    expect(req.maxStakeWei).toBe(parseEther("0.1").toString()); // the biggest venue's final: double its 0.05 buy-in
  });
});

describe("play authorization", () => {
  beforeEach(() => boot());

  it("accepts a valid signature and marks the player authorized", async () => {
    const w = wallet();
    chain.fund(w.address, "1");
    const { c } = await connect("Ann", w);
    await authorize(c, w);
    let b;
    do b = await c.next("bankroll"); while (!b.authorized);
    expect(b.maxStakeWei).toBe(parseEther("0.1").toString());
  });

  it("rejects a signature from another wallet", async () => {
    const w = wallet(), imposter = wallet();
    const { c } = await connect("Ann", w);
    await authorize(c, imposter);
    expect((await c.next("error")).message).toMatch(/authorization/);
  });

  it("rejects a stale nonce (revoked on-chain)", async () => {
    const w = wallet();
    const { c } = await connect("Ann", w);
    chain.nonces.set(key(w.address), 1n); // player revoked after the request was issued
    await authorize(c, w);
    expect((await c.next("error")).message).toMatch(/authorization/);
  });

  it("rejects an authorization that is already expired", async () => {
    const w = wallet();
    const { c } = await connect("Ann", w);
    await authorize(c, w, { expiry: Math.floor(Date.now() / 1000) - 10 });
    expect((await c.next("error")).message).toMatch(/expiry/);
  });

  it("will not queue without one, and asks again", async () => {
    const w = wallet();
    chain.fund(w.address, "1");
    const { c } = await connect("Ann", w);
    c.send({ t: "queue", tier: "0.01" });
    expect((await c.next("error")).message).toMatch(/Approve play/);
    await c.next("play_auth_request");
  });

  it("will not queue for a stake above the authorized maximum", async () => {
    const w = wallet();
    chain.fund(w.address, "1");
    const { c } = await connect("Ann", w);
    await authorize(c, w, { maxStake: parseEther("0.001") });
    for (;;) if ((await c.next("bankroll")).authorized) break;
    c.send({ t: "queue", tier: "0.01" });
    expect((await c.next("error")).message).toMatch(/Approve play/);
  });

  it("remembers the authorization across page reloads", async () => {
    const w = wallet();
    chain.fund(w.address, "1");
    const first = await connect("Ann", w);
    await authorize(first.c, w);
    for (;;) if ((await first.c.next("bankroll")).authorized) break;
    first.c.close();

    const second = await connect("Ann", w);
    expect((await second.c.next("bankroll")).authorized).toBe(true);
    second.c.send({ t: "queue", tier: "0.01" });
    await second.c.next("queued");
  });
});

describe("queueing", () => {
  beforeEach(() => boot());

  it("refuses when the balance is below the stake", async () => {
    const { c } = await ready("Ann", "0.005");
    c.send({ t: "queue", tier: "0.01" });
    expect((await c.next("error")).message).toMatch(/balance/);
  });

  it("never pairs a wallet with itself", async () => {
    const w = wallet();
    chain.fund(w.address, "1");
    const a = await connect("Ann", w);
    await authorize(a.c, w);
    const b = await connect("Bob", w);
    a.c.send({ t: "queue", tier: "0.01" });
    b.c.send({ t: "queue", tier: "0.01" });
    await new Promise((r) => setTimeout(r, 200));
    expect(a.c.msgs.find((m) => m.t === "match_starting")).toBeUndefined();
    expect(chain.startCalls).toBe(0);
  });
});

describe("starting a match", () => {
  beforeEach(() => boot());

  it("locks both stakes in one transaction and starts the game with no deposits", async () => {
    const { a, b, s1, s2 } = await paired();
    expect(chain.startCalls).toBe(1);
    expect(s1.matchId).toBe(s2.matchId);
    expect(new Set([s1.seat, s2.seat])).toEqual(new Set([0, 1]));
    expect(chain.balance(a.w!.address)).toBe(parseEther("0.99"));
    expect(chain.balance(b.w!.address)).toBe(parseEther("0.99"));
    expect(a.c.msgs.some((m) => m.t === "match_starting")).toBe(true);
  });

  it("tells both players and keeps them free to requeue if the transaction fails", async () => {
    const a = await ready("Ann");
    const b = await ready("Bob");
    chain.startError = new Error("InsufficientBalance");
    a.c.send({ t: "queue", tier: "0.01" });
    b.c.send({ t: "queue", tier: "0.01" });
    const [fa, fb] = await Promise.all([a.c.next("match_failed"), b.c.next("match_failed")]);
    expect(fa.reason).toMatch(/balance/);
    expect(fb.reason).toMatch(/balance/);
    chain.startError = null;
    a.c.send({ t: "queue", tier: "0.01" });
    await a.c.next("queued");
  });
});

describe("settlement", () => {
  beforeEach(() => boot());

  it("credits the winner on-chain right after the game, with no claim step", async () => {
    const { a, b, s1 } = await paired();
    const [loser, winner] = s1.seat === 0 ? [a, b] : [b, a]; // seat 0 resigns below
    (s1.seat === 0 ? a : b).c.send({ t: "resign" });

    const [rl, rw] = await Promise.all([loser.c.next("result"), winner.c.next("result")]);
    expect(rw.settled).toBe(true);
    expect(rw.winner).toBe(winner.w!.address);
    expect(rw.txHash).toBe("0xsettle");
    expect(rw.signature).toBeUndefined();
    expect(rl.settled).toBe(true);
    expect(chain.balance(winner.w!.address)).toBe(parseEther("1.01"));
    expect(chain.balance(loser.w!.address)).toBe(parseEther("0.99"));
    expect(store.all()).toHaveLength(0);
    // And the players see their new balances.
    const nb = await winner.c.next("bankroll");
    expect(nb.inMatch === false || nb.balanceWei === parseEther("1.01").toString()).toBe(true);
  });

  it("settles even if the winner has already left", async () => {
    const { a, b, s1 } = await paired();
    const [loser, winner] = s1.seat === 0 ? [a, b] : [b, a];
    winner.c.close();
    await new Promise((r) => setTimeout(r, 50));
    loser.c.send({ t: "resign" });
    await waitFor(() => store.all().length === 0 && chain.settleCalls.length === 1);
    expect(chain.balance(winner.w!.address)).toBe(parseEther("1.01"));
  });

  it("keeps the signed result and offers a fallback claim if settling fails, then retries", async () => {
    const { a, b, s1 } = await paired();
    const [loser, winner] = s1.seat === 0 ? [a, b] : [b, a];
    chain.settleError = new Error("operator out of gas");
    loser.c.send({ t: "resign" });
    const r = await winner.c.next("result");
    expect(r.settled).toBe(false);
    expect(r.signature).toMatch(/^sig:/);
    expect(store.all()).toHaveLength(1);

    chain.settleError = null; // operator topped up: the retry loop settles it
    await waitFor(() => store.all().length === 0);
    expect(chain.balance(winner.w!.address)).toBe(parseEther("1.01"));
    const done = await winner.c.next("result");
    expect(done.settled).toBe(true);
  });

  it("drops a stored result that was already settled on-chain by someone else", async () => {
    const w = wallet();
    const r: StoredResult = { bankMatchId: "0xaaa", winner: w.address, signature: "sig", reason: "test", players: [w.address, wallet().address], createdAt: 1 };
    chain.matches.set("0xaaa", { a: w.address, b: r.players[1], stake: 1n, status: MatchStatus.Settled });
    store.add(r);
    await waitFor(() => store.all().length === 0);
    expect(chain.settleCalls).toHaveLength(0);
  });

  it("settles results left over from before a restart", async () => {
    const w = wallet(), other = wallet();
    chain.fund(w.address, "0");
    const id = "0xbbb";
    chain.matches.set(id, { a: w.address, b: other.address, stake: parseEther("0.01"), status: MatchStatus.Active });
    store.add({ bankMatchId: id, winner: w.address, signature: "sig", reason: "test", players: [w.address, other.address], createdAt: 1 });
    await waitFor(() => store.all().length === 0);
    expect(chain.balance(w.address)).toBe(parseEther("0.02"));
  });

  it("reports operator gas in /health", async () => {
    const res = await fetch(`http://localhost:${server.port}/health`);
    expect(await res.json()).toMatchObject({ staked: true, operatorWei: "10000000000000000" });
  });
});

describe("tournaments", () => {
  beforeEach(() => boot({ ...CONFIG, tournamentPollMs: 20 }));

  const tournamentStates = async (c: Client, pred: (s: Extract<ServerMessage, { t: "tournament_state" }>) => boolean) => {
    for (let i = 0; i < 20; i++) {
      const st = await c.next("tournament_state", 3000);
      if (pred(st)) return st;
    }
    throw new Error("no matching tournament_state");
  };

  it("refuses to join a venue whose final stake is above the player's authorization", async () => {
    const w = wallet();
    chain.fund(w.address, "1");
    const p = await connect("Ann", w);
    await authorize(p.c, w, { maxStake: parseEther("0.01") }); // covers the quick-match tiers only
    for (;;) if ((await p.c.next("bankroll")).authorized) break;
    p.c.send({ t: "tournament_join", venue: "space" });
    expect((await p.c.next("error")).message).toMatch(/Approve play/);
  });

  it("refuses to join with a balance below the buy-in", async () => {
    const p = await ready("Ann", "0.0001");
    p.c.send({ t: "tournament_join", venue: "local" });
    expect((await p.c.next("error")).message).toMatch(/below the 0\.001 ETH buy-in/);
  });

  it("locks the buy-in in the semifinals, doubles it in the final and pays the whole pot to the champion", async () => {
    const players = [await ready("Ann"), await ready("Bob"), await ready("Cy"), await ready("Di")];
    players.forEach((p) => p.c.send({ t: "tournament_join", venue: "local" }));
    const starts = await Promise.all(players.map((p) => p.c.next("match_start")));
    expect(starts.every((m) => m.tier === "0.001" && m.tournament?.round === "semis")).toBe(true);
    const buyIn = parseEther("0.001");
    for (const p of players) expect(chain.balance(p.w!.address)).toBe(parseEther("1") - buyIn);

    // One player in each semifinal resigns.
    const byMatch = new Map<string, number[]>();
    starts.forEach((m, i) => byMatch.set(m.matchId, [...(byMatch.get(m.matchId) ?? []), i]));
    expect(byMatch.size).toBe(2);
    const winners: number[] = [];
    for (const [first, second] of byMatch.values()) {
      players[first].c.send({ t: "resign" });
      winners.push(second);
    }
    for (const w of winners) expect(await players[w].c.next("game_over")).toMatchObject({ winner: starts[w].seat });

    // Winners carry their winnings into the final, which stakes double.
    const finals = await Promise.all(winners.map((w) => players[w].c.next("match_start", 4000)));
    expect(finals.every((m) => m.tier === "0.002" && m.tournament?.round === "final")).toBe(true);
    expect(finals[0].matchId).toBe(finals[1].matchId);
    for (const w of winners) expect(chain.balance(players[w].w!.address)).toBe(parseEther("1") + buyIn - 2n * buyIn);

    players[winners[0]].c.send({ t: "resign" });
    await Promise.all(winners.map((w) => players[w].c.next("game_over")));
    const champ = winners[1];
    await waitFor(() => store.all().length === 0);
    expect(chain.balance(players[champ].w!.address)).toBe(parseEther("1") + 3n * buyIn);
    expect(chain.balance(players[winners[0]].w!.address)).toBe(parseEther("1") - buyIn);
    const done = await tournamentStates(players[champ].c, (st) => st.stage === "done");
    expect(done.champion).toBe(done.you);
    expect(done.pot).toBe("0.004");
  });

  it("cancels the tournament and keeps winnings if the final's stakes can't be locked", async () => {
    const players = [await ready("Ann"), await ready("Bob"), await ready("Cy"), await ready("Di")];
    players.forEach((p) => p.c.send({ t: "tournament_join", venue: "local" }));
    const starts = await Promise.all(players.map((p) => p.c.next("match_start")));
    const byMatch = new Map<string, number[]>();
    starts.forEach((m, i) => byMatch.set(m.matchId, [...(byMatch.get(m.matchId) ?? []), i]));
    const winners: number[] = [];
    chain.startError = new Error("InsufficientBalance"); // the semifinals are already running; only the final fails
    for (const [first, second] of byMatch.values()) {
      players[first].c.send({ t: "resign" });
      winners.push(second);
    }
    for (const w of winners) await players[w].c.next("game_over");
    const failed = await players[winners[0]].c.next("tournament_failed", 4000);
    expect(failed.reason).toMatch(/final/i);
  });
});
