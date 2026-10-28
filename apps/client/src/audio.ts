import jazzUrl from "./sounds/jazz_music.mp3";

const SFX_KEY = "8pool.sfxMuted";
const MUSIC_KEY = "8pool.musicMuted";
const LEGACY_KEY = "8pool.muted"; // single switch from before FX and music were split
const MUSIC_VOLUME = 0.25;

let ctx: AudioContext | null = null;
const readMuted = (key: string): boolean => {
  try { return (localStorage.getItem(key) ?? localStorage.getItem(LEGACY_KEY)) === "1"; } catch { return false; }
};
const writeMuted = (key: string, m: boolean): void => {
  try { localStorage.setItem(key, m ? "1" : "0"); } catch { /* storage unavailable */ }
};
let sfxMuted = readMuted(SFX_KEY);
let musicMuted = readMuted(MUSIC_KEY);

function ac(): AudioContext | null {
  if (sfxMuted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Short filtered noise burst with an optional pitched body: the building block of every effect. */
function hit(opts: { freq: number; dur: number; gain: number; noise?: number; type?: OscillatorType; bend?: number }): void {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const out = c.createGain();
  out.gain.setValueAtTime(opts.gain, t);
  out.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  out.connect(c.destination);

  const osc = c.createOscillator();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, opts.freq * (opts.bend ?? 0.5)), t + opts.dur);
  osc.connect(out);
  osc.start(t);
  osc.stop(t + opts.dur);

  if (opts.noise) {
    const len = Math.floor(c.sampleRate * Math.min(opts.dur, 0.05));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = opts.freq * 2.5;
    const g = c.createGain();
    g.gain.value = opts.noise;
    src.connect(f).connect(g).connect(out);
    src.start(t);
  }
}

export const sfx = {
  /** Ball on ball. `v` is 0..1 impact strength. */
  clack(v: number): void {
    const s = Math.min(1, Math.max(0.08, v));
    hit({ freq: 2300 + Math.random() * 300, dur: 0.07, gain: 0.5 * s, noise: 0.9, type: "triangle", bend: 0.6 });
  },
  cushion(v: number): void {
    const s = Math.min(1, Math.max(0.08, v));
    hit({ freq: 160, dur: 0.12, gain: 0.5 * s, noise: 0.3, type: "sine", bend: 0.6 });
  },
  pocket(): void {
    hit({ freq: 220, dur: 0.22, gain: 0.55, noise: 0.15, type: "sine", bend: 0.45 });
    window.setTimeout(() => hit({ freq: 130, dur: 0.25, gain: 0.35, type: "sine", bend: 0.7 }), 120);
  },
  cue(power: number): void {
    hit({ freq: 700, dur: 0.06, gain: 0.35 + 0.4 * power, noise: 1, type: "square", bend: 0.5 });
  },
  /** Soft tick when a menu item is highlighted. */
  hover(): void {
    hit({ freq: 1500, dur: 0.035, gain: 0.05, type: "sine", bend: 1.25 });
  },
  ui(): void {
    hit({ freq: 640, dur: 0.05, gain: 0.12, type: "sine", bend: 1.4 });
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => window.setTimeout(() => hit({ freq: f, dur: 0.25, gain: 0.2, type: "triangle", bend: 0.98 }), i * 110));
  },
  lose(): void {
    [392, 330, 262].forEach((f, i) => window.setTimeout(() => hit({ freq: f, dur: 0.3, gain: 0.2, type: "triangle", bend: 0.95 }), i * 150));
  },
};

export const isSfxMuted = (): boolean => sfxMuted;
export const isMusicMuted = (): boolean => musicMuted;

export function setSfxMuted(m: boolean): void {
  sfxMuted = m;
  writeMuted(SFX_KEY, m);
}

export function setMusicMuted(m: boolean): void {
  musicMuted = m;
  writeMuted(MUSIC_KEY, m);
  syncMusic();
}

/** One looping track under both the menu and the game. */
let music: HTMLAudioElement | null = null;

function syncMusic(): void {
  if (musicMuted) { music?.pause(); return; }
  if (!music) {
    music = new Audio(jazzUrl);
    music.loop = true;
    music.volume = MUSIC_VOLUME;
  }
  // Rejected until the first user gesture; the gesture listener below retries.
  void music.play().catch(() => undefined);
}

/** Browsers keep audio locked until a user gesture. */
export function unlockAudio(): void {
  ac();
  syncMusic();
}

for (const ev of ["pointerdown", "keydown"] as const) {
  const start = () => {
    document.removeEventListener("pointerdown", start);
    document.removeEventListener("keydown", start);
    syncMusic();
  };
  document.addEventListener(ev, start);
}
