import { formatEther, parseEther } from "viem";

/** ETH/USD spot price from Coinbase's public API, refreshed every few minutes. Shows nothing until it loads. */
const URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
const REFRESH_MS = 5 * 60_000;

let price: number | null = null;
const listeners = new Set<() => void>();

async function load(): Promise<void> {
  try {
    const r = await fetch(URL);
    const amount = Number(((await r.json()) as { data?: { amount?: string } }).data?.amount);
    if (Number.isFinite(amount) && amount > 0) {
      price = amount;
      listeners.forEach((f) => f());
    }
  } catch { /* offline or blocked: keep the last price, or none */ }
}

export function startPriceFeed(): void {
  void load();
  window.setInterval(load, REFRESH_MS);
}

/** Be told when the price first arrives or changes, so labels can re-render. */
export const onPrice = (f: () => void): void => { listeners.add(f); };

export const ethPrice = (): number | null => price;

const money = (usd: number): string =>
  usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "$3.10" for an ETH amount given as a decimal string or wei. Empty until the price is known. */
export function usd(eth: string | bigint): string {
  if (price === null) return "";
  try {
    const n = Number(typeof eth === "bigint" ? formatEther(eth) : formatEther(parseEther(eth)));
    return money(n * price);
  } catch {
    return "";
  }
}

/** USD amount to ETH string for sizing a card purchase, or null when the price is unknown. */
export function usdToEth(dollars: number): string | null {
  return price === null || !(dollars > 0) ? null : (dollars / price).toFixed(6);
}

/** " (≈ $3.10)" suffix, or "" when there is no price yet. */
export const approx = (eth: string | bigint): string => {
  const v = usd(eth);
  return v ? ` (≈ ${v})` : "";
};
