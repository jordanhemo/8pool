import { EmoteId, FRAME_RATE, GameState, Seat, ServerMessage, ShotReport, ShotResult, TournamentRound, WireShot, newGame, takeShot } from "@8pool/shared";

export interface RoomOptions {
  shotClockMs: number;
  graceMs: number;
  maxTimeouts: number;
  seed: number;
}

export interface RoomResult {
  matchId: string;
  tier: string;
  names: [string, string];
  winner: Seat;
  reason: string;
}

const EMOTE_GAP_MS = 1500;
const MAX_EMOTES = 20; // per player per match

const other = (s: Seat): Seat => (s === 0 ? 1 : 0);

/**
 * One match. Knows nothing about sockets: it pushes messages through `send` and reports
 * the outcome through `onEnd`. The server layer owns connections.
 */
export class Room {
  game: GameState;
  ended = false;

  private deadline = 0;
  private lockUntil = 0; // shots are refused while the previous shot is still animating
  private turnTimer: NodeJS.Timeout | null = null;
  private graceTimers: [NodeJS.Timeout | null, NodeJS.Timeout | null] = [null, null];
  private connected: [boolean, boolean] = [true, true];
  private timeouts: [number, number] = [0, 0];
  private graceDeadlines: [number, number] = [0, 0];
  private lastEmote: [number, number] = [0, 0];
  private emoteCount: [number, number] = [0, 0];

  constructor(
    readonly id: string,
    readonly tier: string,
    readonly names: [string, string],
    private send: (seat: Seat, msg: ServerMessage) => void,
    private onEnd: (r: RoomResult) => void,
    private opts: RoomOptions,
    private tournament?: { id: string; round: TournamentRound },
    private extra?: Pick<Extract<ServerMessage, { t: "match_start" }>, "players" | "ranked">,
  ) {
    this.game = newGame(opts.seed);
  }

  start(): void {
    this.armTurnTimer(0);
    for (const seat of [0, 1] as const) this.sendMatchState(seat, false);
  }

  /** Full snapshot for a (re)connecting player. */
  resync(seat: Seat): void {
    if (this.ended) return;
    this.sendMatchState(seat, true);
    if (!this.connected[other(seat)]) {
      this.send(seat, { t: "opponent_status", connected: false, graceDeadline: this.graceDeadlines[other(seat)] });
    }
  }

  handleShot(seat: Seat, shot: WireShot): void {
    if (this.ended) return this.send(seat, { t: "error", message: "match is over" });
    if (seat !== this.game.current) return this.send(seat, { t: "error", message: "not your turn" });
    if (Date.now() < this.lockUntil) return this.send(seat, { t: "error", message: "wait for the shot to finish" });

    let out;
    try {
      out = takeShot(this.game, shot);
    } catch (e) {
      return this.send(seat, { t: "error", message: (e as Error).message });
    }

    this.timeouts[seat] = 0;
    this.game = out.game;
    const animMs = (out.result.frames.length / FRAME_RATE) * 1000;
    this.lockUntil = Date.now() + animMs;

    const shotMsg = (): ServerMessage => ({
      ...this.timing(),
      t: "shot_result",
      matchId: this.id,
      seat,
      shot,
      report: this.report(out.result),
      state: this.game,
    });

    if (this.game.winner !== null) {
      this.clearTurnTimer();
      this.broadcast(shotMsg);
      return this.finish(this.game.winner, this.game.endReason ?? "game over");
    }
    this.armTurnTimer(animMs);
    this.broadcast(shotMsg);
  }

  /** Quick-chat preset. Rate limited per player so it can't be used to spam the opponent. */
  emote(seat: Seat, id: EmoteId): void {
    if (this.ended) return;
    const now = Date.now();
    if (now - this.lastEmote[seat] < EMOTE_GAP_MS || this.emoteCount[seat] >= MAX_EMOTES) {
      return this.send(seat, { t: "error", message: "slow down" });
    }
    this.lastEmote[seat] = now;
    this.emoteCount[seat]++;
    this.broadcast(() => ({ t: "emote", seat, id }));
  }

  resign(seat: Seat): void {
    if (!this.ended) this.finish(other(seat), `${this.names[seat]} resigned`);
  }

  setConnected(seat: Seat, connected: boolean): void {
    if (this.ended || this.connected[seat] === connected) return;
    this.connected[seat] = connected;
    const timer = this.graceTimers[seat];
    if (timer) clearTimeout(timer);
    this.graceTimers[seat] = null;

    if (connected) {
      this.send(other(seat), { t: "opponent_status", connected: true });
      return;
    }
    const graceDeadline = (this.graceDeadlines[seat] = Date.now() + this.opts.graceMs);
    this.graceTimers[seat] = setTimeout(
      () => this.finish(other(seat), `${this.names[seat]} disconnected`),
      this.opts.graceMs,
    );
    this.send(other(seat), { t: "opponent_status", connected: false, graceDeadline });
  }

  dispose(): void {
    this.clearTurnTimer();
    for (const t of this.graceTimers) if (t) clearTimeout(t);
  }

  // ------------------------------------------------------------------ internals

  private timing() {
    return { turnDeadline: this.deadline, serverNow: Date.now() };
  }

  private report(r: ShotResult): ShotReport {
    return { frames: r.frames, pocketFrames: r.pocketFrames, events: r.events };
  }

  private sendMatchState(seat: Seat, resumed: boolean): void {
    this.send(seat, {
      ...this.timing(),
      t: "match_start",
      matchId: this.id,
      seat,
      names: this.names,
      tier: this.tier,
      state: this.game,
      resumed,
      tournament: this.tournament,
      ...this.extra,
    });
  }

  private broadcast(make: () => ServerMessage): void {
    this.send(0, make());
    this.send(1, make());
  }

  private armTurnTimer(extraMs: number): void {
    this.clearTurnTimer();
    const ms = this.opts.shotClockMs + extraMs;
    this.deadline = Date.now() + ms;
    this.turnTimer = setTimeout(() => this.onShotClock(), ms);
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  private onShotClock(): void {
    if (this.ended) return;
    const seat = this.game.current;
    this.timeouts[seat]++;
    if (this.timeouts[seat] >= this.opts.maxTimeouts) {
      return this.finish(other(seat), `${this.names[seat]} ran out of time`);
    }
    // Penalty: the turn passes and the opponent gets ball in hand.
    this.game = { ...this.game, current: other(seat), ballInHand: true };
    this.lockUntil = 0;
    this.armTurnTimer(0);
    this.broadcast(() => ({
      ...this.timing(),
      t: "state",
      matchId: this.id,
      state: this.game,
      reason: `${this.names[seat]} ran out of time`,
    }));
  }

  private finish(winner: Seat, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.dispose();
    this.broadcast(() => ({ t: "game_over", matchId: this.id, winner, reason, state: this.game }));
    this.onEnd({ matchId: this.id, tier: this.tier, names: this.names, winner, reason });
  }
}
