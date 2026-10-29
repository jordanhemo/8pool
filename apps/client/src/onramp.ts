import type { ChainInfo } from "@8pool/shared";

/**
 * Buy ETH with a card through Transak's hosted checkout. It sends the ETH to the player's own wallet; from
 * there "Add funds" moves it into the game balance. Needs a (public) Transak API key at build time.
 */
const KEY = import.meta.env.VITE_TRANSAK_API_KEY;

const NETWORKS: Record<number, string> = { 1: "ethereum", 10: "optimism", 137: "polygon", 8453: "base", 42161: "arbitrum", 11155111: "sepolia", 84532: "basesepolia" };
const MAINNETS = new Set([1, 10, 137, 8453, 42161]);

export const cardPurchaseEnabled = (): boolean => !!KEY;

export function buyWithCard(address: string, chain: ChainInfo, dollars: number): void {
  if (!KEY) throw new Error("Card payments aren't set up for this game yet.");
  const live = MAINNETS.has(chain.chainId);
  const p = new URLSearchParams({
    apiKey: KEY,
    environment: live ? "PRODUCTION" : "STAGING",
    productsAvailed: "BUY",
    cryptoCurrencyCode: "ETH",
    fiatCurrency: "USD",
    defaultFiatAmount: String(Math.round(dollars)),
    walletAddress: address,
    disableWalletAddressForm: "true",
    themeColor: "2fcf8a",
  });
  const net = NETWORKS[chain.chainId];
  if (net) p.set("network", net);
  const host = live ? "global.transak.com" : "global-stg.transak.com";
  window.open(`https://${host}/?${p}`, "_blank", "noopener");
}
