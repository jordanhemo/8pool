# 8-Ball Pool: project status

Online 1v1 8-ball pool where both players stake testnet ETH and the winner takes the pot.
Last updated 2026-10-25. **Testnet only (Ethereum Sepolia).**

## Layout

| Path | What it is |
|---|---|
| `packages/shared` | Deterministic physics engine, 8-ball rules, wire protocol (used by server and client) |
| `apps/server` | Authoritative game server: wallet login, matchmaking, deposit orchestration, shot clock, result signing |
| `apps/client` | Phaser 3 client + HTML lobby, viem wallet code |
| `contracts` | Foundry project: `PoolBank.sol` (current) and the retired `PoolEscrow.sol`, tests, `deployments/` |

## How it works (wallet flow v2: bankroll)

1. **Fund once.** The player calls `deposit()` on `PoolBank` and gets a balance inside the contract. `withdraw(amount)` pulls
   any unlocked balance back to their wallet at any time.
2. **Authorize once.** One gas-free EIP-712 `Play(player, maxStake, expiry, nonce)` signature (24h, max = largest tier) lets the
   server lock up to `maxStake` per match. `revokeAuthorizations()` on-chain cancels all of them.
3. **Queue.** Players sign in with their wallet (one-time challenge), pick a tier. The server checks balance and authorization
   and pairs two *different* wallets.
4. **Match start = one server transaction.** `startMatch` verifies both authorizations and locks both stakes atomically. No
   deposit popups, no funding timeouts. The game starts once the transaction is confirmed (~12-20 s on Sepolia).
5. **The server runs the game** (authoritative physics and rules).
6. **The server settles.** At game end it signs an EIP-712 `Result` and submits `settle` itself. The winner's balance is
   credited inside the contract, so nobody has to claim and the winner can be offline. A void result returns both stakes.
7. **Fallbacks.** Unsettled results stay in `apps/server/data/results.json`, are retried every 30 s and on login, and the
   client shows a "Claim winnings" button if the server could not settle. `refund` (either player, 1 hour after start) unlocks
   both stakes if the server disappears.

Operator key = result signer key (holds gas only, never player funds; it can only lock stakes within a player's signed
authorization). `/health` reports its gas balance (`operatorWei`).

## Deployment (Ethereum Sepolia, chain 11155111)

- **`PoolBank` (current): `0xD419Ccd66b02811351bEc16CCE87609C349547Ff`** (`contracts/deployments/sepolia-bank.json`, `BANK_ADDRESS` in `.env`)
- Owner / deployer: `0xf266E9Bf060df29715f5926C0745C73Fe7c1d9Ed`
- Operator and result signer (the game server's key): `0x85B8DedB03a6C6A25b89cc989865dEe05d335205` (funded with 0.01 ETH for gas)
- Rake: 0%. Match limit: 1 hour.
- Old per-game escrow `PoolEscrow` `0xDC88…F3e9` is retired (kept in `src/PoolEscrow.sol` and `deployments/sepolia.json`).
- Gotcha: Sepolia charges ~5x the gas Foundry simulates for storing contract code. Deploy with
  `forge create ... --gas-limit 14500000` (`forge script` ignores `--gas-limit`; check `cast estimate --create` first).
- Secrets live in the repo-root `.env` (gitignored, mode 600). The server reads only the variables it needs from that file.

## Test status

| Suite | Result |
|---|---|
| Physics + rules (`packages/shared`) | 28 passing |
| Contracts (`contracts`, Foundry; PoolBank 29 incl. fuzz accounting + old PoolEscrow 34) | 63 passing |
| Game server (`apps/server`, fake-chain bankroll flows) | 41 passing |
| Client | typechecks and builds (dev wallet not in the bundle) |

Real-chain runs on Sepolia (`apps/server/scripts/`):

| Scenario | Result |
|---|---|
| `verify-chain.ts`: TS match id, `Result` and `Play` EIP-712 digests equal the contract's | **Match** |
| `e2e-chain.ts`: sign in, one authorization signature, queue, server locks stakes, game, resign, server settles, winner withdraws; balances move by exactly one stake, contract ETH conserved | **Pass** |
| Browser, two tabs with the stand-in wallet: connect, auto-authorize, queue with **zero popups**, game start, disconnect forfeit, balance credited automatically, **Withdraw** button | **Pass** |
| `refund-timeout.ts` (one-hour refund on PoolBank) | Written, **not yet run** (takes an hour) |

## ## Running it

```
cd apps/server && npm start                  # ws://localhost:8080, staked if .env has the contract + signer key
cd apps/client && npm run dev                # http://localhost:5173
cd apps/server && npx tsx scripts/e2e-chain.ts            # full on-chain match with two scripted wallets
npm test                                     # shared + server tests;  cd contracts && forge test
```
Set `STAKED=0` to run the server without the chain (free play).

## What is missing

### Before anyone else can try it
1. **The flow has not run through real MetaMask.** The browser run used the dev stand-in wallet (same code paths). Untested in
   MetaMask: the deposit/withdraw popups, the typed-data signature popup, network switch, rejections, account changes.
2. **Operator gas.** The server pays gas for `startMatch` and `settle`; if the operator key runs dry, matches fail to start and
   results wait for the retry loop. Needs monitoring (`/health.operatorWei`) and a top-up policy (rake can fund it).
3. **Persistence and recovery.** Matches live in memory; a server restart drops running games (the one-hour `refund`
   protects the money). Signed results and unsettled payouts survive restarts.
4. **Deployment.** Everything runs on localhost. Needs hosting, TLS (`wss://`) and a configurable server URL.
5. **Open bug (not from this change):** both tabs froze after a few shots in a real two-wallet game. A frame-error guard
   was added to `GameScene.update()`, but the cause is unconfirmed (needs the browser console of a frozen tab).

### Product gaps
4. No game has been played to a real win through the server (tests end by resignation or timeout); winning by
   potting the 8 is covered only by unit tests.
5. Physics feel is untuned (break barely scatters the rack; speed/friction values are guesses).
6. Simplified rules: no spin, no push-out, basic break rule, 8-ball re-spotted if potted on the break.
7. No spectators, rematch, chat, or game history.

### Security and trust
8. The server is a trusted party: it signs results, so a buggy or compromised server could award the pot wrongly.
   There is no dispute path.
9. Abuse limits are basic (per-socket message rate limit only); no handling of repeated no-shows or cheating on timing.
10. The contract has not been independently audited.
11. Real-money gambling has legal and licensing requirements; needs review before anything beyond testnet.
12. Private keys sit in a plain `.env`; fine for testnet, needs proper secrets handling for anything real.

## Dev stand-in wallet

`apps/client/src/devWallet.ts` replaces `window.ethereum` with a provider signing with a throwaway test key, enabled by
`?devwallet=1` or `?devwallet=2` under `vite dev` only. Keys come from `apps/client/.env.local` (gitignored, created from
the root `.env`). It is compiled out of production builds (checked: not present in the bundle).

## Next steps (in order)
1. Run a full staked match through real MetaMask (two accounts / two browser profiles, Sepolia ETH).
2. Reproduce and fix the freeze, then play and tune the game (physics feel, rules polish).
3. Run `refund-timeout.ts` once; decide on hosting, operator gas policy and persistence/recovery.
4. Next version: push payouts straight to the wallet (or tokens) instead of crediting the bankroll.


## Deployment
See `DEPLOY.md` (Render server + Vercel client). Prepared: `apps/server/Dockerfile`, `render.yaml`, `apps/client/vercel.json`, `ALLOWED_ORIGINS` WebSocket origin check, music compressed 17.9 MB -> 8.4 MB. Not deployed yet.
