export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

/** Floating status panel above both the lobby and the game: deposits, claims, errors. */
export class Toast {
  private el = document.getElementById("toast")!;
  private text = this.el.querySelector<HTMLElement>(".text")!;
  private actions = this.el.querySelector<HTMLElement>(".actions")!;

  private timer: number | undefined;

  /** `autoHideMs`: dismiss on its own, unless another message replaced this one first. */
  show(message: string, actions: ToastAction[] = [], link?: { label: string; href: string }, autoHideMs?: number): void {
    window.clearTimeout(this.timer);
    this.text.replaceChildren(document.createTextNode(message));
    if (link?.href) {
      const a = document.createElement("a");
      a.href = link.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = ` ${link.label}`;
      this.text.append(a);
    }
    this.actions.replaceChildren(
      ...actions.map((act) => {
        const b = document.createElement("button");
        b.textContent = act.label;
        b.onclick = async () => {
          b.disabled = true;
          try { await act.run(); } finally { b.disabled = false; }
        };
        return b;
      }),
    );
    this.el.hidden = false;
    if (autoHideMs) this.timer = window.setTimeout(() => this.hide(), autoHideMs);
  }

  hide(): void {
    this.el.hidden = true;
  }
}
