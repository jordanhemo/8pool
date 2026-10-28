import { ROOMS, ROOM_ORDER, RoomId } from "./game3d/rooms";
import { isMusicMuted, isSfxMuted, setMusicMuted, setSfxMuted, sfx } from "./audio";
import { Quality, prefs } from "./settings";

export type ScreenId = "play" | "matchmaking" | "tournament" | "private" | "local" | "rooms" | "wallet" | "stats" | "settings";

const ICONS: Record<ScreenId, string> = {
  play: '<path d="M8 5v14l11-7L8 5Z"/>',
  matchmaking: '<path d="M12 3 4 7v5c0 4.4 3.2 8.4 8 9 4.8-.6 8-4.6 8-9V7l-8-4Zm-1 13-3-3 1.4-1.4L11 13.2l3.6-3.6L16 11l-5 5Z"/>',
  tournament: '<path d="M7 4h10v2h3v3c0 2.2-1.8 4-4 4h-.3A5 5 0 0 1 13 15.9V18h3v2H8v-2h3v-2.1A5 5 0 0 1 8.3 13H8c-2.2 0-4-1.8-4-4V6h3V4Zm-1 4v1c0 1.1.9 2 2 2V8H6Zm12 0h-2v3c1.1 0 2-.9 2-2V8Z"/>',
  local: '<circle cx="8" cy="9" r="3.2"/><circle cx="16.5" cy="9" r="3.2"/><path d="M2 19c0-3 2.7-5 6-5s6 2 6 5v1H2v-1Zm12.2-4.6c.7-.3 1.5-.4 2.3-.4 3 0 5.5 1.8 5.5 4.6V20h-6v-1.2c0-1.7-.6-3.1-1.8-4.4Z"/>',
  private: '<path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Zm3 4a1.800 1.800 0 0 1 1 3.300V19h-2v-1.700A1.800 1.800 0 0 1 12 14Z"/>',
  rooms: '<path d="M3 21V9l9-6 9 6v12h-6v-7H9v7H3Zm6-9h2V10H9v2Zm4 0h2V10h-2v2Z"/>',
  wallet: '<path d="M3 6a2 2 0 0 1 2-2h13v3H5v1h15a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm14 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>',
  stats: '<path d="M4 20V10h4v10H4Zm6 0V4h4v16h-4Zm6 0v-7h4v7h-4Z"/>',
  settings: '<path d="m19.4 13 .1-1-.1-1 2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.4 2.4c-.6.3-1.2.6-1.7 1l-2.5-1-2 3.5L6.5 11l-.1 1 .1 1-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.4h4l.4-2.4c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.1-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/>',
};

interface Item { id: ScreenId; label: string; sub: string }

const ROOT_ITEMS: Item[] = [
  { id: "play", label: "Play", sub: "Matches & tournaments" },
  { id: "stats", label: "Leaderboard", sub: "Rankings & your stats" },
  { id: "settings", label: "Settings", sub: "Sound, camera, room, name" },
];

const PLAY_ITEMS: Item[] = [
  { id: "matchmaking", label: "Matchmaking", sub: "Quick match for tokens" },
  { id: "tournament", label: "Tournament", sub: "Knockout for the big pot" },
  { id: "private", label: "Private room", sub: "Play a friend, your stake" },
  { id: "local", label: "Local", sub: "2 players, 1 screen" },
];

const TITLES: Record<ScreenId, string> = {
  play: "Play", matchmaking: "Matchmaking", tournament: "Tournament", private: "Private room", local: "Local", rooms: "Rooms", wallet: "Wallet", stats: "Leaderboard", settings: "Settings",
};

/** Where Back leads. Screens without an entry return to the main menu. */
const PARENT: Partial<Record<ScreenId, ScreenId>> = {
  matchmaking: "play", tournament: "play", private: "play", local: "play", rooms: "settings",
};

export interface MenuHandlers {
  /** Show a room on the backdrop; `commit` stores it as the player's choice. */
  setRoom(id: RoomId, commit: boolean): void;
  getRoom(): RoomId;
  setQuality(q: Quality): void;
  /** A screen was opened (so it can refresh its data). */
  onOpen?(id: ScreenId): void;
}

const FOCUSABLE = "button:not(:disabled):not([hidden]), input:not([hidden])";

/** Main-menu navigation: button list, sub-screens, room carousel and settings controls. Fully keyboard driven. */
export class Menu {
  private lobby = document.getElementById("lobby")!;
  private nav = document.getElementById("mainMenu")!;
  private screen = document.getElementById("screen")!;
  private title = document.getElementById("screenTitle")!;
  private panes = Array.from(this.screen.querySelectorAll<HTMLElement>(".pane"));
  private roomList = document.getElementById("roomList")!;
  private current: ScreenId | null = null;
  private committed: RoomId;
  private browsing: RoomId;
  private lastHover: Element | null = null;

  constructor(private h: MenuHandlers) {
    this.committed = this.browsing = h.getRoom();
    this.fill(this.nav, ROOT_ITEMS);
    this.fill(document.getElementById("playMenu")!, PLAY_ITEMS);
    for (const list of [this.nav, document.getElementById("playMenu")!]) {
      list.addEventListener("click", (e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>("[data-screen]")?.dataset.screen as ScreenId | undefined;
        if (id) this.open(id);
      });
    }
    document.getElementById("backBtn")!.onclick = () => this.close();
    document.getElementById("playerChip")!.onclick = () => this.open("settings");
    document.getElementById("balanceChip")!.onclick = () => this.open("wallet");
    this.buildRooms();
    this.buildSettings();
    this.syncMute();
    document.getElementById("muteBtn")!.onclick = () => {
      const allOff = isSfxMuted() && isMusicMuted();
      setSfxMuted(!allOff);
      setMusicMuted(!allOff);
      sfx.ui();
      this.syncMute();
      this.buildSettings();
    };

    this.lobby.addEventListener("pointerover", (e) => this.onHover(e));
    this.lobby.addEventListener("pointerleave", () => (this.lastHover = null));
    document.addEventListener("keydown", (e) => this.onKey(e));
    this.focusFirst();
  }

  private fill(host: HTMLElement, items: Item[]): void {
    host.replaceChildren(
      ...items.map((it) => {
        const b = document.createElement("button");
        b.className = `mitem m-${it.id}`;
        b.dataset.screen = it.id;
        b.innerHTML = `<span class="mi-icon"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">${ICONS[it.id]}</svg></span><span class="mi-text"><strong>${it.label}</strong><small>${it.sub}</small></span><span class="mi-arrow">&#9656;</span>`;
        return b;
      }),
    );
  }

  /** The room the player picked in Rooms/Settings, regardless of any preview or venue in use. */
  getCommitted(): RoomId { return this.committed; }

  open(id: ScreenId): void {
    sfx.ui();
    this.show(id);
  }

  private show(id: ScreenId): void {
    this.current = id;
    this.title.textContent = TITLES[id];
    this.panes.forEach((p) => (p.hidden = p.dataset.pane !== id));
    if (id === "settings") this.buildSettings();
    if (id === "rooms") {
      this.browsing = this.committed;
      this.renderRooms();
    }
    this.h.onOpen?.(id);
    this.screen.hidden = false;
    this.nav.hidden = true;
    this.lobby.classList.add("in-screen");
    this.focusFirst();
  }

  close(): void {
    sfx.ui();
    const parent = this.current ? PARENT[this.current] : undefined;
    if (parent) return this.show(parent);
    this.reset();
  }

  /** Back to the root menu without a click sound, e.g. after leaving a match. */
  reset(): void {
    this.current = null;
    this.screen.hidden = true;
    this.nav.hidden = false;
    this.lobby.classList.remove("in-screen");
    this.focusFirst();
  }

  // ---------------------------------------------------------------- keyboard and hover

  private container(): HTMLElement {
    return this.current ? this.screen : this.nav;
  }

  private items(): HTMLElement[] {
    return Array.from(this.container().querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
  }

  /** Focus the first real choice (not the Back button) so arrows and Enter work immediately. */
  private focusFirst(): void {
    requestAnimationFrame(() => {
      if (this.lobby.hidden) return;
      const list = this.items();
      (list.find((el) => el instanceof HTMLButtonElement && !el.classList.contains("back")) ?? list[0])?.focus({ preventScroll: true });
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (this.lobby.hidden || document.getElementById("help")?.hidden === false || document.getElementById("profile")?.hidden === false) return;
    const t = e.target as HTMLElement | null;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

    if (e.key === "Escape" || (e.key === "Backspace" && !typing)) {
      if (typing) return void t.blur();
      if (this.current) {
        e.preventDefault();
        this.close();
      }
      return;
    }
    // Up/Down still move on from a text field; Left/Right belong to the caret.
    if (typing && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;

    const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
    const backward = e.key === "ArrowUp" || e.key === "ArrowLeft";
    if (forward || backward) {
      e.preventDefault();
      const list = this.items();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = list[i < 0 ? 0 : (i + (forward ? 1 : -1) + list.length) % list.length];
      next.focus({ preventScroll: false });
      this.lastHover = next;
      sfx.hover();
    } else if (e.key === "Enter" && !(t instanceof HTMLButtonElement)) {
      const first = this.items().find((el) => !el.classList.contains("back"));
      if (first) {
        e.preventDefault();
        first.click();
      }
    }
  }

  private onHover(e: PointerEvent): void {
    if (e.pointerType !== "mouse") return;
    const el = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!el || el.disabled || el === this.lastHover) return;
    this.lastHover = el;
    if (el.classList.contains("mitem")) el.focus({ preventScroll: true });
    sfx.hover();
  }

  // ---------------------------------------------------------------- rooms

  private buildRooms(): void {
    this.roomList.replaceChildren(
      ...ROOM_ORDER.map((id) => {
        const t = ROOMS[id];
        const b = document.createElement("button");
        b.className = "room";
        b.dataset.room = id;
        b.style.setProperty("--ra", t.accent);
        b.innerHTML = `<span class="room-preview" style="background:linear-gradient(160deg,${t.swatch[0]} 0%,${t.swatch[0]} 38%,${t.swatch[1]} 38%,${t.swatch[1]} 84%,${t.swatch[2]} 84%)"><i></i></span><span class="room-text"><strong>${t.name}</strong><small>${t.tagline}</small></span><span class="room-state"></span>`;
        return b;
      }),
    );
    this.roomList.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-room]")?.dataset.room as RoomId | undefined;
      if (!id) return;
      sfx.ui();
      this.browsing = this.committed = id;
      this.h.setRoom(id, true);
      this.renderRooms();
    });
  }

  private renderRooms(): void {
    this.roomList.querySelectorAll<HTMLElement>("[data-room]").forEach((el) => {
      const id = el.dataset.room as RoomId;
      el.classList.toggle("sel", id === this.browsing);
      el.querySelector(".room-state")!.textContent = id === this.committed ? "In use" : "";
    });
  }

  // ---------------------------------------------------------------- settings

  private syncMute(): void {
    const el = document.getElementById("muteBtn")!;
    el.innerHTML = isSfxMuted() && isMusicMuted()
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.6 3 2.4-2.4-1.4-1.4-2.4 2.4-2.4-2.4-1.4 1.4 2.4 2.4-2.4 2.4 1.4 1.4 2.4-2.4 2.4 2.4 1.4-1.4-2.4-2.4Z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>';
  }

  private buildSettings(): void {
    const host = document.getElementById("settingsBody")!;
    const seg = (label: string, opts: [string, string][], active: string, on: (v: string) => void) => {
      const row = document.createElement("div");
      row.className = "card setting-card";
      row.innerHTML = `<span class="label">${label}</span><div class="seg"></div>`;
      const box = row.querySelector(".seg")!;
      for (const [v, text] of opts) {
        const b = document.createElement("button");
        b.textContent = text;
        b.className = v === active ? "on" : "";
        b.onclick = () => {
          on(v);
          sfx.ui();
          box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        };
        box.append(b);
      }
      return row;
    };
    const roomRow = document.createElement("div");
    roomRow.className = "card setting-card";
    roomRow.innerHTML = `<span class="label">Room</span><button class="btn ghost wide room-link"></button>`;
    const link = roomRow.querySelector<HTMLButtonElement>(".room-link")!;
    link.textContent = `${ROOMS[this.committed].name}  ›`;
    link.onclick = () => this.open("rooms");

    host.replaceChildren(
      roomRow,
      seg("Effects", [["on", "On"], ["off", "Off"]], isSfxMuted() ? "off" : "on", (v) => { setSfxMuted(v === "off"); this.syncMute(); }),
      seg("Music", [["on", "On"], ["off", "Off"]], isMusicMuted() ? "off" : "on", (v) => { setMusicMuted(v === "off"); this.syncMute(); }),
      seg("Match camera", [["3d", "3D"], ["2d", "Top-down"]], prefs.view3d() ? "3d" : "2d", (v) => prefs.setView3d(v === "3d")),
      seg("Graphics", [["high", "High"], ["low", "Battery saver"]], prefs.quality(), (v) => { prefs.setQuality(v as Quality); this.h.setQuality(v as Quality); }),
    );
  }
}
