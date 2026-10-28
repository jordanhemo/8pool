import {
  createPublicClient, createWalletClient, defineChain, encodeAbiParameters, getAddress, http, isAddressEqual, keccak256,
  parseEther, recoverMessageAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PLAY_TYPES, RESULT_TYPES, bankDomain, type ChainInfo } from "@8pool/shared";

/** Mirrors PoolBank.Status. */
export const MatchStatus = { None: 0, Active: 1, Settled: 2, Cancelled: 3 } as const;
export type MatchStatus = (typeof MatchStatus)[keyof typeof MatchStatus];

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A player's signed permission to lock up to `maxStake` per match until `expiry`. */
export interface PlayAuth {
  maxStake: bigint;
  expiry: number;
  nonce: bigint;
  signature: string;
}

export interface Bankroll {
  balance: bigint;
  /** True while the player's stake sits in a running match. */
  inMatch: boolean;
}

/** Everything the server needs from the chain. Tests supply a fake. */
export interface Chain {
  info: ChainInfo;
  stakeWei(tier: string): bigint;
  matchIdFor(playerA: string, playerB: string, salt: string): string;
  getStatus(matchId: string): Promise<MatchStatus>;
  getBankroll(player: string): Promise<Bankroll>;
  /** The nonce a new `Play` signature must carry (bumped by `revokeAuthorizations`). */
  authNonce(player: string): Promise<bigint>;
  /** True if `signature` is `player`'s valid `Play` signature (EOAs and ERC-1271 wallets). */
  verifyPlayAuth(player: string, auth: PlayAuth): Promise<boolean>;
  /** Locks both stakes on-chain; resolves once the transaction is confirmed, rejects if it reverts. */
  startMatch(args: { playerA: string; playerB: string; stake: bigint; salt: string; authA: PlayAuth; authB: PlayAuth }): Promise<{ matchId: string; txHash: string }>;
  /** Submits a signed result; resolves once confirmed. Winner = zero address voids the match. */
  settle(matchId: string, winner: string, signature: string): Promise<string>;
  /** EIP-712 signature over Result(matchId, winner). */
  signResult(matchId: string, winner: string): Promise<string>;
  /** Address that signed an EIP-191 message. */
  recoverLogin(message: string, signature: string): Promise<string>;
  /** Operator gas balance in wei, for the health check. */
  operatorBalance(): Promise<bigint>;
}

const AUTH_COMPONENTS = [
  { name: "maxStake", type: "uint256" },
  { name: "expiry", type: "uint256" },
  { name: "signature", type: "bytes" },
] as const;

const BANK_ABI = [
  {
    type: "function", name: "matches", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "playerA", type: "address" }, { name: "playerB", type: "address" }, { name: "stake", type: "uint256" },
      { name: "activeAt", type: "uint64" }, { name: "rakeBps", type: "uint16" }, { name: "status", type: "uint8" },
    ],
  },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "activeMatch", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "authNonce", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "startMatch", stateMutability: "nonpayable",
    inputs: [
      { name: "playerA", type: "address" }, { name: "playerB", type: "address" }, { name: "stake", type: "uint256" }, { name: "salt", type: "bytes32" },
      { name: "authA", type: "tuple", components: AUTH_COMPONENTS }, { name: "authB", type: "tuple", components: AUTH_COMPONENTS },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function", name: "settle", stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "bytes32" }, { name: "winner", type: "address" }, { name: "signature", type: "bytes" }],
    outputs: [],
  },
] as const;

export interface ChainConfig {
  chainId: number;
  bank: string;
  rpcUrl: string;
  /** Signs results and sends the match-start / settle transactions (holds gas only, never player funds). */
  signerPrivateKey: string;
}

export function createChain(cfg: ChainConfig): Chain {
  const bank = getAddress(cfg.bank);
  const account = privateKeyToAccount(cfg.signerPrivateKey as Hex);
  const chainDef = defineChain({
    id: cfg.chainId,
    name: `chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const pub = createPublicClient({ chain: chainDef, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain: chainDef, transport: http(cfg.rpcUrl) });
  const info: ChainInfo = { chainId: cfg.chainId, bank, rpcUrl: cfg.rpcUrl };

  // One operator key means one nonce sequence: send transactions strictly one after another.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };

  const send = (functionName: "startMatch" | "settle", args: readonly unknown[]) =>
    serial(async () => {
      const hash = await wallet.writeContract({ address: bank, abi: BANK_ABI, functionName, args } as never);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
      return hash as string;
    });

  const authTuple = (a: PlayAuth) => ({ maxStake: a.maxStake, expiry: BigInt(a.expiry), signature: a.signature as Hex });
  const matchIdFor = (a: string, b: string, salt: string) =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }], [getAddress(a), getAddress(b), salt as Hex]));

  return {
    info,
    stakeWei: (tier) => parseEther(tier),
    matchIdFor,
    async getStatus(id) {
      const m = await pub.readContract({ address: bank, abi: BANK_ABI, functionName: "matches", args: [id as Hex] });
      return m[5] as MatchStatus;
    },
    async getBankroll(player) {
      const p = getAddress(player);
      const [balance, active] = await Promise.all([
        pub.readContract({ address: bank, abi: BANK_ABI, functionName: "balanceOf", args: [p] }),
        pub.readContract({ address: bank, abi: BANK_ABI, functionName: "activeMatch", args: [p] }),
      ]);
      return { balance, inMatch: BigInt(active) !== 0n };
    },
    authNonce: (player) => pub.readContract({ address: bank, abi: BANK_ABI, functionName: "authNonce", args: [getAddress(player)] }),
    verifyPlayAuth: (player, a) =>
      pub
        .verifyTypedData({
          address: getAddress(player),
          domain: bankDomain(info),
          types: PLAY_TYPES,
          primaryType: "Play",
          message: { player: getAddress(player), maxStake: a.maxStake, expiry: BigInt(a.expiry), nonce: a.nonce },
          signature: a.signature as Hex,
        })
        .catch(() => false),
    async startMatch({ playerA, playerB, stake, salt, authA, authB }) {
      const txHash = await send("startMatch", [getAddress(playerA), getAddress(playerB), stake, salt as Hex, authTuple(authA), authTuple(authB)]);
      return { matchId: matchIdFor(playerA, playerB, salt), txHash };
    },
    settle: (id, winner, signature) => send("settle", [id as Hex, getAddress(winner), signature as Hex]),
    signResult: (id, winner) =>
      account.signTypedData({
        domain: bankDomain(info),
        types: RESULT_TYPES,
        primaryType: "Result",
        message: { matchId: id as Hex, winner: getAddress(winner) },
      }),
    recoverLogin: (message, signature) => recoverMessageAddress({ message, signature: signature as Hex }),
    operatorBalance: () => pub.getBalance({ address: account.address }),
  };
}

export const sameAddress = (a: string, b: string) => isAddressEqual(getAddress(a), getAddress(b));

/** Read only the named keys from a .env file, so unrelated secrets never enter this process. */
export function readEnvKeys(text: string, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && keys.includes(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
