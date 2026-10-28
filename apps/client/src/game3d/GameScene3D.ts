import {
  BALL_R, FRAME_RATE, GameState, HEAD_SPOT, Seat, ServerMessage, ShotReport, TABLE_H, TABLE_W,
  isValidPlacement, newGame, takeShot,
} from "@8pool/shared";
import type { Net } from "../net";
import { Hud } from "../hud";
import { sfx, unlockAudio } from "../audio";
import { prefs, recordMatch } from "../settings";
import type { CamMode, Guide, Pt, Stage } from "./Stage";

type MatchStart = Extract<ServerMessage, { t: "match_start" }>;

export type SceneData =
  | { mode: "local"; onExit: () => void }
  | { mode: "online"; net: Net; start: MatchStart; pot?: string; tournament?: "semis" | "final"; openProfile?: (pid: string) => void; onExit: () => void };

/** placing/aiming/charging: it's my shot. waiting: opponent's turn, or my shot is in flight. */
type Phase = "placing" | "aiming" | "charging" | "waiting" | "animating" | "over";

interface Anim {
  report: ShotReport;
  next: GameState;
  prev: GameState;
  shooter: Seat;
  frame: number; // fractional frame index
  lastIdx: number;
  dropped: Set<number>;
}

const DRAG_SENS = 0.0042; // radians per pixel in the 3D view
const round2 = (n: number) => Math.round(n * 100) / 100;
const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export class GameScene3D {
  private game_!: GameState;
  private phase: Phase = "placing";
  private cue: Pt = { x: HEAD_SPOT.x, y: HEAD_SPOT.y }; // cue ball position while the shooter has ball in hand
  private placed = false;
  private ptr: Pt = { x: HEAD_SPOT.x, y: HEAD_SPOT.y }; // pointer in table mm
  private aimAngle = 0;
  private power = 0;
  private keyCharge = false;
  private anim: Anim | null = null;
  private message = "";
  private view3d = true;
  private viewPhase: Phase | null = null;
  private drag: { id: number; x: number } | null = null;
  private recorded = false;
  private slowView = false;
  private spin = { x: 0, y: 0 };
  private lastShot: ShotReport | null = null;
  private replay: { report: ShotReport; frame: number; lastIdx: number; dropped: Set<number> } | null = null;

  // online-only
  private seat: Seat | null = null;
  private names: [string, string] = ["Player 1", "Player 2"];
  private pending: ServerMessage[] = []; // server messages that arrived mid-animation
  private deadline = 0;
  private turnTotal = 60;
  private clockOffset = 0; // server clock minus local clock
  private over: { winner: Seat; reason: string } | null = null;
  private unsubscribe: (() => void) | null = null;
  private cleanup: (() => void)[] = [];

  constructor(private stage: Stage, private hud: Hud, private data_: SceneData) {
    this.view3d = prefs.view3d();
    const online = data_.mode === "online";
    hud.setLeaveLabel(online ? "Resign" : "Leave");
    hud.setView(this.view3d);
    hud.bind({
      onPowerStart: () => this.beginCharge(),
      onPower: (p) => { if (this.phase === "charging") this.power = p; },
      onPowerEnd: (p) => this.endCharge(p),
      onToggleView: () => this.toggleView(),
      onReplay: () => (this.replay ? this.stopReplay() : this.startReplay()),
      onSpin: (x, y) => { if (this.phase === "aiming" || this.phase === "charging") this.spin = { x, y }; },
      onEmote: (id) => { if (data_.mode === "online") data_.net.send({ t: "emote", id }); },
      onLeave: () => this.leave(),
    });
    hud.show();
    hud.setEmotesEnabled(online);
    hud.setSpin(0, 0);
    hud.hideOver();
    hud.setBanner("");
    this.attachInput();
    stage.frameHook = (dt) => this.update(dt);
    stage.setCamera("watch", true);
    requestAnimationFrame(() => this.applyInsets());

    if (data_.mode === "online") {
      this.unsubscribe = data_.net.subscribe((m) => this.onNet(m));
      this.applySnapshot(data_.start);
    } else {
      this.startLocalGame();
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.hud.bind(null);
    this.hud.hide();
    this.stage.frameHook = null;
    this.stage.showCue(false);
    this.stage.setGuide(null);
    this.stage.setGhostBall(null);
    this.stage.setBreakLine(false);
    this.stage.setInsets({ l: 0, r: 0, t: 0, b: 0 });
  }

  // ---------------------------------------------------------------- setup

  private applyInsets(): void {
    const i = this.hud.insets();
    // Landscape: reserve the same width on both sides so the table sits in the middle of the screen.
    this.stage.setInsets({ l: this.stage.portrait ? 0 : i.right, r: i.right, t: i.top, b: i.bottom });
  }

  private get shooting(): boolean {
    return this.phase === "placing" || this.phase === "aiming" || this.phase === "charging";
  }

  private syncBalls(balls = this.game_.balls): void {
    balls.forEach((b, id) => {
      const pos = id === 0 && this.game_.ballInHand && this.shooting ? this.cue : b;
      this.stage.placeBall(id, pos.x, pos.y, !b.pocketed);
    });
    // While placing, the cue ball is drawn as the ghost under the pointer.
    if (this.phase === "placing") this.stage.placeBall(0, this.cue.x, this.cue.y, false);
  }

  private toggleView(): void {
    this.slowView = true;
    this.view3d = !this.view3d;
    prefs.setView3d(this.view3d);
    this.hud.setView(this.view3d);
    this.viewPhase = null;
  }

  private syncView(): void {
    let mode: CamMode;
    if (this.phase === "placing") mode = "top";
    else if (this.phase === "aiming" || this.phase === "charging") mode = this.view3d ? "aim" : "top";
    else mode = this.view3d ? "watch" : "top";
    if (this.replay) mode = this.view3d ? "watch" : "top";
    this.stage.setCamera(mode, false, this.slowView);
    this.slowView = false;
    this.hud.showPower(this.phase === "aiming" || this.phase === "charging");
  }

  // ---------------------------------------------------------------- turn flow

  private nameOf(seat: Seat): string {
    if (this.data_.mode === "local") return `Player ${seat + 1}`;
    return seat === this.seat ? `${this.names[seat]} (you)` : this.names[seat];
  }

  private isMine(): boolean {
    return this.data_.mode === "local" || this.game_.current === this.seat;
  }

  private startLocalGame(): void {
    this.game_ = newGame((Math.random() * 2 ** 32) >>> 0);
    this.over = null;
    this.hud.hideOver();
    this.message = "Break! Place the cue ball behind the line.";
    this.aimAngle = 0;
    this.beginTurn();
  }

  private beginTurn(): void {
    this.replay = null;
    if (this.over) {
      this.phase = "over";
    } else if (!this.isMine()) {
      this.phase = "waiting";
    } else if (this.game_.ballInHand) {
      this.startPlacing();
      return;
    } else {
      this.phase = "aiming";
    }
    this.syncBalls();
    this.refreshHud();
  }

  private startPlacing(): void {
    this.phase = "placing";
    this.placed = false;
    this.cue = { x: this.game_.balls[0].x, y: this.game_.balls[0].y };
    this.syncBalls();
    this.refreshHud();
  }

  private refreshHud(): void {
    const g = this.game_;
    const h = this.hud;
    const online = this.data_.mode === "online";
    const d = this.data_;
    h.setPlayers(d.mode === "online" ? this.names : ["Player 1", "Player 2"], d.mode === "online" ? this.seat : null, d.mode === "online" ? d.pot : undefined);
    h.setBalls(g.groups, g.balls);
    h.setRanks(d.mode === "online" ? d.start.players : undefined, (pid) => d.mode === "online" && d.openProfile?.(pid));
    h.setReplay(this.lastShot !== null && !this.over && this.phase !== "animating" && this.phase !== "charging", this.replay !== null);

    if (this.over) {
      h.setTurn(null);
      h.setHint("");
      h.setClock(null);
      this.showOverModal(this.over);
      return;
    }
    h.setTurn(g.current);
    h.setMessage(this.message, 5500);
    if (!this.message && this.phase === "aiming" && online) h.setMessage("Your turn", 1400);
    const tap = coarse ? "Tap" : "Click";
    h.setHint(
      this.phase === "placing"
        ? `${tap} to place the cue ball`
        : this.phase === "waiting"
          ? this.isMine() ? "Sending shot…" : "Waiting for opponent…"
          : this.phase === "animating"
            ? ""
            : `${this.view3d ? "Drag to aim" : coarse ? "Drag to aim" : "Point to aim"} • pull the power bar down to shoot${g.ballInHand && !coarse ? " • P: re-place cue ball" : ""}`,
    );
  }

  private showOverModal(o: { winner: Seat; reason: string }): void {
    const d = this.data_;
    if (d.mode === "online") {
      const won = o.winner === this.seat;
      if (!this.recorded) {
        this.recorded = true;
        recordMatch(won);
      }
      this.hud.showOver({
        title: won ? "You win!" : "You lose",
        sub: o.reason,
        tone: won ? "win" : "lose",
        primary: { label: d.tournament ? "View bracket" : "Back to lobby", run: () => this.data_.onExit() },
      });
    } else {
      this.hud.showOver({
        title: `${this.nameOf(o.winner)} wins!`,
        sub: o.reason,
        tone: "neutral",
        primary: { label: "Play again", run: () => this.startLocalGame() },
        secondary: { label: "Leave", run: () => this.data_.onExit() },
      });
    }
  }

  private leave(): void {
    const d = this.data_;
    if (this.over || d.mode === "local") return d.onExit();
    d.net.send({ t: "resign" });
  }

  // ---------------------------------------------------------------- online messages

  private onNet(m: ServerMessage): void {
    if (this.phase === "animating" && (m.t === "shot_result" || m.t === "state" || m.t === "game_over")) {
      this.pending.push(m);
      return;
    }
    this.handleNet(m);
  }

  private setTiming(m: { turnDeadline: number; serverNow: number }): void {
    this.deadline = m.turnDeadline;
    this.clockOffset = m.serverNow - Date.now();
    this.turnTotal = Math.max(10, (m.turnDeadline - m.serverNow) / 1000);
  }

  private applySnapshot(m: MatchStart): void {
    this.seat = m.seat;
    this.names = m.names;
    this.game_ = m.state;
    this.anim = null;
    this.pending = [];
    this.over = null;
    this.hud.hideOver();
    this.hud.setBanner("");
    this.setTiming(m);
    this.message = m.resumed ? "Reconnected." : this.game_.breakShot ? (this.isMine() ? "You break! Place the cue ball behind the line." : "Opponent breaks.") : "";
    this.beginTurn();
  }

  private handleNet(m: ServerMessage): void {
    switch (m.t) {
      case "match_start": // resume after a reconnect
        return this.applySnapshot(m);
      case "shot_result":
        this.setTiming(m);
        this.startAnim(m.report, m.state, this.game_, m.seat);
        return;
      case "state":
        this.setTiming(m);
        this.game_ = m.state;
        this.message = m.reason;
        return this.beginTurn();
      case "emote":
        this.hud.showEmote(m.seat, m.id);
        return;
      case "rating":
        this.hud.setOverRating(m);
        return;
      case "opponent_status":
        this.hud.setBanner(m.connected ? "" : "Opponent disconnected — they have 60s to reconnect");
        return;
      case "game_over":
        this.game_ = m.state;
        this.over = { winner: m.winner, reason: m.reason };
        this.hud.setBanner("");
        return this.beginTurn();
      case "welcome":
        // Our session no longer holds a match: it finished while we were offline.
        if (!m.resumed && !this.over) {
          this.over = { winner: this.seat === 0 ? 1 : 0, reason: "The match ended while you were disconnected." };
          this.beginTurn();
        }
        return;
      case "error":
        this.message = m.message;
        if (this.phase === "waiting" && this.isMine()) return this.beginTurn();
        return this.refreshHud();
    }
  }

  // ---------------------------------------------------------------- input

  private attachInput(): void {
    const c = this.stage.canvas;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, ev: string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(ev, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(ev, fn as EventListener, opts));
    };
    on(c, "pointerdown", (e: PointerEvent) => this.onDown(e));
    on(c, "pointermove", (e: PointerEvent) => this.onMove(e));
    on(c, "pointerup", (e: PointerEvent) => this.onUp(e));
    on(c, "pointercancel", () => { this.drag = null; });
    on(c, "wheel", (e: WheelEvent) => {
      if (this.phase !== "aiming") return;
      e.preventDefault();
      this.aimAngle += Math.sign(e.deltaY) * 0.0035;
    }, { passive: false });
    on(window, "keydown", (e: KeyboardEvent) => this.onKey(e, true));
    on(window, "keyup", (e: KeyboardEvent) => this.onKey(e, false));
    on(window, "resize", () => this.applyInsets());
    on(window, "orientationchange", () => window.setTimeout(() => this.applyInsets(), 250));
  }

  /** Pointer position on the table; fingers aim from just above the touch point so they don't cover the target. */
  private pick(e: PointerEvent): Pt | null {
    return this.stage.pick(e.clientX, e.pointerType === "touch" ? e.clientY - 48 : e.clientY);
  }

  private cueBall(): Pt {
    return this.game_.ballInHand ? this.cue : this.game_.balls[0];
  }

  private onDown(e: PointerEvent): void {
    unlockAudio();
    if (this.phase === "over") return;
    this.stage.canvas.setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, x: e.clientX };
    this.aimFromPointer(e);
  }

  private onMove(e: PointerEvent): void {
    const pressed = this.drag?.id === e.pointerId;
    if (this.phase === "aiming" && this.view3d && this.drag && pressed) {
      this.aimAngle += (e.clientX - this.drag.x) * DRAG_SENS;
      this.drag.x = e.clientX;
      return;
    }
    if (e.pointerType === "touch" && !pressed) return;
    this.aimFromPointer(e);
  }

  private aimFromPointer(e: PointerEvent): void {
    const p = this.pick(e);
    if (!p) return;
    this.ptr = p;
    if (this.phase === "aiming" && !this.view3d) {
      const c = this.cueBall();
      this.aimAngle = Math.atan2(p.y - c.y, p.x - c.x);
    }
  }

  private onUp(e: PointerEvent): void {
    const wasDown = this.drag?.id === e.pointerId;
    this.drag = null;
    if (!wasDown || this.phase !== "placing" || this.replay) return;
    const p = this.pick(e);
    if (p) this.ptr = p;
    if (!isValidPlacement(this.game_, this.ptr.x, this.ptr.y)) return;
    sfx.ui();
    this.cue = { x: this.ptr.x, y: this.ptr.y };
    this.placed = true;
    this.phase = "aiming";
    this.message = "";
    this.syncBalls();
    this.refreshHud();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    const fine = e.shiftKey ? 0.0006 : 0.004;
    if (down && e.key === "ArrowLeft" && this.phase === "aiming") this.aimAngle -= fine;
    else if (down && e.key === "ArrowRight" && this.phase === "aiming") this.aimAngle += fine;
    else if (down && (e.key === "p" || e.key === "P") && this.phase === "aiming" && this.game_.ballInHand) this.startPlacing();
    else if (e.key === " ") {
      e.preventDefault();
      if (down && !e.repeat && this.beginCharge()) this.keyCharge = true;
      else if (!down && this.keyCharge) {
        this.keyCharge = false;
        this.endCharge(this.power);
      }
    }
  }

  private beginCharge(): boolean {
    if (this.phase !== "aiming" || this.replay) return false;
    unlockAudio();
    this.phase = "charging";
    this.power = 0;
    return true;
  }

  private endCharge(p: number): void {
    if (this.phase !== "charging") return;
    this.hud.release(p); // no-op when the bar itself was released
    this.power = p;
    if (p < 0.03) {
      this.phase = "aiming";
      this.power = 0;
      this.hud.setPower(0);
      return;
    }
    this.fire();
  }

  private fire(): void {
    const d = this.data_;
    const placement = this.game_.ballInHand && this.placed ? { ...this.cue } : undefined;
    const hasSpin = Math.hypot(this.spin.x, this.spin.y) > 0.02;
    const spin = hasSpin ? { x: round2(this.spin.x), y: round2(this.spin.y) } : undefined;
    const shot = { angle: this.aimAngle, power: this.power, spin, placement };

    if (d.mode === "online") {
      if (!d.net.send({ t: "shot", ...shot })) {
        this.message = "Not connected to the server.";
        this.phase = "aiming";
        this.power = 0;
        this.hud.setPower(0);
        return this.refreshHud();
      }
      this.stage.strikeCue();
      sfx.cue(this.power);
      this.resetSpin();
      this.phase = "waiting"; // the animation starts when the server's result arrives
      this.message = "";
      this.refreshHud();
      return;
    }
    try {
      const { game, result } = takeShot(this.game_, shot);
      this.stage.strikeCue();
      sfx.cue(this.power);
      this.startAnim(result, game, this.game_, this.game_.current);
    } catch (e) {
      this.message = (e as Error).message;
      this.phase = "aiming";
      this.power = 0;
      this.hud.setPower(0);
      this.refreshHud();
    }
  }

  // ---------------------------------------------------------------- per-frame

  private update(dtMs: number): void {
    // An exception escaping here would freeze the render loop's game logic for good.
    const running = this.anim;
    try {
      if (this.phase !== this.viewPhase) {
        this.viewPhase = this.phase;
        this.syncView();
      }
      if (this.keyCharge && this.phase === "charging") {
        this.power = Math.min(1, this.power + dtMs / 800);
      }
      if (this.phase === "charging") this.hud.setPower(this.power);
      if (this.phase === "animating" && this.anim) this.stepAnim(dtMs);
      if (this.replay) this.stepReplay(dtMs);
      this.drawOverlay();
      this.updateClock();
    } catch (e) {
      console.error("[8pool] frame error", e, { phase: this.phase });
      this.hud.setMessage(`Display error: ${(e as Error).message}`, 4000);
      if (this.phase === "animating") {
        // Don't strand the player mid-animation: jump to the final position.
        this.anim = null;
        if (running) this.game_ = running.next;
        this.pending.length = 0;
        this.beginTurn();
      }
    }
  }

  private updateClock(): void {
    const online = this.data_.mode === "online";
    if (!online || this.over || this.phase === "animating" || !this.deadline) return this.hud.setClock(null);
    this.hud.setClock(Math.max(0, (this.deadline - (Date.now() + this.clockOffset)) / 1000), this.turnTotal);
  }

  private resetSpin(): void {
    this.spin = { x: 0, y: 0 };
    this.hud.setSpin(0, 0);
  }

  private startAnim(report: ShotReport, next: GameState, prev: GameState, shooter: Seat): void {
    this.anim = { report, next, prev, shooter, frame: 0, lastIdx: 0, dropped: new Set() };
    this.lastShot = report;
    this.replay = null;
    this.resetSpin();
    this.phase = "animating";
    this.message = "";
    this.hud.setMessage("");
    this.power = 0;
    this.hud.setPower(0);
    this.refreshHud();
    sfx.clack(0.9);
  }

  private stepAnim(deltaMs: number): void {
    const a = this.anim!;
    a.frame += (deltaMs / 1000) * FRAME_RATE;
    const frames = a.report.frames;
    const last = frames.length - 1;
    const idx = Math.min(Math.floor(a.frame), last);
    const t = idx >= last ? 0 : a.frame - idx;
    const f = frames[idx];
    const g = frames[Math.min(idx + 1, last)];
    this.collisionSounds(a, idx);

    for (let id = 0; id < 16; id++) {
      const pocketedAt = a.report.pocketFrames[id];
      if (pocketedAt !== undefined && idx >= pocketedAt) {
        if (!a.dropped.has(id)) {
          a.dropped.add(id);
          this.stage.dropBall(id);
          sfx.pocket();
        }
        continue;
      }
      this.stage.placeBall(id, f[id * 2] + (g[id * 2] - f[id * 2]) * t, f[id * 2 + 1] + (g[id * 2 + 1] - f[id * 2 + 1]) * t, true, true);
    }
    if (idx >= last) {
      this.anim = null;
      this.finishShot(a);
    }
  }

  // ---------------------------------------------------------------- replay

  private startReplay(): void {
    if (!this.lastShot || this.phase === "animating" || this.phase === "charging" || this.over) return;
    this.replay = { report: this.lastShot, frame: 0, lastIdx: 0, dropped: new Set() };
    this.viewPhase = null;
    this.refreshHud();
    sfx.clack(0.7);
  }

  private stopReplay(): void {
    if (!this.replay) return;
    this.replay = null;
    this.syncBalls();
    this.viewPhase = null;
    this.refreshHud();
  }

  /** Plays the last recorded shot back at reduced speed without touching the game state. */
  private stepReplay(deltaMs: number): void {
    const r = this.replay!;
    r.frame += (deltaMs / 1000) * FRAME_RATE * 0.75;
    const frames = r.report.frames;
    const last = frames.length - 1;
    const idx = Math.min(Math.floor(r.frame), last);
    const t = idx >= last ? 0 : r.frame - idx;
    const f = frames[idx];
    const g = frames[Math.min(idx + 1, last)];
    this.collisionSounds(r as unknown as Anim, idx);
    for (let id = 0; id < 16; id++) {
      const at = r.report.pocketFrames[id];
      if (at !== undefined && idx >= at) {
        if (!r.dropped.has(id)) {
          r.dropped.add(id);
          this.stage.dropBall(id);
          sfx.pocket();
        }
        continue;
      }
      this.stage.placeBall(id, f[id * 2] + (g[id * 2] - f[id * 2]) * t, f[id * 2 + 1] + (g[id * 2 + 1] - f[id * 2 + 1]) * t, true, true);
    }
    if (idx >= last) window.setTimeout(() => { if (this.replay === r) this.stopReplay(); }, 700);
  }

  /** Infer hits from sudden velocity changes between recorded frames. */
  private collisionSounds(a: Anim, idx: number): void {
    const frames = a.report.frames;
    for (let i = Math.max(a.lastIdx + 1, 2); i <= idx; i++) {
      const f0 = frames[i - 2], f1 = frames[i - 1], f2 = frames[i];
      let ball = 0, rail = 0;
      for (let id = 0; id < 16; id++) {
        const pf = a.report.pocketFrames[id];
        if (pf !== undefined && i >= pf) continue;
        const dv = Math.hypot(f2[id * 2] - 2 * f1[id * 2] + f0[id * 2], f2[id * 2 + 1] - 2 * f1[id * 2 + 1] + f0[id * 2 + 1]);
        if (dv < 2.5) continue;
        const x = f2[id * 2], y = f2[id * 2 + 1];
        const nearRail = x < BALL_R + 3 || y < BALL_R + 3 || x > TABLE_W - BALL_R - 3 || y > TABLE_H - BALL_R - 3;
        if (nearRail) rail = Math.max(rail, dv);
        else ball = Math.max(ball, dv);
      }
      if (ball) sfx.clack(ball / 45);
      if (rail) sfx.cushion(rail / 45);
    }
    a.lastIdx = idx;
  }

  private finishShot(a: Anim): void {
    this.game_ = a.next;
    if (this.data_.mode === "local" && a.next.winner !== null) {
      this.over = { winner: a.next.winner, reason: a.next.endReason ?? "" };
    }
    if (!this.over && a.next.winner === null) {
      const ev = a.report.events;
      const potted = ev.pocketed.filter((i) => i).join(", ");
      if (a.next.ballInHand) {
        this.message = `Foul${ev.pocketed.includes(0) ? " (scratch)" : ""} — ${this.nameOf(a.next.current)} has ball in hand`;
      } else if (a.next.current === a.prev.current) {
        this.message = potted ? `${this.nameOf(a.shooter)} potted ${potted} — shoots again` : "";
      }
      if (a.prev.groups[0] === null && a.next.groups[0] !== null) {
        this.message += ` Groups assigned: ${this.nameOf(a.shooter)} is ${a.next.groups[a.shooter]}.`;
      }
    }
    // Messages that arrived during the animation (e.g. game_over) apply now, in order.
    const queued = this.pending.splice(0);
    if (queued.length === 0) return this.beginTurn();
    this.syncBalls();
    for (const m of queued) {
      if (this.phase === "animating") this.pending.push(m);
      else this.handleNet(m);
    }
    if (this.phase === "animating") return;
    if (!this.over) this.beginTurn();
  }

  // ---------------------------------------------------------------- aim overlay

  private computeGuide(c: Pt, angle: number): Guide {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let tMin = Infinity;
    if (dx > 0) tMin = Math.min(tMin, (TABLE_W - BALL_R - c.x) / dx);
    if (dx < 0) tMin = Math.min(tMin, (BALL_R - c.x) / dx);
    if (dy > 0) tMin = Math.min(tMin, (TABLE_H - BALL_R - c.y) / dy);
    if (dy < 0) tMin = Math.min(tMin, (BALL_R - c.y) / dy);
    let hit = -1;
    for (let id = 1; id < 16; id++) {
      const b = this.game_.balls[id];
      if (b.pocketed) continue;
      const fx = c.x - b.x;
      const fy = c.y - b.y;
      const bq = dx * fx + dy * fy;
      const disc = bq * bq - (fx * fx + fy * fy - 4 * BALL_R * BALL_R);
      if (disc < 0) continue;
      const t = -bq - Math.sqrt(disc);
      if (t > 0 && t < tMin) {
        tMin = t;
        hit = id;
      }
    }
    const e = { x: c.x + dx * tMin, y: c.y + dy * tMin };
    const guide: Guide = { c: { x: c.x, y: c.y }, e, ghost: hit > 0 };
    if (hit > 0) {
      const b = this.game_.balls[hit];
      let nx = b.x - e.x;
      let ny = b.y - e.y;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      guide.obj = { x: b.x, y: b.y, dx: nx, dy: ny };
      const dot = dx * nx + dy * ny;
      const tx = dx - dot * nx;
      const ty = dy - dot * ny;
      const tl = Math.hypot(tx, ty);
      if (tl > 0.05) guide.defl = { dx: tx / tl, dy: ty / tl, len: 60 + 220 * tl };
    }
    return guide;
  }

  private drawOverlay(): void {
    const s = this.stage;
    if (this.replay) {
      s.setGhostBall(null);
      s.setBreakLine(false);
      s.showCue(false);
      s.setGuide(null);
      return;
    }
    if (this.phase === "placing") {
      s.setGhostBall({ ...this.ptr, ok: isValidPlacement(this.game_, this.ptr.x, this.ptr.y) });
      s.setBreakLine(this.game_.breakShot);
      s.showCue(false);
      s.setGuide(null);
      return;
    }
    s.setGhostBall(null);
    s.setBreakLine(false);
    if (this.phase !== "aiming" && this.phase !== "charging") {
      s.showCue(false);
      s.setGuide(null);
      return;
    }
    const c = this.cueBall();
    s.setAim(c.x, c.y, this.aimAngle);
    s.setCueSpin(this.spin.x, this.spin.y);
    s.showCue(true, this.phase === "charging" ? this.power : 0);
    s.setGuide(this.computeGuide(c, this.aimAngle));
  }
}
