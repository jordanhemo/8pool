import { rankOf, rankProgress, RANKS } from "@8pool/shared";

/** Shield in the tier's colour: the rank symbol used in the leaderboard, profiles and the match HUD. */
export function rankBadge(rating: number, size = 28): string {
  const t = rankOf(rating);
  const n = RANKS.indexOf(t) + 1;
  return (
    `<span class="rbadge" style="--rc:${t.color};width:${size}px;height:${Math.round(size * 1.12)}px;font-size:${Math.round(size * 0.5)}px" title="${t.name}">` +
    `<svg viewBox="0 0 24 27"><path d="M12 1 22 4.5v8.6c0 6-4.2 10.4-10 12.9C6.2 23.500 2 19.100 2 13.100V4.500L12 1Z"/></svg><b>${n}</b></span>`
  );
}

export const rankName = (rating: number): string => rankOf(rating).name;
export { rankProgress };

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const pct = (won: number, played: number): string => (played ? `${Math.round((won / played) * 100)}%` : "–");

/** Escape text for innerHTML (names come from other players). */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
