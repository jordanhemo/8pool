// Shared helpers for the on-chain scripts: env, clients, and a scripted player (wallet + websocket).
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, getAddress, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WebSocket } from "ws";
import { PLAY_TYPES, bankDomain, type ClientMessage, type ServerMessage } from "@8pool/shared";
import { readEnvKeys } from "../src/chain";

export { formatEther, getAddress };

const KEYS = ["BANK_ADDRESS", "CHAIN_ID", "RPC_URL", "PLAYER1_PRIVATE_KEY", "PLAYER2_PRIVATE_KEY", "RESULT_SIGNER_PRIVATE_KEY"];
export const env = readEnvKeys(readFileSync(new URL("../../../.env", import.meta.url), "utf8"), KEYS);
export const WS_URL = process.env.WS_URL ?? "ws://localhost:8080";
export const TIER = "0.001";

export const bank = getAddress(env.BANK_ADDRESS);
export const chain = { id: Number(env.CHAIN_ID), name: "sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL] } } };
export const reader = createPublicClient({ chain, transport: http(env.RPC_URL) });
export const abi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function settle(bytes32 matchId, address winner, bytes signature)",
  "function refund(bytes32 matchId)",
  "function balanceOf(address) view returns (uint256)",
  "function activeMatch(address) view returns (bytes32)",
  "function matchIdFor(address,address,bytes32) pure returns (bytes32)",
  "function matches(bytes32) view returns (address playerA, address playerB, uint256 stake, uint64 activeAt, uint16 rakeBps, uint8 status)",
]);

export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

export class Player {
  account;
  wallet;
  ws!: WebSocket;
  private inbox: ServerMessage[] = [];
  private waiters: { t: string; resolve: (m: any) => void }[] = [];

  constructor(readonly label: string, pk: string, private wsUrl = WS_URL) {
    this.account = privateKeyToAccount(pk as Hex);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(env.RPC_URL) });
  }

  /** Connect, sign in, and sign the one-time play authorization. */
  async connect(opts: { authorize?: boolean } = {}) {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      const w = this.waiters.findIndex((x) => x.t === m.t);
      if (w >= 0) this.waiters.splice(w, 1)[0].resolve(m);
      else this.inbox.push(m);
    });
    await new Promise<void>((r) => this.ws.once("open", () => r()));
    this.send({ t: "hello", name: this.label });
    await this.next("welcome");
    this.send({ t: "auth_request", address: this.account.address });
    const { message } = await this.next("auth_challenge");
    this.send({ t: "auth", address: this.account.address, signature: await this.account.signMessage({ message }) });
    await this.next("authed");
    log(this.label, "logged in as", this.account.address);
    if (opts.authorize === false) return;

    const req = await this.next("play_auth_request");
    const signature = await this.wallet.signTypedData({
      domain: bankDomain({ chainId: chain.id, bank }),
      types: PLAY_TYPES,
      primaryType: "Play",
      message: { player: this.account.address, maxStake: BigInt(req.maxStakeWei), expiry: BigInt(req.expiry), nonce: BigInt(req.nonce) },
    });
    this.send({ t: "play_auth", maxStake: req.maxStakeWei, expiry: req.expiry, nonce: req.nonce, signature });
    for (;;) if ((await this.next("bankroll")).authorized) break;
    log(this.label, "signed the play authorization (no gas, no popup after this)");
  }

  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }

  next<T extends ServerMessage["t"]>(t: T, ms = 120_000): Promise<Extract<ServerMessage, { t: T }>> {
    const i = this.inbox.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as any);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: timed out waiting for ${t}`)), ms);
      this.waiters.push({ t, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  async tx(fn: "deposit" | "withdraw" | "settle" | "refund", args: any[], value = 0n) {
    const hash = await this.wallet.writeContract({ address: bank, abi, functionName: fn, args, value } as any);
    const rc = await reader.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${this.label}: ${fn} reverted (${hash})`);
    log(this.label, fn, "mined", hash);
    return rc;
  }

  balance = () => reader.readContract({ address: bank, abi, functionName: "balanceOf", args: [this.account.address] });
  walletBalance = () => reader.getBalance({ address: this.account.address });
}

export const bal = async (a: string) => reader.getBalance({ address: a as Hex });
export const status = async (id: string) => (await reader.readContract({ address: bank, abi, functionName: "matches", args: [id as Hex] }) as any)[5] as number;
