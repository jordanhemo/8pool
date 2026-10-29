# Deploying (testnet)

Two pieces: the **game server** (Render, one web service with a disk) and the **client** (Vercel, static).

## 1. Server on Render
1. Push the repo to GitHub.
2. Render dashboard -> New -> Blueprint -> pick the repo (reads `render.yaml`).
3. When prompted, set `RESULT_SIGNER_PRIVATE_KEY` (operator + signer, needs Sepolia ETH for gas) and leave `ALLOWED_ORIGINS` empty for now.
4. Check `https://<service>.onrender.com/health` (`staked: true`, `operatorWei` > 0).

## 2. Client on Vercel
```
cd apps/client
npx vercel login
npx vercel link
npx vercel env add VITE_SERVER_URL production    # wss://<service>.onrender.com
npx vercel env add VITE_TRANSAK_API_KEY production   # optional: enables "Buy ETH with card" (public key from transak.com)
npx vercel --prod
```

## 3. Lock the server to the client
```
set ALLOWED_ORIGINS=https://<your-client-domain> in the Render service's environment
```
(comma-separated for several origins; empty allows any).

## Notes
- `render.yaml` uses Render's free plan (no card): the service sleeps after ~15 min idle (first connection then takes about a minute) and has no disk, so unsettled results are lost on restart. Switch to `plan: starter` plus a disk before real use.
- Run exactly one server machine: rooms, queues and play authorizations are in memory.
- `/data/results.json` (the Render disk) holds unsettled signed results; do not delete it while `/health` shows `unsettled > 0`.
- Watch `operatorWei`: the operator pays gas for every match start and settle.
- Redeploying drops running matches (players have the 1-hour on-chain refund).
