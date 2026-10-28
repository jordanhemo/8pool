import {
  createPublicClient, createWalletClient, custom, defineChain, getAddress, http, parseAbi,
  type Address, type Chain, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { PLAY_TYPES, bankDomain, type ChainInfo } from "@8pool/shared";

const ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function revokeAuthorizations()",
  "function settle(bytes32 matchId, address winner, bytes signature)",
]);

const EXPLORERS: Record<number, string> = { 11155111: "https://sepolia.etherscan.io", 84532: "https://sepolia.basescan.org" };

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...a: any[]) => void): void;
}

/** Thrown when the page has no injected wallet, e.g. regular mobile Chrome, which has no extensions. */
export class NoWalletError extends Error {
  constructor() {
    super("No wallet found. Install MetaMask (or another browser wallet) and reload.");
  }
}

export const isMobileBrowser = (): boolean => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || matchMedia("(pointer: coarse)").matches;

/**
 * Deep links that reopen this page inside a wallet app's own browser, where the wallet is injected.
 * Mobile browsers can't talk to a wallet app directly, so this is how "Connect" reaches the app.
 */
export function walletApps(): { name: string; href: string }[] {
  const url = location.href.split("#")[0];
  const bare = url.replace(/^https?:\/\//, "");
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${bare}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}` },
  ];
}

/** Browser wallet (MetaMask etc.) plus the PoolBank contract calls. */
export class Wallet {
  address: Address | null = null;
  private chain: Chain;
  private provider: Eip1193;
  private wallet: WalletClient;
  private reader: PublicClient;

  constructor(private info: ChainInfo) {
    const eth = (window as any).ethereum as Eip1193 | undefined;
    if (!eth) throw new NoWalletError();
    this.provider = eth;
    this.chain = defineChain({
      id: info.chainId,
      name: info.chainId === 11155111 ? "Sepolia" : `Chain ${info.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [info.rpcUrl] } },
    });
    this.wallet = createWalletClient({ chain: this.chain, transport: custom(eth) });
    this.reader = createPublicClient({ chain: this.chain, transport: http(info.rpcUrl) });
  }

  get bank(): Address {
    return getAddress(this.info.bank);
  }

  txUrl(hash: string): string {
    const base = EXPLORERS[this.info.chainId];
    return base ? `${base}/tx/${hash}` : "";
  }

  /** Ask the wallet for an account and make sure it's on the right network. */
  async connect(): Promise<Address> {
    const [account] = await this.wallet.requestAddresses();
    if (!account) throw new Error("No account selected in the wallet.");
    await this.ensureChain();
    this.address = account;
    return account;
  }

  private async ensureChain(): Promise<void> {
    const hexId = `0x${this.info.chainId.toString(16)}`;
    try {
      await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e: any) {
      if (e?.code === 4902) {
        await this.provider.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hexId, chainName: this.chain.name, rpcUrls: [this.info.rpcUrl], nativeCurrency: this.chain.nativeCurrency }],
        });
      } else {
        throw new Error(`Please switch your wallet to ${this.chain.name} (chain ${this.info.chainId}).`);
      }
    }
  }

  onAccountChange(handler: () => void): void {
    this.provider.on?.("accountsChanged", handler);
    this.provider.on?.("chainChanged", handler);
  }

  signLogin(message: string): Promise<Hex> {
    return this.wallet.signMessage({ account: this.address!, message });
  }

  async balance(): Promise<bigint> {
    return this.reader.getBalance({ address: this.address! });
  }

  /** One gas-free signature that lets the game server lock up to `maxStake` per match until `expiry`. */
  signPlayAuth(maxStake: bigint, expiry: number, nonce: bigint): Promise<Hex> {
    return this.wallet.signTypedData({
      account: this.address!,
      domain: bankDomain(this.info),
      types: PLAY_TYPES,
      primaryType: "Play",
      message: { player: this.address!, maxStake, expiry: BigInt(expiry), nonce },
    });
  }

  /** Each of these resolves with the tx hash once the transaction is mined successfully. */
  deposit(amountWei: bigint, onSent?: (h: Hex) => void): Promise<Hex> {
    return this.send("deposit", [], amountWei, onSent);
  }
  withdraw(amountWei: bigint, onSent?: (h: Hex) => void): Promise<Hex> {
    return this.send("withdraw", [amountWei], 0n, onSent);
  }
  /** Fallback only: the server normally settles for you. */
  settle(bankMatchId: string, winner: string, signature: string, onSent?: (h: Hex) => void): Promise<Hex> {
    return this.send("settle", [bankMatchId as Hex, getAddress(winner), signature as Hex], 0n, onSent);
  }

  private async send(fn: "deposit" | "withdraw" | "settle", args: any[], value: bigint, onSent?: (h: Hex) => void): Promise<Hex> {
    await this.ensureChain();
    const hash = await this.wallet.writeContract({
      account: this.address!,
      chain: this.chain,
      address: this.bank,
      abi: ABI,
      functionName: fn,
      args,
      value,
    } as any);
    onSent?.(hash);
    const receipt = await this.reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction failed on-chain.");
    return hash;
  }
}

/** Wallets reject with verbose errors; show the short human part. */
export function friendlyError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number };
  if (err?.code === 4001 || /user rejected|denied/i.test(err?.message ?? "")) return "You rejected the request in your wallet.";
  return err?.shortMessage ?? err?.message?.split("\n")[0] ?? "Something went wrong.";
}
