import type { ShotEvents, Spin } from "./physics";
import type { GameState } from "./rules";
import { PRIVATE_CODE_LEN, isStakeString, normalizeCode } from "./tournament";
import type { TournamentRound, TournamentView, Venue } from "./tournament";

export type Seat = 0 | 1;

export interface WireShot {
  angle: number;
  power: number;
  spin?: Spin;
  jump?: boolean;
  placement?: { x: number; y: number };
}

/** Preset quick-chat messages. Free text is deliberately not supported. */
export const EMOTES = ["gg", "nice", "oops", "wow", "thanks", "hurry"] as const;
export type EmoteId = (typeof EMOTES)[number];
export const isEmote = (v: unknown): v is EmoteId => typeof v === "string" && (EMOTES as readonly string[]).includes(v);

/** One row of the leaderboard. `pid` is a public id: it never reveals a wallet address or a session token. */
export interface PlayerRow {
  pid: string;
  name: string;
  rating: number;
  played: number;
  won: number;
  lost: number;
}

export interface RecentMatch {
  opp: string;
  oppPid: string;
  won: boolean;
  /** Rating change; 0 for unranked (private) matches. */
  delta: number;
  at: number;
  tier: string;
  ranked: boolean;
}

export interface Profile extends PlayerRow {
  peak: number;
  streak: number;
  best: number;
  /** Leaderboard position, or null before the first ranked match. */
  rank: number | null;
  recent: RecentMatch[];
  /** The viewer's record against this player. */
  vsYou?: { won: number; lost: number };
}

export type ClientMessage =
  | { t: "hello"; name?: string; token?: string; guest?: string }
  | { t: "queue"; tier: string }
  | { t: "leave_queue" }
  | ({ t: "shot" } & WireShot)
  | { t: "resign" }
  | { t: "emote"; id: EmoteId }
  | { t: "tournament_join"; venue: string }
  | { t: "tournament_leave" }
  | { t: "leaderboard" }
  | { t: "profile"; pid: string }
  | { t: "private_create"; stake: string }
  | { t: "private_join"; code: string }
  | { t: "private_cancel" }
  | { t: "auth_request"; address: string }
  | { t: "auth"; address: string; signature: string }
  /** The player's EIP-712 `Play` signature: the server may lock up to `maxStake` per match until `expiry`. */
  | { t: "play_auth"; maxStake: string; expiry: number; nonce: string; signature: string }
  /** Ask for a fresh `bankroll` message (after a deposit or withdrawal). */
  | { t: "refresh" };

export interface ShotReport {
  frames: number[][];
  pocketFrames: Record<number, number>;
  events: ShotEvents;
  /** Frames the cue ball spends airborne on a jump shot. */
  air?: number;
}

export interface TurnTiming {
  /** Epoch ms when the current shooter's clock runs out. */
  turnDeadline: number;
  /** Server clock at send time, so clients can correct for skew. */
  serverNow: number;
}

/** Present when the server runs staked matches against a PoolBank contract. */
export interface ChainInfo {
  chainId: number;
  bank: string;
  rpcUrl: string;
}

export type ServerMessage =
  | { t: "welcome"; token: string; name: string; tiers: string[]; venues?: Venue[]; resumed: boolean; chain?: ChainInfo; address?: string; pid?: string }
  | { t: "auth_challenge"; message: string }
  | { t: "authed"; address: string; pid?: string }
  | { t: "leaderboard"; entries: PlayerRow[]; me: PlayerRow | null; myRank: number | null }
  | { t: "profile"; pid: string; profile: Profile | null }
  /** A private room the player is in: the host waits, the match starts when a friend joins. */
  | { t: "private_state"; code: string; stake: string; host: string; guest: string | null; you: "host" | "guest" }
  | { t: "private_closed"; reason: string }
  /** Rating after a finished match. `ranked` is false for private rooms, where nothing changes. */
  | { t: "rating"; won: boolean; delta: number; rating: number; ranked: boolean }
  /** Wallet balance held in the bank contract, plus whether a valid play authorization is on file. */
  | { t: "bankroll"; balanceWei: string; inMatch: boolean; authorized: boolean; authExpiry?: number; maxStakeWei?: string }
  /** Sign this once (typed data `Play`) so matches can start without a wallet popup. */
  | { t: "play_auth_request"; maxStakeWei: string; expiry: number; nonce: string }
  /** Both players are matched; the server is locking the stakes on-chain. */
  | { t: "match_starting"; tier: string; opponent: string }
  | { t: "match_failed"; reason: string }
  /**
   * Outcome of a staked match. `settled`: the winner's balance was already credited on-chain.
   * Otherwise `signature` lets the winner (or anyone) submit it to `settle` as a fallback.
   * winner is the zero address for a void (both stakes returned).
   */
  | { t: "result"; bankMatchId: string; winner: string; reason: string; settled: boolean; signature?: string; txHash?: string }
  /** Waiting in a venue's lobby for the bracket to fill. */
  | { t: "tournament_lobby"; venue: string; joined: number; size: number }
  | ({ t: "tournament_state" } & TournamentView)
  | { t: "tournament_failed"; reason: string }
  | { t: "tournament_left" }
  | { t: "queued"; tier: string }
  | { t: "queue_left" }
  | ({
      t: "match_start";
      matchId: string;
      seat: Seat;
      names: [string, string];
      tier: string;
      state: GameState;
      resumed: boolean;
      tournament?: { id: string; round: TournamentRound };
      /** Public ids and ratings of both players, so the HUD can show ranks and open profiles. */
      players?: [{ pid: string; rating: number }, { pid: string; rating: number }];
      ranked?: boolean;
    } & TurnTiming)
  | ({ t: "shot_result"; matchId: string; seat: Seat; shot: WireShot; report: ShotReport; state: GameState } & TurnTiming)
  | ({ t: "state"; matchId: string; state: GameState; reason: string } & TurnTiming)
  | { t: "opponent_status"; connected: boolean; graceDeadline?: number }
  | { t: "emote"; seat: Seat; id: EmoteId }
  | { t: "game_over"; matchId: string; winner: Seat; reason: string; state: GameState }
  | { t: "error"; message: string };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130,200}$/;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Parse and validate untrusted client input. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  switch (m.t) {
    case "hello":
      if (m.name !== undefined && (typeof m.name !== "string" || m.name.length > 64)) return null;
      if (m.token !== undefined && (typeof m.token !== "string" || m.token.length > 128)) return null;
      if (m.guest !== undefined && (typeof m.guest !== "string" || !/^[\w-]{8,64}$/.test(m.guest))) return null;
      return { t: "hello", name: m.name, token: m.token, guest: m.guest };
    case "queue":
      return typeof m.tier === "string" && m.tier.length <= 32 ? { t: "queue", tier: m.tier } : null;
    case "auth_request":
      return typeof m.address === "string" && ADDRESS_RE.test(m.address) ? { t: "auth_request", address: m.address } : null;
    case "auth":
      return typeof m.address === "string" && ADDRESS_RE.test(m.address) && typeof m.signature === "string" && SIGNATURE_RE.test(m.signature)
        ? { t: "auth", address: m.address, signature: m.signature }
        : null;
    case "play_auth":
      return typeof m.maxStake === "string" && /^\d{1,40}$/.test(m.maxStake) && isNum(m.expiry) &&
        typeof m.nonce === "string" && /^\d{1,40}$/.test(m.nonce) &&
        typeof m.signature === "string" && SIGNATURE_RE.test(m.signature)
        ? { t: "play_auth", maxStake: m.maxStake, expiry: m.expiry, nonce: m.nonce, signature: m.signature }
        : null;
    case "refresh":
      return { t: "refresh" };
    case "leave_queue":
      return { t: "leave_queue" };
    case "resign":
      return { t: "resign" };
    case "tournament_join":
      return typeof m.venue === "string" && m.venue.length <= 32 ? { t: "tournament_join", venue: m.venue } : null;
    case "tournament_leave":
      return { t: "tournament_leave" };
    case "leaderboard":
      return { t: "leaderboard" };
    case "profile":
      return typeof m.pid === "string" && /^[0-9a-f]{12}$/.test(m.pid) ? { t: "profile", pid: m.pid } : null;
    case "private_create":
      return isStakeString(m.stake) ? { t: "private_create", stake: m.stake } : null;
    case "private_join": {
      const code = typeof m.code === "string" ? normalizeCode(m.code) : "";
      return code.length === PRIVATE_CODE_LEN ? { t: "private_join", code } : null;
    }
    case "private_cancel":
      return { t: "private_cancel" };
    case "emote":
      return isEmote(m.id) ? { t: "emote", id: m.id } : null;
    case "shot": {
      if (!isNum(m.angle) || !isNum(m.power)) return null;
      let placement: WireShot["placement"];
      if (m.placement !== undefined) {
        if (typeof m.placement !== "object" || m.placement === null || !isNum(m.placement.x) || !isNum(m.placement.y)) return null;
        placement = { x: m.placement.x, y: m.placement.y };
      }
      let spin: WireShot["spin"];
      if (m.spin !== undefined) {
        if (typeof m.spin !== "object" || m.spin === null || !isNum(m.spin.x) || !isNum(m.spin.y) || Math.hypot(m.spin.x, m.spin.y) > 1.0001) return null;
        spin = { x: m.spin.x, y: m.spin.y };
      }
      if (m.jump !== undefined && typeof m.jump !== "boolean") return null;
      return { t: "shot", angle: m.angle, power: m.power, spin, jump: m.jump === true ? true : undefined, placement };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- EIP-712 play authorization

/** Domain of the PoolBank contract; the same object is used to sign (client) and verify (server). */
export const bankDomain = (info: Pick<ChainInfo, "chainId" | "bank">) => ({
  name: "PoolBank",
  version: "1",
  chainId: info.chainId,
  verifyingContract: info.bank as `0x${string}`,
});

export const PLAY_TYPES = {
  Play: [
    { name: "player", type: "address" },
    { name: "maxStake", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const RESULT_TYPES = {
  Result: [
    { name: "matchId", type: "bytes32" },
    { name: "winner", type: "address" },
  ],
} as const;
