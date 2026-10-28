import { EMOTES, type EmoteId, type GameState } from "@8pool/shared";
import { colorOf, cssColor } from "./game3d/textures";
import { rankBadge, rankName } from "./rankui";
import { isMusicMuted, isSfxMuted, setMusicMuted, setSfxMuted, sfx } from "./audio";

export interface HudHandlers {
  onPowerStart(): void;
  onPower(p: number): void;
  onPowerEnd(p: number): void;
  onToggleView(): void;
  onReplay(): void;
  onSpin(x: number, y: number): void;
  onEmote(id: EmoteId): void;
  /** Called after the player confirmed leaving or resigning. */
  onLeave(): void;
}

export interface OverOptions {
  title: string;
  sub: string;
  tone: "win" | "lose" | "neutral";
  primary: { label: string; run: () => void };
  secondary?: { label: string; run: () => void };
}

const EMOTE_TEXT: Record<EmoteId, string> = {
  gg: "Good game!", nice: "Nice shot!", oops: "Oops!", wow: "Wow!", thanks: "Thanks!", hurry: "Your turn…",
};

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => root.querySelector<T>(sel)!;

/** In-match overlay: player cards, turn clock, power slider, menu and result modal. */
export class Hud {
  private el = document.getElementById("hud")!;
  private cards = [q(this.el, '.pcard[data-seat="0"]'), q(this.el, '.pcard[data-seat="1"]')];
  private pot = q(this.el, "#potBadge");
  private msg = q(this.el, "#hudMsg");
  private banner = q(this.el, "#banner");
  private hint = q(this.el, "#hint");
  private power = q(this.el, "#power");
  private track = q(this.el, ".power-track");
  private fill = q(this.el, ".power-fill");
  private knob = q(this.el, ".power-knob");
  private powerPct = q(this.el, "#powerPct");
  private spring = q(this.el, ".power-spring");
  private springing = false;
  private springRaf = 0;
  private viewBtn = q<HTMLButtonElement>(this.el, "#viewBtn");
  private replayBtn = q<HTMLButtonElement>(this.el, "#replayBtn");
  private spinEl = q(this.el, "#spin");
  private spinBall = q(this.el, ".spin-ball");
  private spinDot = q(this.el, "#spinDot");
  private emoteBtn = q<HTMLButtonElement>(this.el, "#emoteBtn");
  private emoteList = q(this.el, "#emotes");
  private bubbles = Array.from(this.el.querySelectorAll<HTMLElement>(".bubble"));
  private bubbleTimers: (number | undefined)[] = [undefined, undefined];
  private lastEmote = 0;
  private spinDrag = false;
  private spinTap = 0;
  private menuBtn = q<HTMLButtonElement>(this.el, "#menuBtn");
  private sheet = q(this.el, "#pauseMenu");
  private soundBtn = q<HTMLButtonElement>(this.el, "#soundBtn");
  private musicBtn = q<HTMLButtonElement>(this.el, "#musicBtn");
  private cameraBtn = q<HTMLButtonElement>(this.el, "#cameraBtn");
  private leaveBtn = q<HTMLButtonElement>(this.el, "#leaveBtn");
  private resumeBtn = q<HTMLButtonElement>(this.el, "#resumeBtn");
  private over = q(this.el, "#over");
  private h: HudHandlers | null = null;
  private dragging = false;
  private leaveLabel = "Leave";
  private leaveArmed: number | undefined;
  private msgTimer: number | undefined;

  constructor() {
    this.menuBtn.onclick = () => { sfx.ui(); this.toggleSheet(); };
    this.resumeBtn.onclick = () => this.toggleSheet(false);
    this.viewBtn.onclick = () => { sfx.ui(); this.h?.onToggleView(); };
    this.initSpin();
    this.initEmotes();
    this.replayBtn.onclick = () => { sfx.ui(); this.h?.onReplay(); };
    this.cameraBtn.onclick = () => { sfx.ui(); this.h?.onToggleView(); };
    this.soundBtn.onclick = () => { setSfxMuted(!isSfxMuted()); this.renderSheet(); sfx.ui(); };
    this.musicBtn.onclick = () => { setMusicMuted(!isMusicMuted()); this.renderSheet(); sfx.ui(); };
    this.sheet.addEventListener("pointerdown", (e) => { if (e.target === this.sheet) this.toggleSheet(false); });
    this.leaveBtn.onclick = () => {
      if (this.leaveArmed === undefined) {
        this.leaveBtn.textContent = "Tap again to confirm";
        this.leaveBtn.classList.add("danger-armed");
        this.leaveArmed = window.setTimeout(() => this.disarm(), 3000);
        return;
      }
      this.disarm();
      this.toggleSheet(false);
      this.h?.onLeave();
    };

    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      const r = this.track.getBoundingClientRect();
      // Full power at ~78% of the track, so the bar reacts quickly instead of needing a full-length drag.
      this.setPower(Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height * 0.78))));
      this.h?.onPower(this.value);
    };
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.power.classList.remove("active");
      const p = this.value;
      this.release(p);
      this.h?.onPowerEnd(p);
    };
    this.power.addEventListener("pointerdown", (e) => {
      if (this.h === null) return;
      e.preventDefault();
      this.cancelSpring();
      this.dragging = true;
      this.power.setPointerCapture(e.pointerId);
      this.power.classList.add("active");
      this.h.onPowerStart();
      move(e);
    });
    this.power.addEventListener("pointermove", move);
    this.power.addEventListener("pointerup", end);
    this.power.addEventListener("pointercancel", end);
    this.renderSheet();
  }

  private value = 0;

  bind(h: HudHandlers | null): void { this.h = h; }
  show(): void { this.el.hidden = false; }
  hide(): void {
    this.el.hidden = true;
    this.toggleSheet(false);
    this.hideOver();
    this.setBanner("");
    this.setMessage("");
    this.showPower(false);
    this.setReplay(false, false);
    this.setEmotesEnabled(false);
    this.bubbles.forEach((b) => (b.hidden = true));
  }

  /** Bottom edge of the top bar and the width taken by the power slider, for camera framing. */
  insets(): { top: number; right: number; bottom: number } {
    const bar = this.el.querySelector(".topbar")!.getBoundingClientRect();
    // The power slider only shows while aiming; reserve its width always so the camera doesn't jump.
    return { top: Math.ceil(bar.bottom) + 4, right: window.innerWidth < 560 ? 62 : 72, bottom: window.innerHeight < 520 ? 22 : 34 };
  }

  setPlayers(names: [string, string], me: number | null, stake?: string): void {
    names.forEach((n, i) => {
      const c = this.cards[i];
      q(c, ".pname").textContent = n;
      q(c, ".avatar b").textContent = (n.trim()[0] ?? "?").toUpperCase();
      c.classList.toggle("me", me === i);
      q(c, ".ptag").textContent = me === i ? "YOU" : "";
    });
    this.pot.hidden = !stake;
    this.pot.textContent = stake ?? "";
  }

  /** Show each player's rank beside their name; tapping a card opens that player's profile. */
  setRanks(players: { pid: string; rating: number }[] | undefined, open: (pid: string) => void): void {
    this.cards.forEach((c, i) => {
      const p = players?.[i];
      const el = q(c, ".prank");
      el.hidden = !p;
      c.classList.toggle("clickable", !!p);
      c.onclick = p ? () => open(p.pid) : null;
      if (p) {
        el.innerHTML = `${rankBadge(p.rating, 16)}<b>${p.rating}</b>`;
        el.title = `${rankName(p.rating)} ${p.rating}`;
      }
    });
  }

  private ratingNote: { won: boolean; delta: number; rating: number; ranked: boolean } | null = null;

  /** Rating change for the over modal. May arrive just before or just after the modal opens. */
  setOverRating(r: { won: boolean; delta: number; rating: number; ranked: boolean } | null): void {
    this.ratingNote = r;
    const el = q(this.over, ".modal-rating");
    if (!r) { el.hidden = true; return; }
    el.hidden = false;
    el.className = `modal-rating ${r.ranked ? (r.delta >= 0 ? "up" : "down") : "friendly"}`;
    el.innerHTML = r.ranked
      ? `${rankBadge(r.rating, 30)}<div><b>${r.delta >= 0 ? "+" : ""}${r.delta}</b><span>${rankName(r.rating)} · ${r.rating}</span></div>`
      : `<div><span>Friendly match: rankings unchanged</span></div>`;
  }

  private turnSeat: number | null = null;

  setTurn(current: number | null): void {
    this.turnSeat = current;
    this.cards.forEach((c, i) => c.classList.toggle("active", current === i));
  }

  /** Each player's group label, how many balls they have left, and a tray of glossy mini balls. */
  setBalls(groups: GameState["groups"], balls: GameState["balls"]): void {
    groups.forEach((g, seat) => {
      const card = this.cards[seat];
      const tray = q(card, ".pballs");
      const name = q(card, ".gname");
      const left = q(card, ".gleft");
      if (!g) {
        name.textContent = "OPEN TABLE";
        left.textContent = "";
        card.dataset.group = "";
        tray.replaceChildren(...Array.from({ length: 8 }, (_, i) => Object.assign(document.createElement("span"), { className: `hb ghost${i === 7 ? " eight" : ""}` })));
        return;
      }
      const ids = g === "solids" ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
      const remaining = ids.filter((id) => !balls[id].pocketed).length;
      name.textContent = g.toUpperCase();
      left.textContent = remaining === 0 ? "8 BALL" : `${remaining} LEFT`;
      card.dataset.group = g;
      tray.replaceChildren(
        ...[...ids, 8].map((id) => {
          const d = document.createElement("span");
          d.className = `hb${id > 8 ? " stripe" : ""}${id === 8 ? " eight" : ""}${balls[id].pocketed ? " off" : ""}`;
          d.dataset.n = String(id);
          d.style.setProperty("--c", cssColor(colorOf(id)));
          return d;
        }),
      );
    });
  }

  /** The shot clock lives on the active player's avatar: a ring that drains, plus the seconds next to their name. */
  setClock(left: number | null, total = 60): void {
    this.cards.forEach((c, i) => {
      const mine = left !== null && i === this.turnSeat;
      c.classList.toggle("timing", mine);
      c.classList.toggle("low", mine && left! <= 10);
      q(c, ".ptime").textContent = mine ? `${Math.ceil(left!)}s` : "";
      if (mine) c.style.setProperty("--t", String(Math.min(1, Math.max(0, left! / total))));
    });
  }

  /** Short-lived notice under the top bar. */
  setMessage(text: string, ms = 0): void {
    window.clearTimeout(this.msgTimer);
    this.msg.textContent = text;
    this.msg.classList.toggle("show", !!text);
    if (text && ms) this.msgTimer = window.setTimeout(() => this.setMessage(""), ms);
  }

  // ---------------------------------------------------------------- spin and quick chat

  /** Show the cue-tip position on the cue ball face. x: right, y: up (follow), both in -1..1. */
  setSpin(x: number, y: number): void {
    this.spinDot.style.left = `${50 + x * 39}%`;
    this.spinDot.style.top = `${50 - y * 39}%`;
  }

  private initSpin(): void {
    const set = (e: PointerEvent) => {
      const r = this.spinBall.getBoundingClientRect();
      let x = (e.clientX - (r.left + r.width / 2)) / (r.width * 0.39);
      let y = -(e.clientY - (r.top + r.height / 2)) / (r.height * 0.39);
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      this.setSpin(x, y);
      this.h?.onSpin(x, y);
    };
    this.spinBall.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.spinBall.setPointerCapture(e.pointerId);
      this.spinDrag = true;
      const now = performance.now();
      if (now - this.spinTap < 320) { // double tap recentres
        this.setSpin(0, 0);
        this.h?.onSpin(0, 0);
        this.spinDrag = false;
      } else {
        set(e);
      }
      this.spinTap = now;
    });
    this.spinBall.addEventListener("pointermove", (e) => { if (this.spinDrag) set(e); });
    const end = () => { this.spinDrag = false; };
    this.spinBall.addEventListener("pointerup", end);
    this.spinBall.addEventListener("pointercancel", end);
    this.setSpin(0, 0);
  }

  private initEmotes(): void {
    this.emoteList.replaceChildren(
      ...EMOTES.map((id) => {
        const b = document.createElement("button");
        b.textContent = EMOTE_TEXT[id];
        b.onclick = () => {
          const now = Date.now();
          this.emoteList.hidden = true;
          if (now - this.lastEmote < 1500) return;
          this.lastEmote = now;
          this.h?.onEmote(id);
        };
        return b;
      }),
    );
    this.emoteBtn.onclick = () => { sfx.ui(); this.emoteList.hidden = !this.emoteList.hidden; };
  }

  /** Quick chat is only offered in online matches. */
  setEmotesEnabled(on: boolean): void {
    this.emoteBtn.hidden = !on;
    if (!on) this.emoteList.hidden = true;
  }

  showEmote(seat: number, id: EmoteId): void {
    const el = this.bubbles[seat];
    if (!el) return;
    el.textContent = EMOTE_TEXT[id];
    el.hidden = false;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
    window.clearTimeout(this.bubbleTimers[seat]);
    this.bubbleTimers[seat] = window.setTimeout(() => (el.hidden = true), 2800);
    sfx.ui();
  }

  setReplay(show: boolean, playing: boolean): void {
    this.replayBtn.hidden = !show;
    this.replayBtn.textContent = playing ? "\u25A0 Stop replay" : "\u21BA Replay last shot";
    this.replayBtn.classList.toggle("on", playing);
  }

  setHint(text: string): void { this.hint.textContent = text; }
  setBanner(text: string): void { this.banner.hidden = !text; this.banner.textContent = text; }

  showPower(on: boolean): void {
    this.power.hidden = !on;
    this.spinEl.hidden = !on;
    if (on) this.cancelSpring();
    if (!on) { this.dragging = false; this.spinDrag = false; }
    this.setPower(0);
  }

  /** Draw the bar. `p` may dip below 0 while the knob overshoots its rest position. */
  private renderPower(p: number): void {
    const clamped = Math.min(1, Math.max(0, p));
    this.fill.style.clipPath = `inset(0 0 ${100 - clamped * 100}% 0)`;
    // Overshoot above the rest position is shown compressed, so the grip stays inside the bar.
    this.knob.style.top = `${(p >= 0 ? p : p * 0.18) * 100}%`;
    this.spring.style.height = `${clamped * 100}%`;
    this.powerPct.textContent = String(Math.round(clamped * 100));
  }

  setPower(p: number): void {
    if (this.springing) return;
    this.value = p;
    this.renderPower(p);
  }

  /** The knob snaps back to rest like a released spring: a quick damped oscillation. */
  release(p0: number): void {
    if (this.springing) return;
    if (p0 < 0.02) return this.setPower(0);
    this.springing = true;
    const omega = 26; // rad/s
    const zeta = 0.26;
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      const x = p0 * Math.exp(-zeta * omega * t) * Math.cos(wd * t);
      if (t < 1 && (Math.abs(x) > 0.003 || t < 0.1)) {
        this.renderPower(x);
        this.springRaf = requestAnimationFrame(tick);
      } else {
        this.cancelSpring();
      }
    };
    this.springRaf = requestAnimationFrame(tick);
  }

  private cancelSpring(): void {
    cancelAnimationFrame(this.springRaf);
    this.springing = false;
    this.value = 0;
    this.renderPower(0);
  }

  setView(is3d: boolean): void {
    this.viewBtn.textContent = is3d ? "3D" : "2D";
    this.cameraBtn.textContent = `Camera: ${is3d ? "3D" : "Top-down"}`;
  }

  setLeaveLabel(label: string): void {
    this.leaveLabel = label;
    this.disarm();
  }

  showOver(o: OverOptions): void {
    this.toggleSheet(false);
    this.showPower(false);
    this.over.className = `modal ${o.tone}`;
    this.setOverRating(this.ratingNote);
    q(this.over, ".modal-title").textContent = o.title;
    q(this.over, ".modal-sub").textContent = o.sub;
    const actions = q(this.over, ".modal-actions");
    const mk = (b: { label: string; run: () => void }, cls: string) => {
      const btn = document.createElement("button");
      btn.className = cls;
      btn.textContent = b.label;
      btn.onclick = () => { sfx.ui(); b.run(); };
      return btn;
    };
    actions.replaceChildren(mk(o.primary, "btn primary"), ...(o.secondary ? [mk(o.secondary, "btn ghost")] : []));
    this.over.hidden = false;
    if (o.tone === "win") sfx.win();
    else if (o.tone === "lose") sfx.lose();
  }

  hideOver(): void {
    this.over.hidden = true;
    this.ratingNote = null;
    q(this.over, ".modal-rating").hidden = true;
  }

  private disarm(): void {
    window.clearTimeout(this.leaveArmed);
    this.leaveArmed = undefined;
    this.leaveBtn.textContent = this.leaveLabel;
    this.leaveBtn.classList.remove("danger-armed");
  }

  private toggleSheet(on = this.sheet.hidden): void {
    this.sheet.hidden = !on;
    if (!on) this.disarm();
    else this.renderSheet();
  }

  private renderSheet(): void {
    this.soundBtn.textContent = `Effects: ${isSfxMuted() ? "Off" : "On"}`;
    this.musicBtn.textContent = `Music: ${isMusicMuted() ? "Off" : "On"}`;
  }
}
