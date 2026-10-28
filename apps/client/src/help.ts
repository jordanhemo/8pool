import { sfx } from "./audio";
import { colorOf, cssColor } from "./game3d/textures";

type Tab = "controls" | "rules" | "tournament";

const TABS: { id: Tab; label: string }[] = [
  { id: "controls", label: "Controls" },
  { id: "rules", label: "Rules" },
  { id: "tournament", label: "Tournament" },
];

const key = (k: string) => `<kbd>${k}</kbd>`;

/** A pool ball as an inline SVG circle: solid, stripe or the 8 ball. */
function ball(id: number, r = 11): string {
  const c = cssColor(colorOf(id));
  const d = r * 2;
  const stripe = id > 8 ? `<rect x="0" y="${r * 0.55}" width="${d}" height="${r * 0.9}" fill="${c}"/>` : "";
  const base = id > 8 ? "#f4f1e8" : c;
  return `<svg viewBox="0 0 ${d} ${d}" width="${d}" height="${d}" class="hball"><defs><clipPath id="b${id}"><circle cx="${r}" cy="${r}" r="${r}"/></clipPath></defs><g clip-path="url(#b${id})"><rect width="${d}" height="${d}" fill="${base}"/>${stripe}</g><circle cx="${r}" cy="${r}" r="${r * 0.42}" fill="#fff"/><text x="${r}" y="${r + 3}" text-anchor="middle" font-size="${r * 0.7}" font-weight="700" fill="#111" font-family="sans-serif">${id}</text></svg>`;
}

const TABLE = `<rect x="6" y="6" width="208" height="108" rx="12" fill="#7d4a24"/><rect x="16" y="16" width="188" height="88" rx="6" fill="#1a8a5a"/>`;

const ART = {
  aim: `<svg viewBox="0 0 220 120">${TABLE}
    <line x1="52" y1="68" x2="132" y2="50" stroke="#fff" stroke-width="2" stroke-dasharray="5 4" opacity=".85"/>
    <circle cx="52" cy="68" r="8" fill="#f4f1e8"/>
    <circle cx="132" cy="50" r="8" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="3 3"/>
    <circle cx="145" cy="47" r="8" fill="#d62828"/>
    <line x1="14" y1="75" x2="42" y2="70" stroke="#e9cb97" stroke-width="4" stroke-linecap="round"/>
    <path d="M70 100h80" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/><path d="m76 94-8 6 8 6M144 94l8 6-8 6" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  power: `<svg viewBox="0 0 220 120">
    <rect x="96" y="8" width="28" height="104" rx="14" fill="#0e131a" stroke="rgba(255,255,255,.18)"/>
    <rect x="104" y="18" width="12" height="84" rx="6" fill="url(#pg)"/>
    <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2fcf8a"/><stop offset=".55" stop-color="#f6c453"/><stop offset="1" stop-color="#ef5350"/></linearGradient></defs>
    <circle cx="110" cy="74" r="12" fill="#fff" stroke="var(--accent)" stroke-width="3"/>
    <path d="M150 34v52m0 0-8-9m8 9 8-9" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="30" y="52" fill="#9aa6b4" font-size="12" font-weight="700" font-family="sans-serif">PULL</text><text x="30" y="70" fill="#9aa6b4" font-size="12" font-weight="700" font-family="sans-serif">DOWN</text></svg>`,
  spin: `<svg viewBox="0 0 220 120">
    <circle cx="110" cy="62" r="44" fill="#f4f1e8"/><circle cx="110" cy="62" r="44" fill="none" stroke="rgba(0,0,0,.15)"/>
    <path d="M110 24v76M72 62h76" stroke="rgba(0,0,0,.12)"/>
    <circle cx="128" cy="45" r="8" fill="#e53935" stroke="#fff" stroke-width="2.5"/>
    <g fill="#9aa6b4" font-size="11" font-weight="700" font-family="sans-serif" text-anchor="middle"><text x="110" y="14">FOLLOW</text><text x="110" y="118">DRAW</text><text x="38" y="66">LEFT</text><text x="182" y="66">RIGHT</text></g></svg>`,
  hand: `<svg viewBox="0 0 220 120">${TABLE}
    <line x1="106" y1="16" x2="106" y2="104" stroke="#ffd166" stroke-width="2" stroke-dasharray="5 4" opacity=".85"/>
    <circle cx="62" cy="64" r="8" fill="#fff" opacity=".55"/><circle cx="62" cy="64" r="8" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="3 3"/>
    <circle cx="62" cy="64" r="22" fill="none" stroke="var(--accent)" stroke-width="2.5" opacity=".7"/>
    <circle cx="62" cy="64" r="34" fill="none" stroke="var(--accent)" stroke-width="2" opacity=".35"/>
    <g fill="#d62828"><circle cx="160" cy="62" r="7"/><circle cx="172" cy="55" r="7"/><circle cx="172" cy="69" r="7"/></g></svg>`,
  camera: `<svg viewBox="0 0 220 120">
    <g font-family="sans-serif" font-weight="800" text-anchor="middle">
      <rect x="14" y="34" width="52" height="52" rx="14" fill="#101720" stroke="rgba(255,255,255,.2)"/><text x="40" y="68" font-size="17" fill="#fff">3D</text>
      <rect x="84" y="34" width="52" height="52" rx="14" fill="#101720" stroke="rgba(255,255,255,.2)"/><text x="110" y="68" font-size="17" fill="#fff">2D</text>
      <path d="m68 60 14 0m-5-5 5 5-5 5" stroke="var(--accent)" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="154" y="34" width="52" height="52" rx="14" fill="#101720" stroke="rgba(255,255,255,.2)"/><path d="M180 48a12 12 0 1 1-11 8" fill="none" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round"/><path d="m166 50 6 7 7-5" fill="none" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`,
  chat: `<svg viewBox="0 0 220 120">
    <circle cx="48" cy="82" r="22" fill="#101720" stroke="rgba(255,255,255,.2)"/><circle cx="48" cy="82" r="11" fill="none" stroke="#fff" stroke-width="2.5"/><circle cx="44" cy="79" r="1.6" fill="#fff"/><circle cx="52" cy="79" r="1.6" fill="#fff"/><path d="M43 85q5 5 10 0" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>
    <rect x="86" y="20" width="108" height="34" rx="12" fill="#fff"/><path d="M96 54l-6 12 18-12Z" fill="#fff"/>
    <text x="140" y="43" text-anchor="middle" font-size="15" font-weight="800" fill="#10151b" font-family="sans-serif">Nice shot!</text></svg>`,
  groups: `<div class="ballrow">${[1, 2, 3, 4, 5, 6, 7].map((i) => ball(i)).join("")}<span>SOLIDS</span></div><div class="ballrow">${[9, 10, 11, 12, 13, 14, 15].map((i) => ball(i)).join("")}<span>STRIPES</span></div>`,
  eight: `<div class="ballrow big">${ball(8, 22)}<span class="arrow">&#8594;</span><div class="pocket"></div><span class="small">Pot it last to win</span></div>`,
  foul: `<svg viewBox="0 0 220 120">${TABLE}<circle cx="110" cy="60" r="8" fill="#f4f1e8"/><path d="M110 60 188 100" stroke="#ef5350" stroke-width="2.5" stroke-dasharray="5 4"/><circle cx="190" cy="102" r="9" fill="#050505"/><path d="M170 18l20 20m0-20-20 20" stroke="#ef5350" stroke-width="5" stroke-linecap="round"/></svg>`,
  clock: `<svg viewBox="0 0 220 120"><circle cx="110" cy="62" r="42" fill="#0e131a" stroke="rgba(255,255,255,.15)" stroke-width="3"/><circle cx="110" cy="62" r="42" fill="none" stroke="var(--accent)" stroke-width="7" stroke-linecap="round" stroke-dasharray="190 264" transform="rotate(-90 110 62)"/><text x="110" y="72" text-anchor="middle" font-size="30" font-weight="800" fill="#fff" font-family="sans-serif">45</text></svg>`,
  bracket: `<svg viewBox="0 0 220 120" font-family="sans-serif" font-weight="800" font-size="10">
    <g fill="#101720" stroke="rgba(255,255,255,.22)"><rect x="6" y="8" width="52" height="20" rx="6"/><rect x="6" y="36" width="52" height="20" rx="6"/><rect x="6" y="64" width="52" height="20" rx="6"/><rect x="6" y="92" width="52" height="20" rx="6"/></g>
    <g fill="none" stroke="var(--accent)" stroke-width="2"><path d="M58 18h14v18H58m14-9h14M58 74h14v18H58m14-9h14"/><path d="M110 27v56M110 55h14"/></g>
    <g fill="#101720" stroke="var(--accent)"><rect x="86" y="17" width="48" height="20" rx="6"/><rect x="86" y="73" width="48" height="20" rx="6"/><rect x="150" y="45" width="64" height="26" rx="8" fill="var(--accent)"/></g>
    <g fill="#9aa6b4" text-anchor="middle"><text x="32" y="22">PLAYER</text><text x="32" y="50">PLAYER</text><text x="32" y="78">PLAYER</text><text x="32" y="106">PLAYER</text><text x="110" y="31">B</text><text x="110" y="87">B</text></g>
    <text x="182" y="62" text-anchor="middle" fill="#06120c" font-size="12">CHAMPION</text></svg>`,
};

interface Card { title: string; art: string; body: string; keys?: string }

const CONTENT: Record<Tab, Card[]> = {
  controls: [
    {
      title: "Aim", art: ART.aim,
      body: "Drag left and right across the table to turn your aim. The line shows where the cue ball hits first.",
      keys: `<span class="hchip">Mouse: drag</span><span class="hchip">Touch: swipe</span>${key("&#8592;")}${key("&#8594;")}<span class="hchip dim">Shift = slow</span>`,
    },
    {
      title: "Power & shoot", art: ART.power,
      body: "Pull the power bar down, then let go to shoot. The further you pull, the harder the hit.",
      keys: `<span class="hchip">Touch: pull the bar</span>${key("Space")}<span class="hchip dim">hold, release</span>`,
    },
    {
      title: "Spin", art: ART.spin,
      body: "Drag the red dot on the cue ball. High = follow, low = draw, sides curve the ball off the cushions. Double-tap to reset.",
      keys: `<span class="hchip">Drag the dot</span><span class="hchip dim">Double-tap: reset</span>`,
    },
    {
      title: "Ball in hand", art: ART.hand,
      body: "After a foul, tap where you want the cue ball. On the break it has to go behind the dashed line.",
      keys: `<span class="hchip">Tap to place</span>${key("P")}<span class="hchip dim">re-place</span>`,
    },
    {
      title: "Camera & replay", art: ART.camera,
      body: "Switch between the cue view and a top-down view with the 3D / 2D button. Replay the last shot from the corner button.",
      keys: `<span class="hchip">3D / 2D</span><span class="hchip">Replay</span>`,
    },
    {
      title: "Quick chat", art: ART.chat,
      body: "In online matches, tap the smiley to send a quick message to your opponent.",
      keys: `<span class="hchip">Tap the smiley</span>`,
    },
  ],
  rules: [
    {
      title: "Pick a group", art: ART.groups,
      body: "The first ball you pot decides your group: solids (1-7) or stripes (9-15). Keep potting yours to keep your turn.",
    },
    {
      title: "Sink the 8 ball last", art: ART.eight,
      body: "Clear your group, then pot the 8 ball to win. Potting it early, or scratching on it, loses the game.",
    },
    {
      title: "Fouls", art: ART.foul,
      body: "Scratching, hitting the wrong ball first, or not touching a cushion after contact is a foul. Your opponent gets the cue ball in hand.",
    },
    {
      title: "Shot clock", art: ART.clock,
      body: "Each shot is timed. The ring around the clock empties as time runs out. Run out of time and your opponent gets ball in hand.",
    },
  ],
  tournament: [
    {
      title: "Knockout bracket", art: ART.bracket,
      body: "Four players pay the same buy-in. Two semifinals, then a final. Lose a match and you are out.",
    },
    {
      title: "Bigger venues, bigger pots", art: `<div class="venues-art">${["Bar|#2fcf8a", "Vegas|#ff2bd6", "Dubai|#f5c451", "Hawaii|#ff9f43", "Space|#35e8ff"].map((v, i) => `<span style="--c:${v.split("|")[1]};height:${28 + i * 16}px"><i>${v.split("|")[0]}</i></span>`).join("")}</div>`,
      body: "Pick a venue: Local Bar, Las Vegas, Dubai, Hawaii or Space Station. Each one has a bigger buy-in and a bigger pot, and the match is played in that venue.",
    },
    {
      title: "How the pot works", art: `<div class="potmath"><b>B</b><span>&#8594;</span><b>2B</b><span>&#8594;</span><b>4B</b><small>buy-in &#183; semifinal win &#183; champion</small></div>`,
      body: "Semifinal winners carry their winnings into the final, so the final stakes double. The champion takes the whole pot, everyone else loses only their buy-in.",
    },
  ],
};

/** Illustrated guide, reachable from the top bar and from the in-match menu. */
export class Help {
  private root = document.getElementById("help")!;
  private tabs = document.getElementById("helpTabs")!;
  private body = document.getElementById("helpBody")!;
  private tab: Tab = "controls";
  private returnFocus: HTMLElement | null = null;

  constructor() {
    this.tabs.replaceChildren(
      ...TABS.map((t) => {
        const b = document.createElement("button");
        b.textContent = t.label;
        b.dataset.tab = t.id;
        b.setAttribute("role", "tab");
        b.onclick = () => { sfx.ui(); this.render(t.id); };
        return b;
      }),
    );
    document.getElementById("helpClose")!.onclick = () => this.close();
    document.getElementById("helpBtn")!.onclick = () => this.open();
    document.getElementById("helpMenuBtn")?.addEventListener("click", () => this.open());
    this.root.addEventListener("pointerdown", (e) => { if (e.target === this.root) this.close(); });
    document.addEventListener("keydown", (e) => {
      if (this.root.hidden) {
        if (e.key === "?" && !(e.target instanceof HTMLInputElement)) this.open();
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); this.close(); }
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const i = TABS.findIndex((t) => t.id === this.tab);
        const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
        sfx.hover();
        this.render(next.id);
      }
    });
    this.render("controls");
  }

  open(tab: Tab = this.tab): void {
    sfx.ui();
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.render(tab);
    this.root.hidden = false;
    document.getElementById("helpClose")!.focus({ preventScroll: true });
  }

  close(): void {
    if (this.root.hidden) return;
    sfx.ui();
    this.root.hidden = true;
    this.returnFocus?.focus?.({ preventScroll: true });
  }

  private render(tab: Tab): void {
    this.tab = tab;
    this.tabs.querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    this.body.scrollTop = 0;
    this.body.replaceChildren(
      ...CONTENT[tab].map((c, i) => {
        const el = document.createElement("article");
        el.className = "hcard";
        el.innerHTML =
          `<div class="hart">${c.art}</div><div class="hbody"><h3><span class="hnum">${i + 1}</span>${c.title}</h3><p>${c.body}</p>` +
          (c.keys ? `<div class="hkeys">${c.keys}</div>` : "") +
          `</div>`;
        return el;
      }),
    );
  }
}
