// The escape hatch: both stakes are locked, the server never settles, and after MAX_MATCH_DURATION (1h) either
// player can unlock both stakes. The match is started directly by the operator key (no game server involved).
// Takes just over an hour. Run: npx tsx scripts/refund-timeout.ts
import { randomBytes } from "node:crypto";
import { createWalletClient, http, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PLAY_TYPES, bankDomain } from "@8pool/shared";
import { Player, abi, bank, chain, env, formatEther, log, reader, status } from "./lib";

const stake = parseEther("0.001");
const alice = new Player("Alice", env.PLAYER1_PRIVATE_KEY);
const bob = new Player("Bob", env.PLAYER2_PRIVATE_KEY);
const operator = createWalletClient({ account: privateKeyToAccount(env.RESULT_SIGNER_PRIVATE_KEY as Hex), chain, transport: http(env.RPC_URL) });
const startAbi = parseAbi(["function startMatch(address,address,uint256,bytes32,(uint256 maxStake,uint256 expiry,bytes signature),(uint256 maxStake,uint256 expiry,bytes signature)) returns (bytes32)", "function authNonce(address) view returns (uint256)"]);

for (const p of [alice, bob]) if ((await p.balance()) < stake) await p.tx("deposit", [], stake * 2n);

const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
const auth = async (p: Player) => ({
  maxStake: stake,
  expiry,
  signature: await p.wallet.signTypedData({
    domain: bankDomain({ chainId: chain.id, bank }), types: PLAY_TYPES, primaryType: "Play",
    message: { player: p.account.address, maxStake: stake, expiry, nonce: await reader.readContract({ address: bank, abi: startAbi, functionName: "authNonce", args: [p.account.address] }) },
  }),
});
const salt = ("0x" + randomBytes(32).toString("hex")) as Hex;
const id = await reader.readContract({ address: bank, abi, functionName: "matchIdFor", args: [alice.account.address, bob.account.address, salt] });
const before = { a: await alice.balance(), b: await bob.balance() };
const hash = await operator.writeContract({ address: bank, abi: startAbi, functionName: "startMatch", args: [alice.account.address, bob.account.address, stake, salt, await auth(alice), await auth(bob)] });
await reader.waitForTransactionReceipt({ hash });
const [, , , activeAt] = (await reader.readContract({ address: bank, abi, functionName: "matches", args: [id] })) as any;
const unlock = Number(activeAt) + 3600;
log(`READY: stakes locked at ${activeAt}, refund unlocks at ${unlock} (${new Date(unlock * 1000).toISOString()})`);
if ((await alice.balance()) !== before.a - stake) throw new Error("stake was not locked");

// Too early must be refused. Simulate so we don't burn gas on a doomed transaction.
let refused = false;
try {
  await reader.simulateContract({ address: bank, abi, functionName: "refund", args: [id], account: alice.account });
} catch { refused = true; }
if (!refused) throw new Error("refund succeeded before the timeout!");
log("refund correctly refused before the timeout");

for (;;) {
  const now = Number((await reader.getBlock()).timestamp);
  if (now >= unlock) break;
  log(`waiting ${Math.ceil((unlock - now) / 60)} more minutes…`);
  await new Promise((r) => setTimeout(r, Math.min((unlock - now) * 1000 + 15_000, 5 * 60_000)));
}

await bob.tx("refund", [id]); // either player may call it
const st = await status(id);
const after = { a: await alice.balance(), b: await bob.balance() };
log("status", st, "(3 = Cancelled)  Alice", formatEther(after.a), " Bob", formatEther(after.b));
if (st !== 3) throw new Error("status should be Cancelled");
if (after.a !== before.a || after.b !== before.b) throw new Error("both balances should be fully restored");
log("OK: refund after timeout unlocked both stakes.");
