/** A tournament venue: a table with its own buy-in. Ids match the client's room themes. */
export interface Venue {
  id: string;
  name: string;
  /** Each player's buy-in in ETH. */
  buyIn: string;
}

/** Knockout size: two semifinals, then a final. */
export const TOURNAMENT_SIZE = 4;

/** Ascending buy-ins: the fancier the venue, the bigger the pot. */
export const VENUES: Venue[] = [
  { id: "local", name: "Local Bar", buyIn: "0.001" },
  { id: "vegas", name: "Las Vegas", buyIn: "0.005" },
  { id: "dubai", name: "Dubai", buyIn: "0.01" },
  { id: "hawaii", name: "Hawaii", buyIn: "0.025" },
  { id: "space", name: "Space Station", buyIn: "0.05" },
];

export type TournamentRound = "semis" | "final";

/**
 * What a player sees of their bracket. Slots 0-1 play the first semifinal, 2-3 the second.
 * Each semifinal stakes the buy-in; the final stakes double, because winners carry their winnings forward,
 * so the champion collects the full pot (`TOURNAMENT_SIZE` buy-ins).
 */
export interface TournamentView {
  id: string;
  venue: string;
  buyIn: string;
  finalStake: string;
  pot: string;
  stage: TournamentRound | "done";
  slots: [string, string, string, string];
  /** Slot index of each semifinal's winner, once decided. */
  semiWinners: [number | null, number | null];
  champion: number | null;
  /** The viewing player's slot. */
  you: number;
  note?: string;
}
