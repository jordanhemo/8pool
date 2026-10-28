// DEV ONLY. Replaces window.ethereum with a provider that signs with a throwaway test key, so the real client
// wallet code can be exercised in a browser without MetaMask. Enabled by ?devwallet=1|2 under `vite dev`;
// compiled out of production builds (see the import.meta.env.DEV guard in main.ts).
import { createWalletClient, hexToString, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function installDevWallet(which: string): void {
  const pk = (which === "2" ? import.meta.env.VITE_DEV_KEY_2 : import.meta.env.VITE_DEV_KEY_1) as string | undefined;
  if (!pk) {
    console.warn("[devWallet] no VITE_DEV_KEY_* in apps/client/.env.local");
    return;
  }
  const account = privateKeyToAccount(pk as Hex);
  const rpcUrl = import.meta.env.VITE_DEV_RPC_URL as string;
  const chainId = Number(import.meta.env.VITE_DEV_CHAIN_ID);
  const chain = { id: chainId, name: "dev", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
  const signer = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const rpc = async (method: string, params: unknown[] = []) => {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };

  (window as any).ethereum = {
    isDevWallet: true,
    on() {},
    removeListener() {},
    async request({ method, params = [] }: { method: string; params?: any[] }) {
      console.log("[devWallet]", method);
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return `0x${chainId.toString(16)}`;
        case "net_version":
          return String(chainId);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "personal_sign": {
          const [data] = params as [Hex];
          return account.signMessage({ message: hexToString(data) });
        }
        case "eth_signTypedData_v4": {
          const typed = JSON.parse(params[1] as string);
          const { EIP712Domain: _omit, ...types } = typed.types as Record<string, { name: string; type: string }[]>;
          // JSON carries big numbers as strings; viem wants bigint for integer fields.
          const message = { ...typed.message };
          for (const f of types[typed.primaryType]) if (/^u?int/.test(f.type)) message[f.name] = BigInt(message[f.name]);
          return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message });
        }
        case "eth_sendTransaction": {
          const tx = params[0];
          return signer.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          });
        }
        default:
          return rpc(method, params);
      }
    },
  };
  console.info(`[devWallet] installed for ${account.address}`);
}
