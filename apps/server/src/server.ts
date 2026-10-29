import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { formatEther, parseEther } from "viem";
import {
  PRIVATE_CODE_ALPHABET, PRIVATE_CODE_LEN, PRIVATE_MAX_STAKE, PRIVATE_MIN_STAKE, Seat, ServerMessage, TOURNAMENT_SIZE, TournamentRound, TournamentView, VENUES, Venue,
  parseClientMessage,
} from "@8pool/shared";
import { Chain, MatchStatus, PlayAuth, sameAddress } from "./chain";
import { Config } from "./config";
import { PlayerStore, guestKey, walletKey } from "./players";
import { Room, RoomResult } from "./room";
import { ResultStore, StoredResult } from "./store";

interface Session {
  token: string;
  name: string;
  address: string | null; // set once the wallet signature is verified
  pendingAuth: { address: string; message: string } | null;
  ws: WebSocket | null;
  room: Room | null;
  /** True while the stakes are being locked on-chain, between pairing and the first shot. */
  starting: boolean;
  /** True while queue eligibility (balance, authorization) is being checked. */
  checking: boolean;
  auth: PlayAuth | null;
  seat: Seat;
  queuedTier: string | null;
  /** Venue whose tournament lobby the player is waiting in. */
  tVenue: string | null;
  /** Bracket the player is still alive in. */
  tournament: Tournament | null;
  /** Private room the player is waiting in (as host) or has just joined. */
  priv: PrivateRoom | null;
  /** Ranking identity: the wallet once signed in, otherwise the browser's guest id. */
  key: string;
  /** Public id for `key`. */
  pid: string;
}

/** A friends-only table: the host picks the stake, a friend joins with the code. Never rated. */
interface PrivateRoom {
  code: string;
  stake: string;
  host: Session;
  guest: Session | null;
  expiry: NodeJS.Timeout;
}

/** One knockout bracket. Slots 0-1 play the first semifinal, 2-3 the second. */
interface Tournament {
  id: string;
  venue: Venue;
  players: Session[];
  stage: TournamentRound | "done";
  semiWinners: [number | null, number | null];
  champion: number | null;
}

/** Hooks a match back into its bracket. */
interface MatchCtx {
  tournament: { id: string; round: TournamentRound };
  onDone(winner: Session): void;
  onFail(): void;
}

interface Conn extends WebSocket {
  session?: Session;
  alive?: boolean;
  msgCount?: number;
}

export interface GameServer {
  port: number;
  close(): Promise<void>;
}

export interface ServerHooks {
  onMatchEnd?: (r: RoomResult) => void;
  /** Enables staked matches. Without it the server runs free matches only. */
  chain?: Chain;
  store?: ResultStore;
  /** Ratings and match history. Defaults to an in-memory store. */
  players?: PlayerStore;
}

const MAX_MSGS_PER_SEC = 30;

export function startServer(config: Config, hooks: ServerHooks = {}): Promise<GameServer> {
  const chain = hooks.chain;
  const store = hooks.store ?? new ResultStore();
  const players = hooks.players ?? new PlayerStore();
  const privateMax = config.privateMaxStake ?? PRIVATE_MAX_STAKE;
  const privates = new Map<string, PrivateRoom>();
  const settleRetryMs = config.settleRetryMs ?? 30_000;
  const authTtlMs = config.authTtlMs ?? 24 * 3600_000;

  const sessions = new Map<string, Session>();
  const queues = new Map<string, Session[]>(config.tiers.map((t) => [t, []]));
  const rooms = new Map<string, Room>();
  const venues = config.venues ?? VENUES;
  const tQueues = new Map<string, Session[]>(venues.map((v) => [v.id, []]));
  const tournaments = new Map<string, Tournament>();
  const doubled = (eth: string) => formatEther(parseEther(eth) * 2n);
  const potOf = (v: Venue) => formatEther(parseEther(v.buyIn) * BigInt(TOURNAMENT_SIZE));
  /** Play authorizations by wallet, so reloading the page doesn't mean signing again. */
  const authsByAddress = new Map<string, PlayAuth>();
  const settling = new Set<string>();
  let starting = 0;

  const send = (ws: WebSocket | null, msg: ServerMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const http = createHttpServer(async (req, res) => {
    if (req.url === "/health") {
      const operatorWei = chain ? await chain.operatorBalance().then(String, () => null) : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, starting, sessions: sessions.size, staked: !!chain, unsettled: store.all().length, operatorWei }));
    } else {
      res.writeHead(404).end();
    }
  });
  const allowedOrigins = config.allowedOrigins ?? [];
  const wss = new WebSocketServer({
    server: http,
    maxPayload: 4096,
    // Browsers always send Origin, so this stops other sites from driving a visitor's wallet session.
    verifyClient: ({ origin }: { origin: string }) => allowedOrigins.length === 0 || allowedOrigins.includes(origin),
  });

  const liveFor = (players: readonly string[]) =>
    [...sessions.values()].filter((s) => s.ws && s.address && players.some((p) => sameAddress(p, s.address!)));
  // A finalist stakes double the buy-in, so the play authorization must cover that too.
  const maxTierStake = () =>
    [...config.tiers, ...venues.map((v) => doubled(v.buyIn)), privateMax].map((t) => chain!.stakeWei(t)).reduce((m, v) => (v > m ? v : m), 0n);

  // ------------------------------------------------------------------ bankroll & play authorization

  /** Current on-chain balance for the player; optionally also asks them to (re)sign a play authorization. */
  const sendBankroll = async (s: Session, requestAuth = false) => {
    if (!chain || !s.address) return;
    try {
      const [b, nonce] = await Promise.all([chain.getBankroll(s.address), chain.authNonce(s.address)]);
      // Drop an authorization that was revoked on-chain or is about to expire.
      if (s.auth && (s.auth.nonce !== nonce || s.auth.expiry * 1000 < Date.now() + 60_000)) {
        s.auth = null;
        authsByAddress.delete(s.address.toLowerCase());
      }
      send(s.ws, {
        t: "bankroll", balanceWei: b.balance.toString(), inMatch: b.inMatch, authorized: !!s.auth,
        authExpiry: s.auth?.expiry, maxStakeWei: s.auth?.maxStake.toString(),
      });
      if (!s.auth && requestAuth) {
        send(s.ws, {
          t: "play_auth_request", maxStakeWei: maxTierStake().toString(), nonce: nonce.toString(),
          expiry: Math.floor((Date.now() + authTtlMs) / 1000),
        });
      }
    } catch (e) {
      console.error("bankroll read failed:", e);
      send(s.ws, { t: "error", message: "Couldn't read your balance from the chain. Try again." });
    }
  };

  const adoptAuth = (s: Session, auth: PlayAuth) => {
    s.auth = auth;
    authsByAddress.set(s.address!.toLowerCase(), auth);
  };

  // ------------------------------------------------------------------ settlement

  /** Submit a stored result on-chain. The winner's balance is credited inside the contract. */
  const trySettle = async (r: StoredResult, notifyFailure: boolean): Promise<boolean> => {
    if (!chain || settling.has(r.bankMatchId)) return false;
    settling.add(r.bankMatchId);
    const live = liveFor(r.players);
    try {
      let txHash: string | undefined;
      // Someone else (e.g. the winner's own fallback claim) may have settled it already.
      if ((await chain.getStatus(r.bankMatchId)) === MatchStatus.Active) {
        txHash = await chain.settle(r.bankMatchId, r.winner, r.signature);
      }
      store.remove(r.bankMatchId);
      for (const s of live) {
        send(s.ws, { t: "result", bankMatchId: r.bankMatchId, winner: r.winner, reason: r.reason, settled: true, txHash });
        void sendBankroll(s);
      }
      return true;
    } catch (e) {
      console.error(`settle failed for ${r.bankMatchId}:`, e instanceof Error ? e.message : e);
      if (notifyFailure) {
        for (const s of live) {
          send(s.ws, { t: "result", bankMatchId: r.bankMatchId, winner: r.winner, reason: r.reason, settled: false, signature: r.signature });
        }
      }
      return false;
    } finally {
      settling.delete(r.bankMatchId);
    }
  };

  /** Sign the outcome, persist it, and settle right away. */
  const issueResult = async (bankMatchId: string, winner: string, players: [string, string], reason: string): Promise<void> => {
    if (!chain) return;
    try {
      const signature = await chain.signResult(bankMatchId, winner);
      const r: StoredResult = { bankMatchId, winner, signature, reason, players, createdAt: Date.now() };
      store.add(r);
      await trySettle(r, true);
    } catch (e) {
      console.error(`failed to sign result for ${bankMatchId}:`, e);
    }
  };

  const retryTimer = setInterval(() => {
    if (!chain) return;
    for (const r of store.all()) void trySettle(r, false);
  }, settleRetryMs);
  if (chain) for (const r of store.all()) void trySettle(r, false); // after a restart

  // ------------------------------------------------------------------ matchmaking

  const dequeue = (s: Session) => {
    if (!s.queuedTier) return;
    const q = queues.get(s.queuedTier);
    const i = q ? q.indexOf(s) : -1;
    if (q && i >= 0) q.splice(i, 1);
    s.queuedTier = null;
  };

  const startMatch = (a: Session, b: Session, tier: string, bankMatchId?: string, ctx?: MatchCtx, ranked = true) => {
    const [p0, p1] = randomInt(2) === 0 ? [a, b] : [b, a];
    const seats = [p0, p1] as const;
    // Identities are fixed now: signing in with a wallet mid-match must not move the result to another profile.
    const pids = [p0.pid, p1.pid] as const;
    const rated = ranked && pids[0] !== pids[1];
    const room = new Room(
      randomUUID(),
      tier,
      [p0.name, p1.name],
      (seat, msg) => send(seats[seat].ws, msg),
      (result) => {
        rooms.delete(room.id);
        for (const s of seats) {
          s.room = null;
          if (!s.ws && !s.tournament) sessions.delete(s.token);
        }
        hooks.onMatchEnd?.(result);
        const winnerSession = result.winner === 0 ? p0 : p1;
        const loserSession = result.winner === 0 ? p1 : p0;
        if (pids[0] !== pids[1]) {
          const won = result.winner === 0 ? pids[0] : pids[1];
          const lost = result.winner === 0 ? pids[1] : pids[0];
          const rec = players.record(won, lost, tier, rated);
          if (rec) {
            send(winnerSession.ws, { t: "rating", won: true, delta: rec.winner, rating: rec.ratings[0], ranked: rated });
            send(loserSession.ws, { t: "rating", won: false, delta: rec.loser, rating: rec.ratings[1], ranked: rated });
          }
        }
        if (bankMatchId && p0.address && p1.address) {
          const winner = winnerSession.address!;
          const settled = issueResult(bankMatchId, winner, [p0.address, p1.address], result.reason);
          if (ctx) void settled.then(() => ctx.onDone(winnerSession));
        } else if (ctx) {
          ctx.onDone(winnerSession);
        }
      },
      { shotClockMs: config.shotClockMs, graceMs: config.graceMs, maxTimeouts: config.maxTimeouts, seed: randomInt(2 ** 32) },
      ctx?.tournament,
      { players: [{ pid: pids[0], rating: players.rating(pids[0]) }, { pid: pids[1], rating: players.rating(pids[1]) }], ranked: rated },
    );
    seats.forEach((s, i) => {
      s.room = room;
      s.starting = false;
      s.seat = i as Seat;
      s.queuedTier = null;
    });
    rooms.set(room.id, room);
    room.start();
    // A player who dropped while the stakes were locking starts the match already on the disconnect clock.
    seats.forEach((s, i) => {
      if (!s.ws) room.setConnected(i as Seat, false);
    });
  };

  const friendlyStartError = (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    if (/InsufficientBalance/.test(m)) return "A player's balance was too low to lock the stake.";
    if (/BadAuthorization/.test(m)) return "A play authorization expired or was revoked.";
    if (/AlreadyPlaying/.test(m)) return "A player is already in a running match.";
    return "Couldn't lock the stakes on-chain.";
  };

  /** Lock both stakes in one transaction, then start the game. */
  const startStaked = async (a: Session, b: Session, tier: string, ctx?: MatchCtx, ranked = true) => {
    const authA = a.auth, authB = b.auth;
    a.queuedTier = b.queuedTier = null;
    a.starting = b.starting = true;
    starting++;
    for (const [me, other] of [[a, b], [b, a]] as const) send(me.ws, { t: "match_starting", tier, opponent: other.name });
    try {
      if (!chain || !a.address || !b.address || !authA || !authB) throw new Error("missing authorization");
      const salt = "0x" + randomBytes(32).toString("hex");
      const { matchId } = await chain.startMatch({ playerA: a.address, playerB: b.address, stake: chain.stakeWei(tier), salt, authA, authB });
      startMatch(a, b, tier, matchId, ctx, ranked);
    } catch (e) {
      console.error("startMatch failed:", e instanceof Error ? e.message : e);
      for (const s of [a, b]) {
        s.starting = false;
        send(s.ws, { t: "match_failed", reason: friendlyStartError(e) });
        void sendBankroll(s, true);
        if (!s.ws && !s.tournament) sessions.delete(s.token);
      }
      ctx?.onFail();
    } finally {
      starting--;
    }
  };

  const tryMatch = (tier: string) => {
    const q = queues.get(tier)!;
    while (q.length >= 2) {
      const a = q.shift()!;
      // Never pair a wallet with itself.
      const j = q.findIndex((b) => !(chain && a.address && b.address && sameAddress(a.address, b.address)));
      if (j < 0) {
        q.unshift(a);
        return;
      }
      const [b] = q.splice(j, 1);
      a.queuedTier = b.queuedTier = null;
      if (chain) void startStaked(a, b, tier);
      else startMatch(a, b, tier);
    }
  };

  // ------------------------------------------------------------------ tournaments

  const viewFor = (t: Tournament, slot: number, note?: string): TournamentView => ({
    id: t.id,
    venue: t.venue.id,
    buyIn: t.venue.buyIn,
    finalStake: doubled(t.venue.buyIn),
    pot: potOf(t.venue),
    stage: t.stage,
    slots: t.players.map((p) => p.name) as TournamentView["slots"],
    semiWinners: t.semiWinners,
    champion: t.champion,
    you: slot,
    note,
  });

  const pushState = (t: Tournament, note?: string) =>
    t.players.forEach((p, i) => send(p.ws, { t: "tournament_state", ...viewFor(t, i, note) }));

  const tDequeue = (s: Session) => {
    if (!s.tVenue) return;
    const q = tQueues.get(s.tVenue);
    const i = q ? q.indexOf(s) : -1;
    if (q && i >= 0) q.splice(i, 1);
    const venue = s.tVenue;
    s.tVenue = null;
    if (q) q.forEach((p) => send(p.ws, { t: "tournament_lobby", venue, joined: q.length, size: TOURNAMENT_SIZE }));
  };

  const releasePlayers = (t: Tournament) => {
    for (const p of t.players) {
      if (p.tournament === t) p.tournament = null;
      if (!p.ws && !p.room && !p.starting && !p.tournament) sessions.delete(p.token);
    }
    tournaments.delete(t.id);
  };

  const abortTournament = (t: Tournament, reason: string) => {
    if (t.stage === "done") return;
    t.stage = "done";
    for (const p of t.players) send(p.ws, { t: "tournament_failed", reason });
    releasePlayers(t);
  };

  /** True once nobody in the pair is still holding stakes in a settling match. */
  const waitUntilIdle = async (players: Session[]): Promise<boolean> => {
    if (!chain) return true;
    const pollMs = config.tournamentPollMs ?? 2000;
    for (let i = 0; i < 15; i++) {
      const states = await Promise.all(players.map((p) => chain.getBankroll(p.address!).then((b) => b.inMatch, () => true)));
      if (states.every((inMatch) => !inMatch)) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  };

  const playMatch = (t: Tournament, a: number, b: number, round: TournamentRound) => {
    const pa = t.players[a], pb = t.players[b];
    const tier = round === "semis" ? t.venue.buyIn : doubled(t.venue.buyIn);
    const ctx: MatchCtx = {
      tournament: { id: t.id, round },
      onDone: (winner) => onMatchDone(t, round, a, winner === pa ? a : b),
      onFail: () => abortTournament(t, round === "semis" ? "A semifinal couldn't start, so the tournament was cancelled." : "The final couldn't start. You keep your semifinal winnings."),
    };
    if (chain) void startStaked(pa, pb, tier, ctx);
    else startMatch(pa, pb, tier, undefined, ctx);
  };

  const startFinal = async (t: Tournament) => {
    const [w0, w1] = t.semiWinners as [number, number];
    t.stage = "final";
    pushState(t, "Both semifinals are done. The final is next.");
    if (!(await waitUntilIdle([t.players[w0], t.players[w1]]))) {
      return abortTournament(t, "Semifinal winnings weren't released in time to start the final. You keep your winnings.");
    }
    if (t.stage !== "final") return;
    playMatch(t, w0, w1, "final");
  };

  function onMatchDone(t: Tournament, round: TournamentRound, firstSlot: number, winnerSlot: number) {
    if (t.stage === "done") return;
    const winner = t.players[winnerSlot];
    if (round === "semis") {
      t.semiWinners[firstSlot === 0 ? 0 : 1] = winnerSlot;
      // Whoever lost is out: free them to queue elsewhere. They keep receiving bracket updates.
      for (const i of [firstSlot, firstSlot + 1]) {
        if (i !== winnerSlot && t.players[i].tournament === t) t.players[i].tournament = null;
      }
      pushState(t, `${winner.name} wins the semifinal.`);
      if (t.semiWinners[0] !== null && t.semiWinners[1] !== null) void startFinal(t);
      return;
    }
    t.champion = winnerSlot;
    t.stage = "done";
    pushState(t, `${winner.name} is the champion!`);
    releasePlayers(t);
  }

  const startTournament = (venue: Venue, picked: Session[]) => {
    for (let i = picked.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    const t: Tournament = { id: randomUUID(), venue, players: picked, stage: "semis", semiWinners: [null, null], champion: null };
    tournaments.set(t.id, t);
    for (const p of picked) {
      p.tVenue = null;
      p.tournament = t;
    }
    pushState(t, "The bracket is drawn. Semifinals start now.");
    playMatch(t, 0, 1, "semis");
    playMatch(t, 2, 3, "semis");
  };

  const tryTournament = (venue: Venue) => {
    const q = tQueues.get(venue.id)!;
    const picked: Session[] = [];
    for (const c of q) {
      const dup = chain && picked.some((p) => p.address && c.address && sameAddress(p.address, c.address));
      if (picked.length < TOURNAMENT_SIZE && !dup) picked.push(c);
    }
    if (picked.length < TOURNAMENT_SIZE) return;
    for (const p of picked) q.splice(q.indexOf(p), 1);
    startTournament(venue, picked);
  };

  // ------------------------------------------------------------------ private rooms

  const PRIVATE_TTL_MS = 15 * 60_000;
  const privView = (pr: PrivateRoom, you: "host" | "guest"): ServerMessage => ({
    t: "private_state", code: pr.code, stake: pr.stake, host: pr.host.name, guest: pr.guest?.name ?? null, you,
  });
  const pushPrivate = (pr: PrivateRoom) => {
    send(pr.host.ws, privView(pr, "host"));
    if (pr.guest) send(pr.guest.ws, privView(pr, "guest"));
  };
  const closePrivate = (pr: PrivateRoom, reason: string, notify: Session[] = [pr.host, ...(pr.guest ? [pr.guest] : [])]) => {
    clearTimeout(pr.expiry);
    privates.delete(pr.code);
    for (const p of [pr.host, pr.guest]) if (p?.priv === pr) p.priv = null;
    for (const p of notify) send(p.ws, { t: "private_closed", reason });
  };
  /** The host leaving closes the room; a guest leaving just frees the seat. */
  const leavePrivate = (s: Session, reason = "") => {
    const pr = s.priv;
    if (!pr) return;
    if (pr.host === s) return closePrivate(pr, reason || "The host closed the room.");
    pr.guest = null;
    s.priv = null;
    pushPrivate(pr);
  };
  const newCode = () => {
    for (;;) {
      let c = "";
      for (let i = 0; i < PRIVATE_CODE_LEN; i++) c += PRIVATE_CODE_ALPHABET[randomInt(PRIVATE_CODE_ALPHABET.length)];
      if (!privates.has(c)) return c;
    }
  };

  /** Checks a player can put `stake` up, then calls `ok`. Free servers have no funds to check. */
  const withFunds = (s: Session, ws: Conn, stake: string, ok: () => void) => {
    if (!chain) return ok();
    const wei = chain.stakeWei(stake);
    if (!s.auth || s.auth.maxStake < wei || s.auth.expiry * 1000 < Date.now() + 60_000) {
      send(ws, { t: "error", message: "Approve play with your wallet first (one signature, no gas)." });
      return void sendBankroll(s, true);
    }
    s.checking = true;
    chain
      .getBankroll(s.address!)
      .then((b) => {
        if (b.inMatch) throw new Error("You're already in a running match.");
        if (b.balance < wei) throw new Error(`Your balance is below the ${stake} ETH stake. Add funds first.`);
        if (s.queuedTier || s.room || s.starting || s.tVenue || s.tournament || s.priv || s.ws !== ws) return;
        ok();
      })
      .catch((e: Error) => send(ws, { t: "error", message: e.message.length < 120 ? e.message : "Couldn't check your balance." }))
      .finally(() => (s.checking = false));
  };

  const busy = (s: Session) => s.room || s.starting || s.queuedTier || s.checking || s.tVenue || s.tournament || s.priv;

  const startPrivate = (pr: PrivateRoom) => {
    const { host, guest } = pr;
    if (!guest) return;
    clearTimeout(pr.expiry);
    privates.delete(pr.code);
    host.priv = guest.priv = null;
    if (chain) void startStaked(host, guest, pr.stake, undefined, false);
    else startMatch(host, guest, pr.stake, undefined, undefined, false);
  };

  // ------------------------------------------------------------------ connections

  const rateTimer = setInterval(() => {
    for (const ws of wss.clients as Set<Conn>) ws.msgCount = 0;
  }, 1000);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<Conn>) {
      if (ws.alive === false) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 15_000);

  wss.on("connection", (ws: Conn) => {
    ws.alive = true;
    ws.msgCount = 0;
    ws.on("pong", () => (ws.alive = true));

    ws.on("message", (data) => {
      if (++ws.msgCount! > MAX_MSGS_PER_SEC) return ws.close(1008, "rate limit");
      const msg = parseClientMessage(data.toString());
      if (!msg) return send(ws, { t: "error", message: "bad message" });

      if (msg.t === "hello") {
        if (ws.session) return send(ws, { t: "error", message: "already said hello" });
        return onHello(ws, msg.name, msg.token, msg.guest);
      }
      const s = ws.session;
      if (!s) return send(ws, { t: "error", message: "send hello first" });

      switch (msg.t) {
        case "auth_request": {
          if (!chain) return send(ws, { t: "error", message: "wallet login is not enabled" });
          const message = `Sign in to 8-Ball Pool\n\nAddress: ${msg.address}\nNonce: ${randomBytes(16).toString("hex")}`;
          s.pendingAuth = { address: msg.address, message };
          return send(ws, { t: "auth_challenge", message });
        }
        case "auth": {
          const pending = s.pendingAuth;
          s.pendingAuth = null; // single use
          if (!chain || !pending || pending.address.toLowerCase() !== msg.address.toLowerCase()) {
            return send(ws, { t: "error", message: "no login in progress" });
          }
          chain
            .recoverLogin(pending.message, msg.signature)
            .then((signer) => {
              if (signer.toLowerCase() !== msg.address.toLowerCase()) throw new Error("signature mismatch");
              s.address = signer;
              s.key = walletKey(signer);
              s.pid = players.touch(s.key, s.name);
              const known = authsByAddress.get(signer.toLowerCase());
              if (known) s.auth = known;
              send(ws, { t: "authed", address: signer, pid: s.pid });
              for (const r of store.forAddress(signer)) void trySettle(r, true);
              return sendBankroll(s, true);
            })
            .catch(() => send(ws, { t: "error", message: "wallet signature rejected" }));
          return;
        }
        case "play_auth": {
          if (!chain || !s.address) return send(ws, { t: "error", message: "connect your wallet first" });
          const auth: PlayAuth = { maxStake: BigInt(msg.maxStake), expiry: msg.expiry, nonce: BigInt(msg.nonce), signature: msg.signature };
          const now = Date.now() / 1000;
          if (auth.expiry < now + 300 || auth.expiry > now + 7 * 86400) {
            return send(ws, { t: "error", message: "That authorization has a bad expiry. Try again." });
          }
          const address = s.address;
          Promise.all([chain.authNonce(address), chain.verifyPlayAuth(address, auth)])
            .then(([nonce, valid]) => {
              if (!valid || nonce !== auth.nonce) throw new Error("invalid");
              adoptAuth(s, auth);
              return sendBankroll(s);
            })
            .catch(() => send(ws, { t: "error", message: "That authorization signature isn't valid. Try again." }));
          return;
        }
        case "refresh":
          return void sendBankroll(s);
        case "queue": {
          if (s.room || s.starting) return send(ws, { t: "error", message: "already in a match" });
          if (s.queuedTier || s.checking || s.tVenue || s.tournament || s.priv) return send(ws, { t: "error", message: "already queued" });
          if (chain && !s.address) return send(ws, { t: "error", message: "connect your wallet first" });
          const q = queues.get(msg.tier);
          if (!q) return send(ws, { t: "error", message: "unknown stake tier" });
          const enqueue = () => {
            q.push(s);
            s.queuedTier = msg.tier;
            send(ws, { t: "queued", tier: msg.tier });
            tryMatch(msg.tier);
          };
          if (!chain) return enqueue();

          const stake = chain.stakeWei(msg.tier);
          if (!s.auth || s.auth.maxStake < stake || s.auth.expiry * 1000 < Date.now() + 60_000) {
            send(ws, { t: "error", message: "Approve play with your wallet first (one signature, no gas)." });
            return void sendBankroll(s, true);
          }
          s.checking = true;
          chain
            .getBankroll(s.address!)
            .then((b) => {
              if (b.inMatch) throw new Error("You're already in a running match.");
              if (b.balance < stake) throw new Error(`Your balance is below the ${msg.tier} ETH stake. Add funds first.`);
              if (s.queuedTier || s.room || s.starting || s.ws !== ws) return;
              enqueue();
            })
            .catch((e: Error) => send(ws, { t: "error", message: e.message.length < 120 ? e.message : "Couldn't check your balance." }))
            .finally(() => (s.checking = false));
          return;
        }
        case "tournament_join": {
          if (s.room || s.starting) return send(ws, { t: "error", message: "already in a match" });
          if (s.queuedTier || s.checking || s.tVenue || s.tournament || s.priv) return send(ws, { t: "error", message: "already queued" });
          const venue = venues.find((v) => v.id === msg.venue);
          if (!venue) return send(ws, { t: "error", message: "unknown venue" });
          if (chain && !s.address) return send(ws, { t: "error", message: "connect your wallet first" });
          const enqueue = () => {
            const q = tQueues.get(venue.id)!;
            q.push(s);
            s.tVenue = venue.id;
            q.forEach((p) => send(p.ws, { t: "tournament_lobby", venue: venue.id, joined: q.length, size: TOURNAMENT_SIZE }));
            tryTournament(venue);
          };
          if (!chain) return enqueue();

          const buyIn = chain.stakeWei(venue.buyIn);
          const finalStake = chain.stakeWei(doubled(venue.buyIn));
          if (!s.auth || s.auth.maxStake < finalStake || s.auth.expiry * 1000 < Date.now() + 60_000) {
            send(ws, { t: "error", message: "Approve play with your wallet first (one signature, no gas). Tournaments need a higher limit." });
            return void sendBankroll(s, true);
          }
          s.checking = true;
          chain
            .getBankroll(s.address!)
            .then((b) => {
              if (b.inMatch) throw new Error("You're already in a running match.");
              if (b.balance < buyIn) throw new Error(`Your balance is below the ${venue.buyIn} ETH buy-in. Add funds first.`);
              if (s.queuedTier || s.room || s.starting || s.tVenue || s.tournament || s.ws !== ws) return;
              enqueue();
            })
            .catch((e: Error) => send(ws, { t: "error", message: e.message.length < 120 ? e.message : "Couldn't check your balance." }))
            .finally(() => (s.checking = false));
          return;
        }
        case "tournament_leave":
          if (s.tournament) return send(ws, { t: "error", message: "The bracket is already drawn." });
          tDequeue(s);
          return send(ws, { t: "tournament_left" });
        case "leaderboard": {
          const mine = players.row(s.pid);
          const me = mine && mine.played > 0 ? mine : null;
          return send(ws, { t: "leaderboard", entries: players.leaderboard(), me, myRank: me ? players.rankOf(s.pid) : null });
        }
        case "profile":
          return send(ws, { t: "profile", pid: msg.pid, profile: players.profile(msg.pid, s.pid) });
        case "private_create": {
          if (busy(s)) return send(ws, { t: "error", message: "Finish what you're doing first." });
          if (chain && !s.address) return send(ws, { t: "error", message: "connect your wallet first" });
          let ok = false;
          try { ok = parseEther(msg.stake) >= parseEther(PRIVATE_MIN_STAKE) && parseEther(msg.stake) <= parseEther(privateMax); } catch { /* invalid */ }
          if (!ok) return send(ws, { t: "error", message: `Pick a stake between ${PRIVATE_MIN_STAKE} and ${privateMax} ETH.` });
          const stake = formatEther(parseEther(msg.stake));
          withFunds(s, ws, stake, () => {
            const code = newCode();
            const pr: PrivateRoom = { code, stake, host: s, guest: null, expiry: setTimeout(() => closePrivate(pr, "The room timed out."), PRIVATE_TTL_MS) };
            pr.expiry.unref?.();
            privates.set(code, pr);
            s.priv = pr;
            pushPrivate(pr);
          });
          return;
        }
        case "private_join": {
          const pr = privates.get(msg.code);
          if (pr && pr.host === s) return send(ws, { t: "error", message: "You can't join your own room." });
          if (busy(s)) return send(ws, { t: "error", message: "Finish what you're doing first." });
          if (!pr || pr.guest) return send(ws, { t: "error", message: pr ? "That room is already full." : "No room with that code. Check it and try again." });
          if (pr.host === s || (chain && s.address && pr.host.address && sameAddress(s.address, pr.host.address))) {
            return send(ws, { t: "error", message: "You can't join your own room." });
          }
          if (chain && !s.address) return send(ws, { t: "error", message: "connect your wallet first" });
          withFunds(s, ws, pr.stake, () => {
            if (privates.get(pr.code) !== pr || pr.guest) return send(ws, { t: "error", message: "That room just closed." });
            pr.guest = s;
            s.priv = pr;
            pushPrivate(pr);
            startPrivate(pr);
          });
          return;
        }
        case "private_cancel":
          return leavePrivate(s, "");
        case "leave_queue":
          dequeue(s);
          return send(ws, { t: "queue_left" });
        case "shot":
          if (!s.room) return send(ws, { t: "error", message: "not in a match" });
          return s.room.handleShot(s.seat, { angle: msg.angle, power: msg.power, spin: msg.spin, jump: msg.jump, placement: msg.placement });
        case "resign":
          if (!s.room) return send(ws, { t: "error", message: "not in a match" });
          return s.room.resign(s.seat);
        case "emote":
          if (!s.room) return send(ws, { t: "error", message: "not in a match" });
          return s.room.emote(s.seat, msg.id);
      }
    });

    ws.on("close", () => {
      const s = ws.session;
      if (!s || s.ws !== ws) return; // replaced by a newer connection
      s.ws = null;
      dequeue(s);
      tDequeue(s);
      leavePrivate(s, "The host left.");
      if (s.room) s.room.setConnected(s.seat, false);
      else if (!s.starting && !s.tournament) sessions.delete(s.token);
    });
  });

  function welcome(ws: Conn, s: Session, resumed: boolean) {
    send(ws, {
      t: "welcome", token: s.token, name: s.name, tiers: config.tiers, venues, resumed,
      chain: chain?.info, address: s.address ?? undefined, pid: s.pid,
    });
  }

  function onHello(ws: Conn, rawName: string | undefined, token: string | undefined, guest: string | undefined) {
    const existing = token ? sessions.get(token) : undefined;
    if (existing && (existing.room || existing.starting || existing.tournament)) {
      // Reconnect into a running match, one whose stakes are being locked, or a bracket between rounds.
      if (existing.ws && existing.ws !== ws) existing.ws.close(4000, "replaced");
      existing.ws = ws;
      ws.session = existing;
      welcome(ws, existing, !!(existing.room || existing.starting));
      void sendBankroll(existing);
      if (existing.room) {
        existing.room.setConnected(existing.seat, true);
        existing.room.resync(existing.seat);
      } else if (existing.starting) {
        send(ws, { t: "match_starting", tier: "", opponent: "" });
      }
      const t = existing.tournament;
      if (t) send(ws, { t: "tournament_state", ...viewFor(t, t.players.indexOf(existing)) });
      return;
    }
    const name = (rawName ?? "").replace(/[^\w .-]/g, "").trim().slice(0, 20) || `Player-${randomBytes(2).toString("hex")}`;
    const tok = randomUUID();
    const key = guestKey(guest ?? tok);
    const s: Session = { token: tok, key, pid: players.touch(key, name), priv: null, name, address: null, pendingAuth: null, ws, room: null, starting: false, checking: false, auth: null, seat: 0, queuedTier: null, tVenue: null, tournament: null };
    sessions.set(s.token, s);
    ws.session = s;
    welcome(ws, s, false);
  }

  return new Promise((resolve) => {
    http.listen(config.port, () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : config.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(rateTimer);
            clearInterval(heartbeat);
            clearInterval(retryTimer);
            for (const r of rooms.values()) r.dispose();
            for (const pr of privates.values()) clearTimeout(pr.expiry);
            players.flush();
            tournaments.clear();
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}
