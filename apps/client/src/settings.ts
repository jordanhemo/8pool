const VIEW_KEY = "8pool.view3d";
const QUALITY_KEY = "8pool.quality";
const STATS_KEY = "8pool.stats";

const read = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const write = (k: string, v: string): void => {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable */ }
};

export type Quality = "high" | "low";

export const prefs = {
  view3d: (): boolean => read(VIEW_KEY) !== "0",
  setView3d: (on: boolean): void => write(VIEW_KEY, on ? "1" : "0"),
  quality: (): Quality => (read(QUALITY_KEY) === "low" ? "low" : "high"),
  setQuality: (q: Quality): void => write(QUALITY_KEY, q),
};

export interface Stats {
  played: number;
  won: number;
  streak: number;
  best: number;
}

export function loadStats(): Stats {
  try {
    const s = JSON.parse(read(STATS_KEY) ?? "null") as Partial<Stats> | null;
    return { played: s?.played ?? 0, won: s?.won ?? 0, streak: s?.streak ?? 0, best: s?.best ?? 0 };
  } catch {
    return { played: 0, won: 0, streak: 0, best: 0 };
  }
}

/** Record a finished online match for the local stats screen. */
export function recordMatch(won: boolean): void {
  const s = loadStats();
  s.played += 1;
  s.won += won ? 1 : 0;
  s.streak = won ? s.streak + 1 : 0;
  s.best = Math.max(s.best, s.streak);
  write(STATS_KEY, JSON.stringify(s));
}
