// Full staked match against a running server and the real PoolBank contract:
//   login -> sign play auth once -> queue -> server locks stakes -> game -> resign -> server settles -> withdraw.
// The only wallet transactions are the one-time deposit/withdraw; the match itself needs none.
// Needs PLAYER1_PRIVATE_KEY / PLAYER2_PRIVATE_KEY (funded) in the repo-root .env. Run: npx tsx scripts/e2e-chain.ts
import { parseEther } from "viem";
import { Player, TIER, bal, bank, env, formatEther, log } from "./lib";

const stake = parseEther(TIER);
const p1 = new Player("Alice", env.PLAYER1_PRIVATE_KEY);
const p2 = new Player("Bob", env.PLAYER2_PRIVATE_KEY);

// One-time funding of the in-contract balances (skipped if they already hold enough).
for (const p of [p1, p2]) {
  if ((await p.balance()) < stake) await p.tx("deposit", [], stake);
}
const before = { p1: await p1.balance(), p2: await p2.balance(), contract: await bal(bank) };
log("bank balances before  Alice", formatEther(before.p1), " Bob", formatEther(before.p2), " contract holds", formatEther(before.contract));

await Promise.all([p1.connect(), p2.connect()]);
p1.send({ t: "queue", tier: TIER });
p2.send({ t: "queue", tier: TIER });
await Promise.all([p1.next("match_starting"), p2.next("match_starting")]);
log("paired; server is locking the stakes (no wallet popups)");

const [s1, s2] = await Promise.all([p1.next("match_start", 180_000), p2.next("match_start", 180_000)]);
log("game started. seats:", p1.label, s1.seat, p2.label, s2.seat);
const during = { p1: await p1.balance(), p2: await p2.balance() };
if (during.p1 !== before.p1 - stake || during.p2 !== before.p2 - stake) throw new Error("stakes were not locked from the balances");
log("both stakes locked:", formatEther(during.p1), formatEther(during.p2));

const [breaker, other] = s1.seat === 0 ? [p1, p2] : [p2, p1];
breaker.send({ t: "shot", angle: 0, power: 0.8 });
const shot = await other.next("shot_result");
log("break shot relayed, frames:", shot.report.frames.length);

breaker.send({ t: "resign" }); // the other player wins
const [res1, res2] = await Promise.all([p1.next("result", 180_000), p2.next("result", 180_000)]);
const winner = res1.winner === p1.account.address ? p1 : p2;
const loser = winner === p1 ? p2 : p1;
log("result:", winner.label, "wins | settled by the server:", res1.settled, res1.txHash ?? "");
if (!res1.settled || !res2.settled) throw new Error("server did not settle the match");

const after = { p1: await p1.balance(), p2: await p2.balance(), contract: await bal(bank) };
const wDelta = (winner === p1 ? after.p1 - before.p1 : after.p2 - before.p2);
const lDelta = (loser === p1 ? after.p1 - before.p1 : after.p2 - before.p2);
log(`bank balances after  Alice ${formatEther(after.p1)}  Bob ${formatEther(after.p2)}  (winner +${formatEther(wDelta)}, loser ${formatEther(lDelta)})`);
if (wDelta !== stake || lDelta !== -stake) throw new Error("balances should move by exactly one stake");
if (after.contract !== before.contract) throw new Error("contract ETH changed during the match");

// The winner never had to claim anything. Withdrawing is their choice, any time.
const w0 = await winner.walletBalance();
await winner.tx("withdraw", [stake]);
log("winner withdrew one stake to their wallet; wallet ETH", formatEther(w0), "->", formatEther(await winner.walletBalance()));
log("OK: no per-game deposits, no claim, funds conserved.");
p1.ws.close(); p2.ws.close();
