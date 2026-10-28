import type { ClientMessage, ServerMessage } from "@8pool/shared";

export type Handler = (m: ServerMessage) => void;
export type NetStatus = "connecting" | "open" | "closed";

const TOKEN_KEY = "8pool.token"; // sessionStorage, so each tab is its own player

const store = {
  get: (k: string) => { try { return sessionStorage.getItem(k) ?? undefined; } catch { return undefined; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

/**
 * Stable id for ranking guests, kept across visits. `?guest=` overrides it so two tabs of one browser can be
 * two players while testing.
 */
function guestId(): string {
  const forced = new URLSearchParams(location.search).get("guest");
  if (forced && /^[\w-]{8,64}$/.test(forced)) return forced;
  try {
    let id = localStorage.getItem("8pool.guest");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("8pool.guest", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** WebSocket wrapper: typed messages, hello on connect, automatic reconnect with the session token. */
export class Net {
  status: NetStatus = "closed";
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<(s: NetStatus) => void>();
  private retry = 0;
  private retryTimer: number | undefined;
  private closedByUs = false;
  private guest = guestId();

  constructor(private url: string, public name: string) {}

  connect(): void {
    this.closedByUs = false;
    window.clearTimeout(this.retryTimer);
    this.setStatus("connecting");
    const ws = (this.ws = new WebSocket(this.url));
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: "hello", name: this.name || undefined, token: store.get(TOKEN_KEY), guest: this.guest } satisfies ClientMessage));
      this.setStatus("open");
    };
    ws.onmessage = (e) => {
      let m: ServerMessage;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "welcome") store.set(TOKEN_KEY, m.token);
      for (const h of [...this.handlers]) h(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setStatus("closed");
      if (!this.closedByUs) {
        this.retryTimer = window.setTimeout(() => this.connect(), Math.min(500 * 2 ** this.retry++, 5000));
      }
    };
  }

  /** Reconnect under a new display name (only takes effect outside a match). */
  rename(name: string): void {
    this.name = name;
    this.closedByUs = true;
    this.ws?.close();
    this.connect();
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  subscribe(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onStatus(h: (s: NetStatus) => void): void {
    this.statusHandlers.add(h);
  }

  private setStatus(s: NetStatus): void {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }
}
