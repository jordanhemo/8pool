import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredResult {
  bankMatchId: string;
  winner: string; // zero address for a void
  signature: string;
  reason: string;
  players: [string, string];
  createdAt: number;
}

/**
 * Signed results not yet settled on-chain (the server settles right away; entries linger only if that
 * failed, e.g. operator out of gas). Retried by the server and offered to the player on login. Persisted
 * to a JSON file so a restart doesn't lose them.
 */
export class ResultStore {
  private items: StoredResult[] = [];

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      try {
        // Entries from the old escrow contract (no bankMatchId) can never be settled here.
        this.items = (JSON.parse(readFileSync(file, "utf8")) as StoredResult[]).filter((r) => typeof r.bankMatchId === "string");
      } catch {
        this.items = [];
      }
    }
  }

  add(r: StoredResult): void {
    this.items = this.items.filter((i) => i.bankMatchId !== r.bankMatchId).concat(r);
    this.save();
  }

  all(): StoredResult[] {
    return [...this.items];
  }

  forAddress(address: string): StoredResult[] {
    const a = address.toLowerCase();
    return this.items.filter((r) => r.players.some((p) => p.toLowerCase() === a));
  }

  remove(bankMatchId: string): void {
    this.items = this.items.filter((i) => i.bankMatchId !== bankMatchId);
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    renameSync(tmp, this.file); // atomic replace
  }
}
