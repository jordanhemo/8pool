import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@8pool/shared";

export class Client {
  msgs: ServerMessage[] = [];
  private waiters: { t: string; resolve: (m: any) => void }[] = [];
  ws: WebSocket;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://localhost:${port}`);
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.t === m.t ? (w.resolve(m), false) : true));
    });
  }
  open() {
    return new Promise<void>((r) => this.ws.once("open", () => r()));
  }
  send(m: ClientMessage) {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMessage["t"]>(t: T, timeoutMs = 2000): Promise<Extract<ServerMessage, { t: T }>> {
    const hit = this.msgs.find((m) => m.t === t);
    if (hit) {
      this.msgs.splice(this.msgs.indexOf(hit), 1);
      return Promise.resolve(hit as any);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), timeoutMs);
      this.waiters.push({
        t,
        resolve: (m) => {
          clearTimeout(timer);
          this.msgs.splice(this.msgs.indexOf(m), 1);
          resolve(m);
        },
      });
    });
  }
  close() {
    this.ws.close();
  }
}
