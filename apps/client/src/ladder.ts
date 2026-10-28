import { RANKS, rankOf, rankProgress, type PlayerRow, type Profile, type ServerMessage } from "@8pool/shared";
import { sfx } from "./audio";
import { esc, pct, rankBadge, timeAgo } from "./rankui";

type Msg<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

export interface LadderHandlers {
  requestLeaderboard(): void;
  requestProfile(pid: string): void;
  /** The player's own profile (re)loaded, e.g. to show their rank in the top bar. */
  onMine(p: Profile | null): void;
}

const cell = (v: string, l: string) => `<div class="stat sk"><strong>${v}</strong><span>${l}</span></div>`;

/** Leaderboard screen (your rank card, tiers, top players) and the player profile popup. */
export class Ladder {
  private body = document.getElementById("statsBody")!;
  private modal = document.getElementById("profile")!;
  private card = this.modal.querySelector<HTMLElement>(".pf-card")!;
  private lb: Msg<"leaderboard"> | null = null;
  private myPid: string | null = null;
  private mine: Profile | null = null;
  private shown: string | null = null; // pid the popup is showing or waiting for

  constructor(private h: LadderHandlers) {
    this.modal.addEventListener("click", (e) => {
      if (e.target === this.modal || (e.target as HTMLElement).closest("[data-close]")) this.closeProfile();
    });
    this.card.addEventListener("click", (e) => {
      const pid = (e.target as HTMLElement).closest<HTMLElement>("[data-pid]")?.dataset.pid;
      if (pid) this.openProfile(pid);
    });
    this.body.addEventListener("click", (e) => {
      const pid = (e.target as HTMLElement).closest<HTMLElement>("[data-pid]")?.dataset.pid;
      if (pid) this.openProfile(pid);
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (this.modal.hidden || e.key !== "Escape") return;
        e.stopPropagation();
        e.preventDefault();
        this.closeProfile();
      },
      true,
    );
  }

  get profileOpen(): boolean { return !this.modal.hidden; }

  setMe(pid: string | null): void {
    this.myPid = pid;
    this.mine = null;
    if (pid) this.h.requestProfile(pid);
  }

  /** Called whenever the leaderboard screen is opened. */
  refresh(): void {
    this.render();
    this.h.requestLeaderboard();
    if (this.myPid) this.h.requestProfile(this.myPid);
  }

  onMessage(m: ServerMessage): void {
    if (m.t === "leaderboard") {
      this.lb = m;
      this.render();
    } else if (m.t === "profile") {
      if (m.pid === this.myPid) {
        this.mine = m.profile;
        this.render();
        this.h.onMine(m.profile);
      }
      if (m.pid === this.shown) this.renderProfile(m.profile);
    }
  }

  // ---------------------------------------------------------------- leaderboard

  private render(): void {
    const me = this.mine;
    const rating = me?.rating ?? this.lb?.me?.rating ?? 1000;
    const played = me?.played ?? this.lb?.me?.played ?? 0;
    const tier = rankOf(rating);
    const prog = rankProgress(rating);
    const next = RANKS[RANKS.indexOf(tier) + 1];

    const rankCard =
      `<div class="rank-card sk" style="--rc:${tier.color}">` +
      `<div class="rc-badge">${rankBadge(rating, 58)}</div>` +
      `<div class="rc-main"><small>${played ? "Your rank" : "Unranked"}</small><strong>${tier.name}</strong>` +
      `<div class="rc-bar"><i style="width:${Math.round(prog * 100)}%"></i></div>` +
      `<span>${next ? `${next.min - rating} to ${next.name}` : "Top tier"}</span></div>` +
      `<div class="rc-rating"><b>${rating}</b><small>${this.lb?.myRank ? `#${this.lb.myRank}` : "RATING"}</small></div>` +
      `</div>`;

    const lost = me?.lost ?? this.lb?.me?.lost ?? 0;
    const won = me?.won ?? this.lb?.me?.won ?? 0;
    const stats =
      `<div class="stats">${cell(String(played), "Matches")}${cell(String(won), "Wins")}${cell(String(lost), "Losses")}` +
      `${cell(pct(won, played), "Win rate")}${cell(String(me?.streak ?? 0), "Streak")}${cell(String(me?.best ?? 0), "Best streak")}</div>`;

    const strip =
      `<div class="tier-strip">` +
      RANKS.map((r) => `<span class="${r.id === tier.id ? "on" : ""}" style="--rc:${r.color}">${rankBadge(r.min || 1, 18)}<em>${r.name}</em><small>${r.min ? r.min + "+" : "0+"}</small></span>`).join("") +
      `</div>`;

    let list: string;
    if (!this.lb) list = `<p class="lead dim">Loading…</p>`;
    else if (!this.lb.entries.length) list = `<p class="lead dim">No ranked matches yet. Win one to take the first spot.</p>`;
    else {
      const rows = this.lb.entries.map((e, i) => this.row(e, i + 1, e.pid === this.myPid));
      if (this.lb.me && this.lb.myRank && this.lb.myRank > this.lb.entries.length) rows.push(`<div class="lrow-gap">⋯</div>`, this.row(this.lb.me, this.lb.myRank, true));
      list = rows.join("");
    }
    this.body.innerHTML =
      rankCard + stats + strip +
      `<div class="lb-head"><span>#</span><span>Player</span><span>Rating</span><span>W–L</span><span>Win%</span></div><div class="lb">${list}</div>`;
  }

  private row(e: PlayerRow, rank: number, me: boolean): string {
    return (
      `<button class="lrow sk${me ? " me" : ""}${rank <= 3 ? ` top${rank}` : ""}" data-pid="${e.pid}">` +
      `<span class="lr-n">${rank}</span><span class="lr-name">${rankBadge(e.rating, 20)}<b>${esc(e.name)}</b></span>` +
      `<span class="lr-r">${e.rating}</span><span class="lr-wl">${e.won}–${e.lost}</span><span class="lr-p">${pct(e.won, e.played)}</span></button>`
    );
  }

  // ---------------------------------------------------------------- profile popup

  openProfile(pid: string): void {
    sfx.ui();
    this.shown = pid;
    this.card.innerHTML = `<button class="pf-x icon-btn" data-close aria-label="Close">&#10005;</button><p class="lead dim">Loading…</p>`;
    this.modal.hidden = false;
    this.h.requestProfile(pid);
    this.card.querySelector<HTMLElement>("[data-close]")?.focus();
  }

  closeProfile(): void {
    this.modal.hidden = true;
    this.shown = null;
  }

  private renderProfile(p: Profile | null): void {
    if (!p) {
      this.card.innerHTML = `<button class="pf-x icon-btn" data-close aria-label="Close">&#10005;</button><p class="lead dim">This player has no record yet.</p>`;
      return;
    }
    const tier = rankOf(p.rating);
    const isMe = p.pid === this.myPid;
    const vs = p.vsYou && p.vsYou.won + p.vsYou.lost > 0 ? p.vsYou : null;
    const recent = p.recent.length
      ? p.recent
          .map(
            (r) =>
              `<button class="rec sk ${r.won ? "w" : "l"}" data-pid="${r.oppPid}"><b>${r.won ? "W" : "L"}</b><span>vs ${esc(r.opp)}</span>` +
              `<em>${r.ranked ? (r.delta > 0 ? "+" : "") + r.delta : "friendly"}</em><small>${timeAgo(r.at)}</small></button>`,
          )
          .join("")
      : `<p class="lead dim">No matches yet.</p>`;
    this.card.innerHTML =
      `<button class="pf-x icon-btn" data-close aria-label="Close">&#10005;</button>` +
      `<header class="pf-head" style="--rc:${tier.color}">${rankBadge(p.rating, 56)}<div><strong>${esc(p.name)}</strong>` +
      `<span>${isMe ? "You · " : ""}${tier.name} · ${p.rating}${p.rank ? ` · #${p.rank}` : ""}</span></div></header>` +
      (vs
        ? `<div class="h2h sk"><span>You vs ${esc(p.name)}</span><b><i class="${vs.won >= vs.lost ? "up" : ""}">${vs.won}</i> – <i class="${vs.lost > vs.won ? "up" : ""}">${vs.lost}</i></b></div>`
        : "") +
      `<div class="stats">${cell(String(p.played), "Matches")}${cell(String(p.won), "Wins")}${cell(String(p.lost), "Losses")}` +
      `${cell(pct(p.won, p.played), "Win rate")}${cell(String(p.streak), "Streak")}${cell(String(p.peak), "Peak")}</div>` +
      `<h3 class="pf-h">Recent matches</h3><div class="recent">${recent}</div>`;
  }
}
