const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);

import type { Venue } from "@8pool/shared";

export interface Config {
  port: number;
  /** Stake tier labels offered in the lobby. Amounts are enforced on-chain later. */
  tiers: string[];
  /** Tournament venues (defaults to the shared list). */
  venues?: Venue[];
  /** How often to re-check that finalists' semifinal stakes were released on-chain. */
  tournamentPollMs?: number;
  shotClockMs: number;
  graceMs: number;
  /** Consecutive shot-clock timeouts before a player forfeits. */
  maxTimeouts: number;
  /** How often unsettled results are retried (staked mode). */
  settleRetryMs?: number;
  /** How long a play authorization the server asks players to sign stays valid. */
  authTtlMs?: number;
  /** Browser origins allowed to open a WebSocket. Empty allows any (local development). */
  allowedOrigins?: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8080),
    tiers: (env.TIERS ?? "0.001,0.01").split(",").map((s) => s.trim()).filter(Boolean),
    shotClockMs: num(env.SHOT_CLOCK_MS, 45_000),
    graceMs: num(env.GRACE_MS, 60_000),
    maxTimeouts: num(env.MAX_TIMEOUTS, 3),
    settleRetryMs: num(env.SETTLE_RETRY_MS, 30_000),
    authTtlMs: num(env.AUTH_TTL_MS, 24 * 3600_000),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
  };
}
