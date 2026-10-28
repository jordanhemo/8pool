/** Elo-style ranking shared by the server (which applies it) and the client (which shows tiers). */

export const START_RATING = 1000;
/** Matches played while a rating is still settling; ratings move faster during these. */
export const PLACEMENT_GAMES = 10;

export interface RankTier {
  id: string;
  name: string;
  /** Lowest rating in this tier. */
  min: number;
  color: string;
}

export const RANKS: readonly RankTier[] = [
  { id: "bronze", name: "Bronze", min: 0, color: "#cd8b4a" },
  { id: "silver", name: "Silver", min: 1000, color: "#c3ccd8" },
  { id: "gold", name: "Gold", min: 1200, color: "#f6c453" },
  { id: "platinum", name: "Platinum", min: 1400, color: "#4fe0c4" },
  { id: "diamond", name: "Diamond", min: 1600, color: "#6fc3ff" },
  { id: "master", name: "Master", min: 1800, color: "#c78bff" },
];

export function rankOf(rating: number): RankTier {
  let r = RANKS[0];
  for (const t of RANKS) if (rating >= t.min) r = t;
  return r;
}

/** Progress through the current tier, 0..1 (1 at the top tier). */
export function rankProgress(rating: number): number {
  const i = RANKS.indexOf(rankOf(rating));
  const next = RANKS[i + 1];
  return next ? (rating - RANKS[i].min) / (next.min - RANKS[i].min) : 1;
}

const kFactor = (games: number) => (games < PLACEMENT_GAMES ? 40 : 24);

/** Rating changes for a decided match. The loser can never gain and the winner can never lose. */
export function eloDeltas(winner: { rating: number; games: number }, loser: { rating: number; games: number }): { winner: number; loser: number } {
  const expected = 1 / (1 + 10 ** ((loser.rating - winner.rating) / 400));
  const w = Math.max(1, Math.round(kFactor(winner.games) * (1 - expected)));
  const l = Math.max(1, Math.round(kFactor(loser.games) * (1 - expected)));
  return { winner: w, loser: -Math.min(l, loser.rating) };
}
