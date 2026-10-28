import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PlayerRow, Profile, RecentMatch, START_RATING, eloDeltas } from "@8pool/shared";

interface PlayerRec {
  pid: string;
  name: string;
  rating: number;
  peak: number;
  played: number;
  won: number;
  lost: number;
  streak: number;
  best: number;
  /** Record against each opponent pid: [wins, losses]. */
  h2h: Record<string, [number, number]>;
  recent: RecentMatch[];
}

const MAX_RECENT = 10;
const MAX_H2H = 100;
export const LEADERBOARD_SIZE = 50;

/** Public id for a player key. One-way, so the leaderboard never exposes a wallet address or guest id. */
export const pidOf = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 12);
export const walletKey = (address: string): string => `addr:${address.toLowerCase()}`;
export const guestKey = (id: string): string => `guest:${id}`;

const row = (p: PlayerRec): PlayerRow => ({ pid: p.pid, name: p.name, rating: p.rating, played: p.played, won: p.won, lost: p.lost });

/**
 * Ratings, records and match history. Wallet players are keyed by address, everyone else by a guest id the
 * browser keeps. Persisted to a JSON file (written a moment after each change) so a restart keeps the ladder.
 */
export class PlayerStore {
  private players = new Map<string, PlayerRec>(); // by pid
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      try {
        for (const p of JSON.parse(readFileSync(file, "utf8")) as PlayerRec[]) this.players.set(p.pid, p);
      } catch {
        this.players.clear();
      }
    }
  }

  /** Make sure the player exists and carries their latest display name. */
  touch(key: string, name: string): string {
    const pid = pidOf(key);
    const p = this.players.get(pid);
    if (!p) {
      this.players.set(pid, { pid, name, rating: START_RATING, peak: START_RATING, played: 0, won: 0, lost: 0, streak: 0, best: 0, h2h: {}, recent: [] });
      // Not saved yet: players only reach the file once they've finished a match.
    } else if (p.name !== name) {
      p.name = name;
      if (p.played || p.recent.length) this.save();
    }
    return pid;
  }

  rating(pid: string): number {
    return this.players.get(pid)?.rating ?? START_RATING;
  }

  /** Apply a decided match. Returns each side's change, or null if it can't be rated. */
  record(winnerPid: string, loserPid: string, tier: string, ranked: boolean): { winner: number; loser: number; ratings: [number, number] } | null {
    const w = this.players.get(winnerPid), l = this.players.get(loserPid);
    if (!w || !l || w === l) return null;
    const d = ranked ? eloDeltas({ rating: w.rating, games: w.played }, { rating: l.rating, games: l.played }) : { winner: 0, loser: 0 };
    const at = Date.now();
    for (const [me, opp, won, delta] of [[w, l, true, d.winner], [l, w, false, d.loser]] as const) {
      // Friendly (private) matches only feed head-to-head and history; they never touch the ladder.
      if (ranked) {
        me.played++;
        if (won) me.won++; else me.lost++;
        me.streak = won ? me.streak + 1 : 0;
        me.best = Math.max(me.best, me.streak);
        me.rating += delta;
        me.peak = Math.max(me.peak, me.rating);
      }
      const rec = (me.h2h[opp.pid] ??= [0, 0]);
      rec[won ? 0 : 1]++;
      me.recent.unshift({ opp: opp.name, oppPid: opp.pid, won, delta, at, tier, ranked });
      me.recent.length = Math.min(me.recent.length, MAX_RECENT);
      const keys = Object.keys(me.h2h);
      if (keys.length > MAX_H2H) {
        // Drop the least-played rivals first.
        keys.sort((a, b) => me.h2h[a][0] + me.h2h[a][1] - (me.h2h[b][0] + me.h2h[b][1]));
        for (const k of keys.slice(0, keys.length - MAX_H2H)) delete me.h2h[k];
      }
    }
    this.save();
    return { ...d, ratings: [w.rating, l.rating] };
  }

  private ranked(): PlayerRec[] {
    return [...this.players.values()]
      .filter((p) => p.played > 0)
      .sort((a, b) => b.rating - a.rating || b.won - a.won || a.played - b.played || a.pid.localeCompare(b.pid));
  }

  rankOf(pid: string): number | null {
    const i = this.ranked().findIndex((p) => p.pid === pid);
    return i < 0 ? null : i + 1;
  }

  leaderboard(limit = LEADERBOARD_SIZE): PlayerRow[] {
    return this.ranked().slice(0, limit).map(row);
  }

  row(pid: string): PlayerRow | null {
    const p = this.players.get(pid);
    return p ? row(p) : null;
  }

  profile(pid: string, viewerPid?: string): Profile | null {
    const p = this.players.get(pid);
    if (!p) return null;
    const vs = viewerPid && viewerPid !== pid ? this.players.get(viewerPid)?.h2h[pid] : undefined;
    return {
      ...row(p),
      peak: p.peak,
      streak: p.streak,
      best: p.best,
      rank: this.rankOf(pid),
      recent: p.recent,
      vsYou: vs ? { won: vs[0], lost: vs[1] } : undefined,
    };
  }

  /** Write any pending change now (called on shutdown). */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.write();
  }

  private save(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.write();
    }, 500);
    this.saveTimer.unref?.();
  }

  private write(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.players.values()].filter((p) => p.played > 0 || p.recent.length > 0)));
    renameSync(tmp, this.file);
  }
}
