import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chain, createChain, readEnvKeys } from "./chain";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { PlayerStore } from "./players";
import { ResultStore } from "./store";

const config = loadConfig();

// Only the keys the server needs are read from the repo-root .env (it also holds the deployer key).
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
const env = {
  ...(existsSync(envFile)
    ? readEnvKeys(readFileSync(envFile, "utf8"), ["BANK_ADDRESS", "CHAIN_ID", "RPC_URL", "RESULT_SIGNER_PRIVATE_KEY"])
    : {}),
  ...Object.fromEntries(
    ["BANK_ADDRESS", "CHAIN_ID", "RPC_URL", "RESULT_SIGNER_PRIVATE_KEY"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
  ),
};

let chain: Chain | undefined;
if (process.env.STAKED !== "0" && env.BANK_ADDRESS && env.RESULT_SIGNER_PRIVATE_KEY && env.RPC_URL && env.CHAIN_ID) {
  chain = createChain({
    chainId: Number(env.CHAIN_ID),
    bank: env.BANK_ADDRESS,
    rpcUrl: env.RPC_URL,
    signerPrivateKey: env.RESULT_SIGNER_PRIVATE_KEY,
  });
}

const store = new ResultStore(process.env.RESULTS_FILE ?? fileURLToPath(new URL("../data/results.json", import.meta.url)));
const players = new PlayerStore(process.env.PLAYERS_FILE ?? fileURLToPath(new URL("../data/players.json", import.meta.url)));
const server = await startServer(config, {
  chain,
  store,
  players,
  onMatchEnd: (r) => console.log(`match ${r.matchId} (${r.tier}) won by ${r.names[r.winner]}: ${r.reason}`),
});
console.log(
  `8pool server listening on :${server.port}  tiers=${config.tiers.join(",")}  ` +
    (chain ? `STAKED on chain ${chain.info.chainId}, bank ${chain.info.bank}` : "free play (no chain configured)"),
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close().then(() => process.exit(0)));
}
