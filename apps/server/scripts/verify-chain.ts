// Read-only check: does our TS signing / match-id code agree with the deployed contract? Run: npx tsx scripts/verify-chain.ts
import { readFileSync } from "node:fs";
import { createPublicClient, http, hashTypedData, parseAbi, getAddress, recoverAddress, type Hex } from "viem";
import { PLAY_TYPES, RESULT_TYPES, bankDomain } from "@8pool/shared";
import { createChain, readEnvKeys } from "../src/chain";

const env = readEnvKeys(readFileSync(new URL("../../../.env", import.meta.url), "utf8"), ["BANK_ADDRESS", "CHAIN_ID", "RPC_URL", "RESULT_SIGNER_PRIVATE_KEY", "RESULT_SIGNER_ADDRESS", "DEPLOYER_ADDRESS"]);
const chain = createChain({ chainId: Number(env.CHAIN_ID), bank: env.BANK_ADDRESS, rpcUrl: env.RPC_URL, signerPrivateKey: env.RESULT_SIGNER_PRIVATE_KEY });
const pc = createPublicClient({ transport: http(env.RPC_URL) });
const bank = env.BANK_ADDRESS as Hex;
const abi = parseAbi([
  "function matchIdFor(address,address,bytes32) pure returns (bytes32)",
  "function resultDigest(bytes32,address) view returns (bytes32)",
  "function playDigest(address,uint256,uint256,uint256) view returns (bytes32)",
  "function resultSigner() view returns (address)",
  "function operator() view returns (address)",
]);
const a = env.DEPLOYER_ADDRESS, b = env.RESULT_SIGNER_ADDRESS, salt = ("0x" + "ab".repeat(32)) as Hex;
const domain = bankDomain(chain.info);

const idTs = chain.matchIdFor(a, b, salt);
const idSol = await pc.readContract({ address: bank, abi, functionName: "matchIdFor", args: [a as Hex, b as Hex, salt] });
console.log("matchIdFor  ts == contract:", idTs === idSol);

const resultSol = await pc.readContract({ address: bank, abi, functionName: "resultDigest", args: [idTs as Hex, a as Hex] });
const resultTs = hashTypedData({ domain, types: RESULT_TYPES, primaryType: "Result", message: { matchId: idTs as Hex, winner: getAddress(a) } });
console.log("Result digest ts == contract:", resultTs === resultSol);

const [maxStake, expiry, nonce] = [10n ** 16n, 1_900_000_000n, 0n];
const playSol = await pc.readContract({ address: bank, abi, functionName: "playDigest", args: [a as Hex, maxStake, expiry, nonce] });
const playTs = hashTypedData({ domain, types: PLAY_TYPES, primaryType: "Play", message: { player: getAddress(a), maxStake, expiry, nonce } });
console.log("Play digest   ts == contract:", playTs === playSol);

const sig = await chain.signResult(idTs, a);
const rec = await recoverAddress({ hash: resultSol, signature: sig as Hex });
console.log("signature recovers to on-chain resultSigner:", rec === (await pc.readContract({ address: bank, abi, functionName: "resultSigner" })), rec);
console.log("operator on-chain:", await pc.readContract({ address: bank, abi, functionName: "operator" }));
console.log("status of unknown match:", await chain.getStatus(idTs));
console.log("operator gas balance (wei):", await chain.operatorBalance());
