import { formatEther, parseEther } from "viem";
import { VENUES, newGame, type ChainInfo, type ServerMessage, type TournamentView } from "@8pool/shared";
import { GameScene3D, SceneData } from "./game3d/GameScene3D";
import { Stage } from "./game3d/Stage";
import { ROOMS, RoomId } from "./game3d/rooms";
import { Hud } from "./hud";
import { Lobby } from "./lobby";
import { Help } from "./help";
import { Menu } from "./menu";
import { Ladder } from "./ladder";
import { PrivateRoomUI } from "./privateRoom";
import { prefs } from "./settings";
import { Net } from "./net";
import { Toast } from "./toast";
import { Wallet, friendlyError } from "./wallet";

// Dev-only stand-in wallet for browser testing (?devwallet=1|2). Dead code in production builds.
if (import.meta.env.DEV) {
  const which = new URLSearchParams(location.search).get("devwallet");
  if (which) void import("./devWallet").then((m) => m.installDevWallet(which));
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? `ws://${location.hostname}:8080`;
const NAME_KEY = "8pool.name";
const ZERO = "0x0000000000000000000000000000000000000000";
const storedName = (() => { try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; } })();

const stage = new Stage(document.getElementById("game")!);
const hud = new Hud();
new Help();
if (import.meta.env.DEV) Object.assign(window, { __stage: stage, __hud: hud });
let scene: GameScene3D | null = null;

const setAccent = (id: RoomId) => document.documentElement.style.setProperty("--accent", ROOMS[id].accent);
setAccent(stage.roomId);
stage.setQuality(prefs.quality());

/** Change room behind a short fade so the rebuild isn't visible. `commit` stores it as the player's choice. */
const fadeEl = document.getElementById("fade")!;
const applyRoom = (id: RoomId, commit: boolean) => {
  fadeEl.classList.add("on");
  window.setTimeout(() => {
    stage.setRoom(id, commit);
    setAccent(id);
    requestAnimationFrame(() => fadeEl.classList.remove("on"));
  }, 140);
};

/** Menu backdrop: a fresh rack under a slowly orbiting camera, shifted right of the menu column on wide screens. */
const layoutMenu = () => stage.setInsets({ l: innerWidth >= 900 ? 480 : 0, r: 0, t: 0, b: 0 });
const showMenu = () => {
  stage.rack(newGame((Math.random() * 2 ** 32) >>> 0));
  stage.setCamera("menu");
  layoutMenu();
};
showMenu();
window.addEventListener("resize", () => { if (!inGame) layoutMenu(); });

// Phones play in landscape. Browsers only honour the lock in fullscreen/installed mode, so the rotate overlay is the fallback.
if (matchMedia("(pointer: coarse)").matches) {
  const lock = () => {
    document.removeEventListener("pointerdown", lock);
    void (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape").catch(() => undefined);
  };
  document.addEventListener("pointerdown", lock);
}

const net = new Net(SERVER_URL, storedName);
const toast = new Toast();
let inGame = false;
let chainInfo: ChainInfo | undefined;
let wallet: Wallet | null = null;
let address: string | null = null;
let starting = false; // stakes are being locked on-chain
let signingAuth = false;
let currentStake = 0n; // each player's stake in the match being played

type ResultMsg = Extract<ServerMessage, { t: "result" }>;

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The bracket the player is in or last watched, until they dismiss it. */
let tview: TournamentView | null = null;

const startScene = (data: DistOmit<SceneData, "onExit">) => {
  inGame = true;
  lobby.hide();
  scene?.destroy();
  scene = new GameScene3D(stage, hud, {
    ...data,
    onExit: () => {
      inGame = false;
      scene?.destroy();
      scene = null;
      showMenu();
      menu.reset();
      // Back from a tournament match: show the bracket, and put the player's own room back.
      if (stage.roomId !== menu.getCommitted()) applyRoom(menu.getCommitted(), false);
      if (tview) menu.open("tournament");
      lobby.setQueued(null);
      lobby.show();
    },
  } as SceneData);
};

// ---------------------------------------------------------------- wallet

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const txLink = (hash: string) => ({ label: "View transaction", href: wallet?.txUrl(hash) ?? "" });

async function ensureWallet(): Promise<Wallet> {
  if (!chainInfo) throw new Error("The server isn't set up for staked matches.");
  wallet ??= new Wallet(chainInfo);
  if (!wallet.address) await wallet.connect();
  return wallet;
}

async function connectWallet() {
  try {
    const w = await ensureWallet();
    w.onAccountChange(() => location.reload());
    net.send({ t: "auth_request", address: w.address! });
  } catch (e) {
    lobby.setError(friendlyError(e));
  }
}

/** One-time, gas-free signature so the server can lock stakes for matches without any wallet popup. */
async function signPlayAuth(req: Extract<ServerMessage, { t: "play_auth_request" }>) {
  if (signingAuth) return;
  signingAuth = true;
  try {
    const w = await ensureWallet();
    const signature = await w.signPlayAuth(BigInt(req.maxStakeWei), req.expiry, BigInt(req.nonce));
    net.send({ t: "play_auth", maxStake: req.maxStakeWei, expiry: req.expiry, nonce: req.nonce, signature });
  } catch (e) {
    lobby.setError(`${friendlyError(e)} You need to approve play before you can join a match.`);
  } finally {
    signingAuth = false;
  }
}

async function addFunds(amountEth: string) {
  try {
    let amount: bigint;
    try { amount = parseEther(amountEth); } catch { throw new Error("Enter an amount like 0.02"); }
    if (amount <= 0n) throw new Error("Enter an amount above zero.");
    const w = await ensureWallet();
    if ((await w.balance()) < amount) throw new Error(`Your wallet doesn't hold ${amountEth} ETH plus gas.`);
    toast.show(`Confirm adding ${amountEth} ETH in your wallet…`);
    await w.deposit(amount, (h) => toast.show("Deposit sent, waiting for confirmation…", [], txLink(h)));
    toast.show(`Added ${amountEth} ETH to your balance.`, [], undefined, 6000);
    net.send({ t: "refresh" });
  } catch (e) {
    toast.show(`Couldn't add funds: ${friendlyError(e)}`, [{ label: "OK", run: () => toast.hide() }]);
  }
}

async function withdrawAll() {
  try {
    if (!bank || bank.balance === 0n) return;
    const w = await ensureWallet();
    const amount = bank.balance;
    toast.show(`Confirm withdrawing ${formatEther(amount)} ETH in your wallet…`);
    const hash = await w.withdraw(amount, (h) => toast.show("Withdrawal sent, waiting for confirmation…", [], txLink(h)));
    toast.show(`Withdrew ${formatEther(amount)} ETH to your wallet.`, [], txLink(hash), 8000);
    net.send({ t: "refresh" });
  } catch (e) {
    toast.show(`Couldn't withdraw: ${friendlyError(e)}`, [{ label: "OK", run: () => toast.hide() }]);
  }
}

/** Fallback only, for when the server couldn't settle on its own. */
async function claim(r: ResultMsg, isVoid: boolean) {
  try {
    const w = await ensureWallet();
    toast.show("Confirm the claim in your wallet…");
    const hash = await w.settle(r.bankMatchId, r.winner, r.signature!, (h) => toast.show("Transaction sent, waiting for confirmation…", [], txLink(h)));
    toast.show(isVoid ? "Stake returned to your balance." : "Winnings added to your balance.", [], txLink(hash), 8000);
    net.send({ t: "refresh" });
  } catch (e) {
    toast.show(`Couldn't submit: ${friendlyError(e)}`, [{ label: "Try again", run: () => claim(r, isVoid) }]);
  }
}

function onResult(r: ResultMsg) {
  if (!address) return;
  const isVoid = same(r.winner, ZERO);
  const iWon = !isVoid && same(r.winner, address);
  if (!isVoid && !iWon) return; // lost: the stake already went to the winner
  const pot = currentStake ? formatEther(currentStake * 2n) : "";
  if (r.settled) {
    toast.show(
      isVoid ? "The match was voided. Your stake is back in your balance." : `You won${pot ? ` ${pot} ETH` : ""}! It's already in your balance.`,
      [{ label: "OK", run: () => toast.hide() }],
      r.txHash ? txLink(r.txHash) : undefined,
    );
    return;
  }
  toast.show(isVoid ? "The match was voided. Take your stake back." : `You won${pot ? ` ${pot} ETH` : ""}! Payout is pending.`, [
    { label: isVoid ? "Refund my stake" : "Claim winnings", run: () => claim(r, isVoid) },
  ]);
}

// ---------------------------------------------------------------- lobby

const lobby = new Lobby(
  {
    onQueue: (tier) => net.send({ t: "queue", tier }),
    onCancel: () => net.send({ t: "leave_queue" }),
    onPractice: () => startScene({ mode: "local" }),
    onRename: (name) => {
      try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
      net.rename(name);
    },
    onConnectWallet: () => void connectWallet(),
    onAddFunds: (amount) => void addFunds(amount),
    onWithdraw: () => void withdrawAll(),
    onTournamentJoin: (venue) => net.send({ t: "tournament_join", venue }),
    onTournamentLeave: () => net.send({ t: "tournament_leave" }),
    onTournamentClose: () => {
      tview = null;
      lobby.setTournament(null);
    },
  },
  storedName,
);

let myPid: string | null = null;
const ladder = new Ladder({
  requestLeaderboard: () => net.send({ t: "leaderboard" }),
  requestProfile: (pid) => net.send({ t: "profile", pid }),
  onMine: (p) => lobby.setRating(p && p.played > 0 ? p.rating : null),
});
const priv = new PrivateRoomUI({
  onCreate: (stake) => net.send({ t: "private_create", stake }),
  onJoin: (code) => net.send({ t: "private_join", code }),
  onCancel: () => net.send({ t: "private_cancel" }),
  onError: (msg) => lobby.setError(msg),
});

const menu = new Menu({
  getRoom: () => stage.roomId,
  setRoom: applyRoom,
  setQuality: (q) => stage.setQuality(q),
  onOpen: (id) => { if (id === "stats") ladder.refresh(); },
});

// An invite link (?join=CODE) opens the private room screen with the code filled in.
const inviteCode = new URLSearchParams(location.search).get("join");
if (inviteCode) history.replaceState(null, "", location.pathname);

let bank: { balance: bigint; authorized: boolean; inMatch: boolean } | null = null;
const parseStake = (tier: string) => { try { return parseEther(tier); } catch { return 0n; } };

net.onStatus((s) => { lobby.setConnected(s === "open"); priv.setConnected(s === "open"); });
net.subscribe((m) => {
  switch (m.t) {
    case "welcome":
      chainInfo = m.chain;
      address = m.address ?? null;
      bank = null;
      lobby.setBankroll(null);
      lobby.setChainMode(!!m.chain);
      lobby.setWallet(address);
      lobby.setTiers(m.tiers, m.name);
      lobby.setVenues(m.venues ?? VENUES);
      // A fresh connection: the server re-sends the bracket if the player is still in one.
      tview = null;
      lobby.setTournament(null);
      lobby.setTournamentLobby(null);
      myPid = m.pid ?? null;
      ladder.setMe(myPid);
      priv.setChainMode(!!m.chain);
      priv.setState(null);
      if (inviteCode && !inGame) {
        priv.prefill(inviteCode);
        menu.open("private");
      }
      break;
    case "auth_challenge":
      wallet
        ?.signLogin(m.message)
        .then((signature) => net.send({ t: "auth", address: wallet!.address!, signature }))
        .catch((e) => lobby.setError(friendlyError(e)));
      break;
    case "leaderboard":
    case "profile":
      ladder.onMessage(m);
      break;
    case "rating":
      ladder.setMe(myPid); // refresh the rank shown in the menu
      break;
    case "private_state":
      priv.setState(m);
      if (!inGame) menu.open("private");
      break;
    case "private_closed":
      priv.setState(null);
      if (m.reason) lobby.setError(m.reason);
      break;
    case "authed":
      myPid = m.pid ?? myPid;
      ladder.setMe(myPid);
      address = m.address;
      lobby.setWallet(address);
      break;
    case "tournament_lobby": lobby.setTournamentLobby(m); break;
    case "tournament_left": lobby.setTournamentLobby(null); break;
    case "tournament_state":
      tview = m;
      lobby.setTournamentLobby(null);
      lobby.setTournament(m);
      if (!inGame) menu.open("tournament");
      break;
    case "tournament_failed":
      tview = null;
      lobby.setTournament(null);
      lobby.setTournamentLobby(null);
      toast.show(`Tournament cancelled: ${m.reason}`, [{ label: "OK", run: () => toast.hide() }]);
      break;
    case "queued": lobby.setQueued(m.tier); break;
    case "queue_left": lobby.setQueued(null); break;
    case "bankroll":
      bank = { balance: BigInt(m.balanceWei), authorized: m.authorized, inMatch: m.inMatch };
      lobby.setBankroll(bank);
      break;
    case "play_auth_request": void signPlayAuth(m); break;
    case "match_starting":
      starting = true;
      lobby.setBusy(true);
      lobby.setQueued(null);
      break;
    case "match_failed":
      starting = false;
      lobby.setBusy(false);
      toast.show(`Match cancelled: ${m.reason} Nothing was charged.`, [{ label: "OK", run: () => toast.hide() }]);
      break;
    case "result": onResult(m); break;
    case "error": if (!inGame) lobby.setError(m.message); break;
    // A resumed match after a page refresh arrives while we're in the lobby.
    case "match_start":
      priv.setState(null);
      if (starting) {
        starting = false;
        lobby.setBusy(false);
      }
      currentStake = parseStake(m.tier);
      if (!inGame) {
        const round = m.tournament?.round;
        const venue = tview ? VENUES.find((v) => v.id === tview!.venue) : undefined;
        if (round && tview) applyRoom(tview.venue as RoomId, false); // tournaments are played in their venue
        const pot = round
          ? `${venue?.name ?? "Tournament"} · ${round === "final" ? "Final" : "Semifinal"}`
          : chainInfo ? `Pot ${formatEther(currentStake * 2n)} ETH` : undefined;
        startScene({ mode: "online", net, start: m, pot, tournament: round, openProfile: (pid) => ladder.openProfile(pid) });
      }
      break;
  }
});
net.connect();
