import { formatEther, parseEther } from "viem";
import { TOURNAMENT_SIZE, type TournamentView, type Venue } from "@8pool/shared";
import { sfx, unlockAudio } from "./audio";
import { ROOMS, RoomId } from "./game3d/rooms";
import { rankName } from "./rankui";
import { approx, ethPrice, usd, usdToEth } from "./usd";
import { cardPurchaseEnabled } from "./onramp";

export interface LobbyHandlers {
  onQueue(tier: string): void;
  onCancel(): void;
  onPractice(): void;
  onRename(name: string): void;
  onConnectWallet(): void;
  onAddFunds(amountEth: string): void;
  onWithdraw(): void;
  onTournamentJoin(venue: string): void;
  onTournamentLeave(): void;
  onTournamentClose(): void;
  /** Open the card checkout for this many US dollars. */
  onBuyWithCard(dollars: number): void;
}

/** Re-render a container while keeping keyboard focus on the same logical item. */
function keepFocus(container: HTMLElement, key: string, render: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  const had = active && container.contains(active) ? active.dataset[key] : undefined;
  render();
  if (had !== undefined) container.querySelector<HTMLElement>(`[data-${key}="${CSS.escape(had)}"]:not(:disabled)`)?.focus({ preventScroll: true });
}

/** HTML overlay shown before and between matches. */
export class Lobby {
  private el = document.getElementById("lobby")!;
  private nameInput = this.el.querySelector<HTMLInputElement>("#name")!;
  private walletRow = this.el.querySelector<HTMLElement>("#walletRow")!;
  private connectBtn = this.el.querySelector<HTMLButtonElement>("#connect")!;
  private walletLabel = this.el.querySelector<HTMLElement>("#wallet")!;
  private bankRow = this.el.querySelector<HTMLElement>("#bankRow")!;
  private balanceEl = this.el.querySelector<HTMLElement>("#balance")!;
  private amountInput = this.el.querySelector<HTMLInputElement>("#amount")!;
  private addBtn = this.el.querySelector<HTMLButtonElement>("#addFunds")!;
  private withdrawBtn = this.el.querySelector<HTMLButtonElement>("#withdraw")!;
  private tiersEl = this.el.querySelector<HTMLElement>("#tiers")!;
  private statusEl = this.el.querySelector<HTMLElement>("#status")!;
  private cancelBtn = this.el.querySelector<HTMLButtonElement>("#cancel")!;
  private searchEl = this.el.querySelector<HTMLElement>("#searching")!;
  private searchTime = this.el.querySelector<HTMLElement>("#searchTime")!;
  private avatarEl = this.el.querySelector<HTMLElement>("#meAvatar")!;
  private topConnect = this.el.querySelector<HTMLButtonElement>("#topConnect")!;
  private chipName = this.el.querySelector<HTMLElement>("#chipName")!;
  private chipSub = this.el.querySelector<HTMLElement>("#chipSub")!;
  private balanceTop = this.el.querySelector<HTMLElement>("#balanceTop")!;
  private balanceSub = this.el.querySelector<HTMLElement>("#balanceSub")!;
  private amountUsd = this.el.querySelector<HTMLElement>("#amountUsd")!;
  private cardUsd = this.el.querySelector<HTMLInputElement>("#cardUsd")!;
  private cardHint = this.el.querySelector<HTMLElement>("#cardHint")!;
  private buyCardBtn = this.el.querySelector<HTMLButtonElement>("#buyCard")!;
  private topAdd = this.el.querySelector<HTMLElement>("#topAdd")!;
  private walletOff = this.el.querySelector<HTMLElement>("#walletOff")!;
  private practiceBtn = this.el.querySelector<HTMLButtonElement>("#practice")!;
  private venuesEl = this.el.querySelector<HTMLElement>("#venues")!;
  private tLobbyEl = this.el.querySelector<HTMLElement>("#tLobby")!;
  private tLobbyText = this.el.querySelector<HTMLElement>("#tLobbyText")!;
  private tLeaveBtn = this.el.querySelector<HTMLButtonElement>("#tLeave")!;
  private bracketEl = this.el.querySelector<HTMLElement>("#bracket")!;
  private searchStart = 0;
  private searchTimer: number | undefined;
  private tiers: string[] = [];
  private venues: Venue[] = [];
  private connected = false;
  private queued: string | null = null;
  private tLobby: { venue: string; joined: number; size: number } | null = null;
  private tournament: TournamentView | null = null;
  private error = "";
  private rating: number | null = null;
  private chainMode = false;
  private address: string | null = null;
  private busy = false; // stakes are being locked
  private bank: { balance: bigint; authorized: boolean; inMatch: boolean } | null = null;

  constructor(private handlers: LobbyHandlers, initialName: string) {
    this.nameInput.value = initialName;
    this.nameInput.addEventListener("change", () => handlers.onRename(this.nameInput.value.trim()));
    this.nameInput.addEventListener("input", () => this.renderAvatar());
    this.cancelBtn.onclick = () => handlers.onCancel();
    this.practiceBtn.onclick = () => { sfx.ui(); handlers.onPractice(); };
    this.connectBtn.onclick = () => handlers.onConnectWallet();
    this.topConnect.onclick = () => handlers.onConnectWallet();
    this.addBtn.onclick = () => handlers.onAddFunds(this.amountInput.value.trim());
    this.withdrawBtn.onclick = () => handlers.onWithdraw();
    this.tLeaveBtn.onclick = () => handlers.onTournamentLeave();
    this.amountInput.addEventListener("input", () => this.renderUsd());
    this.cardUsd.addEventListener("input", () => this.renderUsd());
    this.buyCardBtn.onclick = () => handlers.onBuyWithCard(Number(this.cardUsd.value.replace(/[^\d.]/g, "")));
    this.tiersEl.addEventListener("click", (e) => {
      const tier = (e.target as HTMLElement).closest<HTMLElement>("[data-tier]")?.dataset.tier;
      if (tier) {
        unlockAudio();
        sfx.ui();
        handlers.onQueue(tier);
      }
    });
    this.venuesEl.addEventListener("click", (e) => {
      const venue = (e.target as HTMLElement).closest<HTMLElement>("[data-venue]")?.dataset.venue;
      if (venue) {
        unlockAudio();
        sfx.ui();
        handlers.onTournamentJoin(venue);
      }
    });
    this.render();
  }

  show(): void { this.el.hidden = false; }
  hide(): void { this.el.hidden = true; }

  private renderAvatar(): void {
    const n = this.nameInput.value.trim() || this.nameInput.placeholder.trim();
    this.avatarEl.textContent = (n[0] ?? "?").toUpperCase();
    this.chipName.textContent = n || "Player";
  }

  private potOf(tier: string): string {
    try { return formatEther(parseEther(tier) * 2n); } catch { return ""; }
  }

  private tournamentPot(buyIn: string): string {
    try { return formatEther(parseEther(buyIn) * BigInt(TOURNAMENT_SIZE)); } catch { return ""; }
  }

  setTiers(tiers: string[], assignedName: string): void {
    this.tiers = tiers;
    if (!this.nameInput.value) this.nameInput.placeholder = assignedName;
    this.render();
  }
  setVenues(venues: Venue[]): void { this.venues = venues; this.render(); }
  setConnected(c: boolean): void { this.connected = c; this.render(); }
  setQueued(tier: string | null): void { this.queued = tier; this.error = ""; this.render(); }
  setError(msg: string): void { this.error = msg; this.render(); }
  setChainMode(on: boolean): void { this.chainMode = on; this.render(); }
  setWallet(address: string | null): void { this.address = address; this.error = ""; this.render(); }
  setBusy(b: boolean): void { this.busy = b; this.render(); }
  setBankroll(b: { balance: bigint; authorized: boolean; inMatch: boolean } | null): void { this.bank = b; this.error = ""; this.render(); }
  setTournamentLobby(l: { venue: string; joined: number; size: number } | null): void { this.tLobby = l; this.error = ""; this.render(); }
  setTournament(v: TournamentView | null): void { this.tournament = v; this.render(); }
  /** The player's rating once they have a ranked record; shown under their name. */
  /** The ETH/USD price loaded or changed. */
  refreshPrices(): void { this.render(); }
  setRating(r: number | null): void { this.rating = r; this.render(); }

  private render(): void {
    const bank = this.bank;
    const funded = (eth: string) => !this.chainMode || (bank !== null && bank.balance >= parseEther(eth) && !bank.inMatch);
    const idle = this.queued === null && this.tLobby === null && !this.busy && !this.aliveInBracket();
    const canPlay = this.connected && idle && (!this.chainMode || this.address !== null);

    keepFocus(this.tiersEl, "tier", () =>
      this.tiersEl.replaceChildren(
        ...this.tiers.map((t) => {
          const b = document.createElement("button");
          b.className = "tier";
          b.dataset.tier = t;
          const info = document.createElement("span");
          const stake = document.createElement("span");
          stake.className = "stake";
          stake.textContent = this.chainMode ? `${t} ETH${usd(t) ? ` · ${usd(t)}` : ""}` : `${t} table`;
          const sub = document.createElement("small");
          sub.className = "pot-line";
          sub.textContent = this.chainMode ? `Winner takes ${this.potOf(t)} ETH${approx(this.potOf(t))}` : "Ranked match";
          info.append(stake, sub);
          const go = document.createElement("span");
          go.className = "go";
          go.textContent = "PLAY";
          b.append(info, go);
          b.disabled = !canPlay || !funded(t);
          return b;
        }),
      ),
    );

    // Tournament: venue list, or the waiting lobby, or the bracket.
    const showBracket = this.tournament !== null;
    const showWaiting = !showBracket && this.tLobby !== null;
    const tCanJoin = this.connected && idle && (!this.chainMode || this.address !== null);
    this.venuesEl.hidden = showBracket || showWaiting;
    this.tLobbyEl.hidden = !showWaiting;
    this.bracketEl.hidden = !showBracket;
    keepFocus(this.venuesEl, "venue", () =>
      this.venuesEl.replaceChildren(
        ...this.venues.map((v) => {
          const room = ROOMS[v.id as RoomId];
          const b = document.createElement("button");
          b.className = "venue";
          b.dataset.venue = v.id;
          if (room) b.style.setProperty("--ra", room.accent);
          const sw = room?.swatch ?? ["#222", "#146b45", "#7d4a24"];
          b.innerHTML =
            `<span class="room-preview" style="background:linear-gradient(160deg,${sw[0]} 0%,${sw[0]} 38%,${sw[1]} 38%,${sw[1]} 84%,${sw[2]} 84%)"></span>` +
            `<span class="venue-text"><strong></strong><small></small></span>` +
            `<span class="venue-pot"><b></b><small>POT</small></span>`;
          b.querySelector("strong")!.textContent = v.name;
          b.querySelector(".venue-text small")!.textContent = this.chainMode ? `Buy-in ${v.buyIn} ETH${approx(v.buyIn)}` : "Free entry";
          b.querySelector(".venue-pot small")!.textContent = this.chainMode ? "POT" : "KNOCKOUT";
          b.querySelector(".venue-pot b")!.textContent = this.chainMode ? `${usd(this.tournamentPot(v.buyIn)) || `${this.tournamentPot(v.buyIn)} ETH`}` : `${TOURNAMENT_SIZE} players`;
          b.disabled = !tCanJoin || !funded(v.buyIn);
          return b;
        }),
      ),
    );
    if (showWaiting && this.tLobby) {
      const v = this.venues.find((x) => x.id === this.tLobby!.venue);
      this.tLobbyText.textContent = `${v?.name ?? "Tournament"}: ${this.tLobby.joined} / ${this.tLobby.size} players`;
    }
    if (this.tournament) this.renderBracket(this.tournament);

    this.renderAvatar();
    this.searchEl.hidden = this.queued === null;
    if (this.queued !== null && this.searchTimer === undefined) {
      this.searchStart = Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - this.searchStart) / 1000);
        this.searchTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      };
      tick();
      this.searchTimer = window.setInterval(tick, 1000);
    } else if (this.queued === null && this.searchTimer !== undefined) {
      window.clearInterval(this.searchTimer);
      this.searchTimer = undefined;
    }
    this.walletRow.hidden = !this.chainMode;
    this.walletOff.hidden = this.chainMode;
    this.topConnect.hidden = !this.chainMode || this.address !== null;
    this.topAdd.hidden = !this.chainMode || this.address === null;
    this.chipSub.textContent = this.rating !== null ? `${rankName(this.rating)} · ${this.rating}` : this.address ? `${this.address.slice(0, 6)}…${this.address.slice(-4)}` : this.chainMode ? "Wallet not connected" : "Guest";
    this.balanceTop.textContent = !this.chainMode ? "Free play" : this.bank ? `${Number(formatEther(this.bank.balance)).toFixed(4)} ETH` : this.address ? "…" : "—";
    this.balanceSub.textContent = this.chainMode && this.bank && usd(this.bank.balance) ? `Balance · ≈ ${usd(this.bank.balance)}` : "Balance";
    this.renderUsd();
    this.connectBtn.hidden = this.address !== null;
    this.walletLabel.textContent = this.address ? `${this.address.slice(0, 6)}…${this.address.slice(-4)}` : "";
    this.bankRow.hidden = !(this.chainMode && this.address);
    if (bank) {
      this.balanceEl.replaceChildren(document.createTextNode(`Balance: ${formatEther(bank.balance)} ETH${approx(bank.balance)}`));
      const note = document.createElement("small");
      note.textContent = bank.inMatch ? "A stake is locked in a running match." : bank.authorized ? "Ready: no wallet popups while you play." : "Approve play to start (one signature).";
      this.balanceEl.append(note);
    } else {
      this.balanceEl.textContent = "Loading balance…";
    }
    this.withdrawBtn.disabled = !bank || bank.balance === 0n;
    const cheapest = this.tiers[0];
    this.statusEl.textContent = this.error
      ? this.error
      : !this.connected
        ? "Connecting to server…"
        : this.busy
          ? "Match found — locking the stakes…"
          : this.chainMode && !this.address
            ? "Connect your wallet to play for stakes."
            : this.chainMode && bank && cheapest && bank.balance < parseEther(cheapest) && !bank.inMatch
              ? "Add funds to your balance to play."
              : "";
  }

  private renderUsd(): void {
    const amt = this.amountInput.value.trim();
    this.amountUsd.textContent = usd(amt) ? `${amt} ETH ≈ ${usd(amt)}` : "";
    const dollars = Number(this.cardUsd.value.replace(/[^\d.]/g, ""));
    const eth = usdToEth(dollars);
    this.cardHint.textContent = !cardPurchaseEnabled()
      ? "Card payments aren't enabled yet."
      : eth
        ? `About ${eth} ETH at $${Math.round(ethPrice()!).toLocaleString("en-US")}/ETH, sent to your wallet. Then tap Add funds.`
        : "Pay with a card; the ETH is sent to your wallet. Then tap Add funds.";
    this.buyCardBtn.disabled = !(dollars > 0);
  }

  /** True while the player is still alive in a bracket that hasn't finished. */
  private aliveInBracket(): boolean {
    const t = this.tournament;
    if (!t || t.stage === "done") return false;
    if (t.stage === "semis") return true;
    return t.semiWinners.includes(t.you);
  }

  // ---------------------------------------------------------------- bracket

  private renderBracket(t: TournamentView): void {
    const venue = this.venues.find((v) => v.id === t.venue);
    const room = ROOMS[t.venue as RoomId];
    if (room) this.bracketEl.style.setProperty("--ra", room.accent);
    const slot = (idx: number | null, label: string, state: "win" | "out" | "live" | "wait") => {
      const el = document.createElement("div");
      el.className = `slot ${state}${idx !== null && idx === t.you ? " me" : ""}`;
      const dot = document.createElement("i");
      const name = document.createElement("span");
      name.textContent = idx === null ? label : t.slots[idx];
      el.append(dot, name);
      if (idx !== null && idx === t.you) {
        const you = document.createElement("em");
        you.textContent = "YOU";
        el.append(you);
      }
      return el;
    };
    const semiState = (i: number): "win" | "out" | "live" => {
      const w = t.semiWinners[Math.floor(i / 2)];
      return w === null ? "live" : w === i ? "win" : "out";
    };
    const finalState = (w: number | null): "win" | "out" | "live" | "wait" => {
      if (w === null) return "wait";
      if (t.champion !== null) return t.champion === w ? "win" : "out";
      return t.stage === "final" ? "live" : "wait";
    };

    const col = (cls: string, ...kids: HTMLElement[]) => {
      const c = document.createElement("div");
      c.className = `bk-col ${cls}`;
      c.append(...kids);
      return c;
    };
    const semis = col("semis", ...[0, 1, 2, 3].map((i) => slot(i, "", semiState(i))));
    const finals = col("fin", ...[0, 1].map((k) => slot(t.semiWinners[k], `Winner of semifinal ${k + 1}`, finalState(t.semiWinners[k]))));
    const champ = col("champ", slot(t.champion, "Champion", t.champion !== null ? "win" : "wait"));

    const head = document.createElement("div");
    head.className = "bk-head";
    head.innerHTML = `<strong></strong><span></span>`;
    head.querySelector("strong")!.textContent = venue?.name ?? "Tournament";
    head.querySelector("span")!.textContent = this.chainMode ? `Pot ${t.pot} ETH` : "Free entry";

    const labels = document.createElement("div");
    labels.className = "bk-labels";
    labels.innerHTML = "<span>Semifinals</span><span>Final</span><span>Champion</span>";

    const grid = document.createElement("div");
    grid.className = "bk-grid";
    grid.append(semis, finals, champ);

    const out = t.stage !== "done" && !this.aliveInBracket();
    const note = document.createElement("p");
    note.className = "bk-note";
    note.textContent =
      t.note ??
      (t.stage === "semis" ? "Semifinals are in progress." : t.stage === "final" ? "The final is next." : "");
    const status = document.createElement("p");
    status.className = "bk-status";
    status.textContent =
      t.stage === "done"
        ? t.champion === t.you ? "You are the champion!" : "The tournament is over."
        : out
          ? "You're out. You can keep watching the bracket."
          : t.stage === "semis"
            ? "Your match starts automatically."
            : "Your final starts automatically.";

    const stakes = document.createElement("p");
    stakes.className = "bk-stakes";
    stakes.textContent = this.chainMode ? `Semifinals stake ${t.buyIn} ETH each. The final stakes ${t.finalStake} ETH each, so the champion takes the whole ${t.pot} ETH pot.` : "";

    const close = document.createElement("button");
    close.className = "btn ghost small";
    close.textContent = t.stage === "done" ? "Done" : "Hide bracket";
    close.onclick = () => this.handlers.onTournamentClose();

    this.bracketEl.replaceChildren(head, labels, grid, note, status, stakes, close);
  }
}
