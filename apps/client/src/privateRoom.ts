import { formatEther, parseEther } from "viem";
import { PRIVATE_CODE_LEN, PRIVATE_MAX_STAKE, PRIVATE_MIN_STAKE, isStakeString, normalizeCode, type ServerMessage } from "@8pool/shared";
import { sfx, unlockAudio } from "./audio";
import { esc } from "./rankui";
import { approx } from "./usd";

export interface PrivateHandlers {
  onCreate(stake: string): void;
  onJoin(code: string): void;
  onCancel(): void;
  /** Surface a validation problem (shown in the menu's status line). */
  onError(msg: string): void;
}

const PRESETS = ["0.001", "0.01", "0.05"];
type State = Extract<ServerMessage, { t: "private_state" }>;

/** Private room: create a table with your own stake and share the code, or join a friend's. Friendly matches aren't rated. */
export class PrivateRoomUI {
  private form = document.getElementById("pvForm")!;
  private wait = document.getElementById("pvWait")!;
  private stakeInput = document.getElementById("pvStake") as HTMLInputElement;
  private stakeRow = document.getElementById("pvStakeRow")!;
  private presets = document.getElementById("pvPresets")!;
  private hint = document.getElementById("pvCreateHint")!;
  private createBtn = document.getElementById("pvCreate") as HTMLButtonElement;
  private codeInput = document.getElementById("pvCode") as HTMLInputElement;
  private joinBtn = document.getElementById("pvJoin") as HTMLButtonElement;
  private chainMode = false;
  private connected = false;
  private state: State | null = null;
  private max = PRIVATE_MAX_STAKE;

  constructor(private h: PrivateHandlers) {
    this.presets.replaceChildren(
      ...PRESETS.map((v) => {
        const b = document.createElement("button");
        b.className = "chip-btn";
        b.textContent = v;
        b.onclick = () => { sfx.ui(); this.stakeInput.value = v; this.syncHint(); };
        return b;
      }),
    );
    this.stakeInput.addEventListener("input", () => this.syncHint());
    this.createBtn.onclick = () => this.create();
    this.joinBtn.onclick = () => this.join();
    this.codeInput.addEventListener("input", () => {
      this.codeInput.value = normalizeCode(this.codeInput.value);
      this.joinBtn.disabled = !this.canJoin();
    });
    this.codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && this.canJoin()) this.join(); });
    this.stakeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") this.create(); });
    document.getElementById("pvCancel")!.onclick = () => { sfx.ui(); h.onCancel(); };
    document.getElementById("pvCopyCode")!.onclick = () => this.copy(this.state?.code ?? "", "Code copied");
    document.getElementById("pvCopyLink")!.onclick = () => this.copy(this.link(), "Invite link copied");
    document.getElementById("pvShare")!.onclick = () => void this.share();
    this.render();
  }

  refreshPrices(): void { this.render(); }
  setChainMode(on: boolean): void { this.chainMode = on; this.render(); }
  setConnected(c: boolean): void { this.connected = c; this.render(); }
  setState(s: State | null): void { this.state = s; this.render(); }
  prefill(code: string): void { this.codeInput.value = normalizeCode(code); this.render(); }
  get waiting(): boolean { return this.state !== null; }

  private link(): string {
    return `${location.origin}${location.pathname}?join=${this.state?.code ?? ""}`;
  }

  private canJoin(): boolean { return this.connected && this.codeInput.value.length === PRIVATE_CODE_LEN; }

  private stake(): string | null {
    const v = this.stakeInput.value.trim();
    if (!isStakeString(v)) return null;
    try {
      const w = parseEther(v);
      return w >= parseEther(PRIVATE_MIN_STAKE) && w <= parseEther(this.max) ? formatEther(w) : null;
    } catch {
      return null;
    }
  }

  private create(): void {
    unlockAudio();
    sfx.ui();
    if (!this.chainMode) return this.h.onCreate("0.01"); // free server: the amount is only a label
    const s = this.stake();
    if (!s) return this.h.onError(`Enter a stake between ${PRIVATE_MIN_STAKE} and ${this.max} ETH.`);
    this.h.onCreate(s);
  }

  private join(): void {
    unlockAudio();
    sfx.ui();
    this.h.onJoin(this.codeInput.value);
  }

  private syncHint(): void {
    const s = this.stake();
    this.hint.textContent = !this.chainMode
      ? "Free play. Share the code and your friend can join straight away."
      : s
        ? `You each put up ${s} ETH${approx(s)}. The winner takes ${formatEther(parseEther(s) * 2n)} ETH${approx(formatEther(parseEther(s) * 2n))}.`
        : `Pick a stake from ${PRIVATE_MIN_STAKE} to ${this.max} ETH.`;
    this.createBtn.disabled = !this.connected || (this.chainMode && !s);
    this.presets.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.textContent === this.stakeInput.value.trim()));
  }

  private render(): void {
    const s = this.state;
    this.form.hidden = s !== null;
    this.wait.hidden = s === null;
    this.stakeRow.hidden = !this.chainMode;
    this.syncHint();
    this.joinBtn.disabled = !this.canJoin();
    if (!s) return;
    document.getElementById("pvCode")!.blur?.();
    document.getElementById("pvCodeTiles")!.innerHTML = [...s.code].map((c) => `<i>${esc(c)}</i>`).join("");
    document.getElementById("pvStakeLine")!.textContent = this.chainMode ? `Stake: ${s.stake} ETH${approx(s.stake)} each · winner takes ${formatEther(parseEther(s.stake) * 2n)} ETH` : "Free play · friendly match";
    const status = document.getElementById("pvStatus")!;
    status.innerHTML = s.guest
      ? `<strong>${esc(s.guest)} joined</strong><span>Starting the match…</span>`
      : `<strong>Waiting for a friend…</strong><span>Share the code or link below. Rankings aren't affected.</span>`;
    (document.getElementById("pvShare") as HTMLElement).hidden = typeof navigator.share !== "function";
  }

  private async copy(text: string, done: string): Promise<void> {
    sfx.ui();
    try {
      await navigator.clipboard.writeText(text);
      this.h.onError(done);
    } catch {
      this.h.onError(`Copy this: ${text}`);
    }
  }

  private async share(): Promise<void> {
    try {
      await navigator.share({ title: "8 Ball Pool", text: `Join my 8 Ball Pool room: ${this.state?.code}`, url: this.link() });
    } catch { /* cancelled */ }
  }
}
