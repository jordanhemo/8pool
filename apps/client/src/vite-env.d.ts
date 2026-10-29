/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  /** Public Transak API key; enables "Buy with card". */
  readonly VITE_TRANSAK_API_KEY?: string;
  readonly VITE_DEV_KEY_1?: string;
  readonly VITE_DEV_KEY_2?: string;
  readonly VITE_DEV_RPC_URL?: string;
  readonly VITE_DEV_CHAIN_ID?: string;
}
