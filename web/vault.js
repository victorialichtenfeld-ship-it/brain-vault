// Brain Data Vault: front end for contracts/src/BrainVault.sol.
//  - the signal is your typing rhythm: key timings and mouse movement, never
//    the letters themselves; each recording is encrypted in the browser with
//    AES-256-GCM;
//  - the chain stores only each ciphertext's SHA-256 fingerprint, the owner's
//    per-app permissions and every read attempt;
//  - the data key and the demo app accounts are derived from one wallet
//    signature, so nothing secret is stored: unlocking the wallet restores them;
//  - nothing here prints, logs or renders a private key.
// In this demo the page releases data to an app after the contract allows the
// read. A real deployment needs a key holder that does that off chain.
"use strict";

const KEYSTORE = "brainvault.keystore.v1"; // encrypted JSON keystore (scrypt + AES-128-CTR)
const IDLE_LOCK_MS = 10 * 60 * 1000;
let LOG_WINDOW = 9000; // blocks of history to query; nodes cap eth_getLogs ranges
const SEED_MSG = "Brain Data Vault v1\n\nSigning this message unlocks your vault data key. Only sign it on the vault page.";
// Amounts for the local dev chain; boot() shrinks them on a public test chain,
// where coins come from a faucet in small amounts and fees are tiny.
let APP_FLOAT = ethers.parseEther("0.01"); // gas money sent to a demo app account
let APP_MIN = ethers.parseEther("0.002");
let FUND_BELOW = ethers.parseEther("0.05"); // ask for test coins under this balance
const LOCAL_PAGE = ["127.0.0.1", "localhost"].includes(location.hostname);
const CAPTURE_MS = 20000; // length of one typing recording
const BASELINE_MIN = 3;    // other recordings needed before scores compare you to your own normal
const LIVE_KEYS = 120;         // live mode saves a session every this many keys...
const LIVE_PAUSE_MS = 8000;    // ...or when you pause this long
const LIVE_MIN_KEYS = 40;      // ...with at least this many keys typed
const MIN_KEYS = 20;       // fewer key presses than this is too little to score
const HINT = "Your typing rhythm is the signal. Only key timing is recorded, never the letters.";
const $ = (id) => document.getElementById(id);

// Network settings; boot() overrides them from web/vault.config.json.
let NET = { name: "Local dev chain", symbol: "ETH", evmRpc: "http://127.0.0.1:9545", chainId: 31337, local: true };
const short = (h, n = 6) => (h && h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h || "");
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function ago(tsSec) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - tsSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function fmtCoin(wei, dp = 4) {
  const [whole, frac = ""] = ethers.formatEther(wei).split(".");
  const f = frac.slice(0, dp).replace(/0+$/, "");
  return BigInt(whole).toLocaleString("en-US") + (f ? "." + f : "");
}
function setConn(ok) {
  $("conn-dot").className = "dot " + (ok ? "live" : "down");
  $("conn-text").textContent = ok ? `${NET.name} · chain ${NET.chainId}` : `Cannot reach ${NET.evmRpc}`;
}

const ABI = [
  "function storeSession(bytes32 fingerprint) returns (uint256)",
  "function grant(address app)",
  "function revoke(address app)",
  "function requestRead(address owner, uint256 sessionId) returns (bool)",
  "function canRead(address owner, address app) view returns (bool)",
  "function sessionCount(address owner) view returns (uint256)",
  "function session(address owner, uint256 sessionId) view returns (bytes32 fingerprint, uint64 storedAt)",
  "event SessionStored(address indexed owner, uint256 indexed sessionId, bytes32 fingerprint)",
  "event AccessGranted(address indexed owner, address indexed app)",
  "event AccessRevoked(address indexed owner, address indexed app)",
  "event ReadAllowed(address indexed owner, address indexed app, uint256 indexed sessionId)",
  "event ReadDenied(address indexed owner, address indexed app, uint256 indexed sessionId)",
];
const EVENT_LABEL = { SessionStored: "Session stored", AccessGranted: "Access granted", AccessRevoked: "Access revoked", ReadAllowed: "Read allowed", ReadDenied: "Read denied" };
const APPS = [
  { id: "focus", name: "Focus Coach", desc: "Wellness app", color: "--s1" },
  { id: "lab", name: "Sleep Research Lab", desc: "University study", color: "--s3" },
  { id: "ads", name: "AdCorp", desc: "Advertising network", color: "--s2" },
];

const S = {
  cfg: null, provider: null, owner: null, address: null, vault: null, dataKey: null,
  apps: [], sessions: [], events: [], eventsFrom: 0, balance: 0n,
  selected: null, tampered: null, busy: false, funding: false,
};
let idle = null;
let redraw = () => {};

const show = (id, on) => { $(id).hidden = !on; };
const status = (text, isErr = false) => { const el = $("status"); el.textContent = text; el.className = isErr ? "hint err" : "hint"; };
const errText = (err) => err.shortMessage || err.message;
const sessionName = (id) => "S-" + String(id + 1).padStart(3, "0");
const readKeystore = () => { try { return localStorage.getItem(KEYSTORE); } catch { return null; } };

function notice(html) {
  show("locked", false); show("app", false); show("notice", true);
  $("notice-text").innerHTML = html;
}

// ---------- local ciphertext store (encrypted data only) ----------
const storeKey = () => `brainvault.data.v1:${S.cfg.chainId}:${S.cfg.address.toLowerCase()}:${S.address.toLowerCase()}`;
function readLocal() {
  try { return JSON.parse(localStorage.getItem(storeKey()) || "{}"); } catch { return {}; }
}
function writeLocal(id, iv, cipher) {
  const all = readLocal();
  all[id] = { iv: ethers.encodeBase64(iv), ct: ethers.encodeBase64(cipher) };
  try { localStorage.setItem(storeKey(), JSON.stringify(all)); return true; } catch { return false; }
}
// Ciphertext bytes for a session, with the demo's tampering applied.
function cipherOf(s) {
  if (!s.local) return null;
  const bytes = ethers.decodeBase64(s.local.ct);
  if (S.tampered === s.id) bytes[0] ^= 0xff;
  return bytes;
}
const matchesChain = (s) => ethers.sha256(cipherOf(s)) === s.fingerprint;
async function decrypt(s) {
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ethers.decodeBase64(s.local.iv) }, S.dataKey, cipherOf(s)));
  if (plain[0] === 0x7b) return JSON.parse(new TextDecoder().decode(plain)); // "{": a typing recording
  return { legacy: true, wave: Array.from(new Float32Array(plain.buffer)) }; // from the simulated-signal version
}

// ---------- canvas ----------
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function ctx2d() {
  const c = $("cv"), r = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * r; c.height = h * r;
  const g = c.getContext("2d");
  g.scale(r, r);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
function label(text, cls) { const l = $("view-label"); l.textContent = text; l.className = "pill " + cls; }
function drawWave(samples, upto = samples.length) {
  redraw = () => drawWave(samples, upto);
  const { g, w, h } = ctx2d();
  const ink = g.createLinearGradient(0, 0, w, 0);
  ink.addColorStop(0, "#c8ff3e"); ink.addColorStop(0.55, "#3ee6ff"); ink.addColorStop(1, "#9b7bff");
  g.strokeStyle = ink; g.shadowColor = "#3ee6ff"; g.shadowBlur = 12; g.lineWidth = 1.6; g.lineJoin = "round"; g.beginPath();
  for (let i = 0; i < upto; i++) {
    const x = (i / samples.length) * w, y = h / 2 - samples[i] * h * 0.35;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.stroke();
}
function drawNoise(bytes) {
  redraw = () => drawNoise(bytes);
  hideScores();
  const { g, w, h } = ctx2d(), cell = 6;
  g.fillStyle = cssVar("--ink");
  let k = 0;
  for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
    g.globalAlpha = (bytes[k++ % bytes.length] / 255) * 0.45;
    g.fillRect(x, y, cell, cell);
  }
  g.globalAlpha = 1;
}
function drawMessage(text, colorVar) {
  redraw = () => drawMessage(text, colorVar);
  hideScores();
  const { g, w, h } = ctx2d();
  g.fillStyle = cssVar(colorVar); g.font = `500 14px ${cssVar("--font-data")}`; g.letterSpacing = "2px"; text = text.toUpperCase(); g.textAlign = "center";
  g.fillText(text, w / 2, h / 2 + 6);
}

// ---------- typing signal ----------
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs) => { const m = avg(xs); return Math.sqrt(avg(xs.map((x) => (x - m) ** 2))); };
// Gaps between key presses as a trace in [-1, 1] for the viewer.
function normalize(xs) {
  const m = avg(xs), sd = std(xs) || 1;
  return xs.map((x) => Math.max(-1, Math.min(1, (x - m) / (3 * sd))));
}
// What one recording measures. Every score is built from these numbers.
function features(d) {
  const f = d.flight.filter((x) => x <= 2000), gap = avg(f);
  return {
    gap,                                                      // ms between key presses
    rhythm: gap ? std(f) / gap : 0,                           // unevenness of those gaps
    hold: avg(d.dwell),                                       // ms a key stays down
    errors: d.keys ? d.backspaces / d.keys : 0,               // share of keys that were Backspace
    pauses: d.flight.filter((x) => x > 1000).length,
    speed: d.durationMs ? Math.round(d.keys / (d.durationMs / 60000)) : 0,
    jitter: d.mouse.dist ? Math.min(20, (d.mouse.turns / d.mouse.dist) * 400) : 0,
  };
}
const pct = (x) => Math.round(Math.max(0, Math.min(100, x)));
// Rough 0-100 estimates using the same rules for everyone. Used until the vault
// has learned your normal. Heuristics, not a medical reading.
function score(d) {
  const x = features(d);
  return {
    speed: x.speed,
    focus: pct(100 - Math.max(0, x.rhythm - 0.3) * 90 - x.pauses * 6 - x.errors * 120),
    fatigue: pct((x.gap - 140) / 3 + (x.hold - 95) / 2.5 + x.errors * 100),
    stress: pct(x.errors * 220 + Math.max(0, x.rhythm - 0.5) * 60 + Math.max(0, x.speed - 330) / 6 + x.jitter),
  };
}

// Measurements of every typing recording that decrypts on this device.
// Decrypted in memory only; nothing is stored.
async function featureRows() {
  const rows = [];
  for (const s of S.sessions) {
    if (!s.local) continue;
    try { const d = await decrypt(s); if (!d.legacy) rows.push({ id: s.id, at: d.at ? Math.round(d.at / 1000) : s.storedAt, x: features(d) }); } catch { /* altered copy: leave it out */ }
  }
  return rows;
}
// Your normal: the average and spread of each measurement over a set of recordings.
function baseOf(rows) {
  const base = { n: rows.length };
  if (rows.length >= BASELINE_MIN) for (const k of Object.keys(rows[0].x)) {
    const xs = rows.map((r) => r.x[k]);
    base[k] = { m: avg(xs), sd: std(xs) };
  }
  return base;
}
const baseline = async (exceptId) => baseOf((await featureRows()).filter((r) => r.id !== exceptId));
// Smallest spread to assume, so a few near-identical recordings cannot turn a
// tiny change into a huge score.
const SPREAD_FLOOR = { gap: 15, rhythm: 0.08, hold: 10, errors: 0.02, pauses: 1, speed: 25, jitter: 1.5 };
// Scores against your normal: 50 means "as usual for you", each 15 points is one
// typical swing of yours.
const personalScore = (d, base) => scoreVsNormal(features(d), base);
function scoreVsNormal(x, base) {
  const z = {};
  for (const k of Object.keys(x)) z[k] = Math.max(-3, Math.min(3, (x[k] - base[k].m) / Math.max(base[k].sd, SPREAD_FLOOR[k])));
  return {
    speed: x.speed,
    speedVs: base.speed.m ? Math.round((x.speed / base.speed.m - 1) * 100) : 0,
    focus: pct(50 - 15 * (0.5 * z.rhythm + 0.25 * z.pauses + 0.25 * z.errors)),
    fatigue: pct(50 + 15 * (0.5 * z.gap + 0.3 * z.hold + 0.2 * z.errors)),
    stress: pct(50 + 15 * (0.4 * z.errors + 0.25 * z.rhythm + 0.2 * z.speed + 0.15 * z.jitter)),
  };
}
function versusNormal(v) {
  const d = v - 50, dir = d > 0 ? "higher" : "lower";
  return Math.abs(d) < 8 ? "normal for you" : Math.abs(d) < 20 ? `a bit ${dir} than usual` : `much ${dir} than usual`;
}
function hideScores() { $("scores").hidden = $("scores-note").hidden = true; }
function renderScores(d, base, lead = "") {
  const personal = base.n >= BASELINE_MIN, sc = personal ? personalScore(d, base) : d.scores, vs = sc.speedVs;
  const gauge = (k, v, p, color, sub) => `<div class="stat gauge" style="--p:${p};--c:var(${color})">
    <div class="ring"><b data-to="${v}">${v}</b></div>
    <div class="gauge-text"><span class="k">${k}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</div></div>`;
  const of100 = (k, v, color) => gauge(k, v, v, color, personal ? versusNormal(v) : "out of 100");
  $("scores").innerHTML = of100("Focus", sc.focus, "--s1") + of100("Fatigue", sc.fatigue, "--s2") + of100("Stress", sc.stress, "--s3")
    + gauge("Speed", sc.speed, Math.min(100, sc.speed / 6), "--muted", personal && Math.abs(vs) >= 5 ? `keys/min · ${Math.abs(vs)}% ${vs > 0 ? "faster" : "slower"} than usual` : "keys per minute");
  // Live mode redraws every second, so only animate a one-off reading.
  $("scores").classList.toggle("still", Boolean(lead));
  if (!lead && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    $("scores").querySelectorAll("[data-to]").forEach((el) => {
      const to = Number(el.dataset.to), t0 = performance.now();
      const step = (t) => { const k = Math.max(0, Math.min(1, (t - t0) / 1000)); el.textContent = Math.round(to * (1 - (1 - k) ** 3)); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }
  $("scores-note").textContent = lead + (personal
    ? `Compared with your normal, learned from your ${base.n} other recordings. 50 means the same as usual.`
    : `Learning your normal: ${base.n} of ${BASELINE_MIN} other recordings so far. Until then these scores use general rules.`);
  $("scores").hidden = $("scores-note").hidden = false;
}
// Decrypts a session into the viewer. Throws if the ciphertext was altered.
async function reveal(s) {
  const d = await decrypt(s);
  if (d.legacy) { hideScores(); return drawWave(d.wave); }
  const base = await baseline(s.id);
  drawWave(normalize(d.flight));
  renderScores(d, base);
}

// ---------- trend chart ----------
const SERIES = [["focus", "Focus", "--s1"], ["fatigue", "Fatigue", "--s2"], ["stress", "Stress", "--s3"]];
const DAY_PARTS = [[5, "morning"], [12, "afternoon"], [17, "evening"], [22, "night"]];
const dayPart = (ts) => { const h = new Date(ts * 1000).getHours(); return (DAY_PARTS.filter(([from]) => h >= from).pop() || DAY_PARTS[3])[1]; };
let trendPts = [];
async function loadTrend() {
  if (!S.owner) return;
  const rows = await featureRows();
  trendPts = rows.length > BASELINE_MIN
    ? rows.map((r) => ({ id: r.id, at: r.at, ...scoreVsNormal(r.x, baseOf(rows.filter((o) => o !== r))) })) : [];
  const need = BASELINE_MIN + 1 - rows.length;
  $("trend-note").textContent = trendPts.length ? insight(trendPts)
    : `Record ${need} more session${need === 1 ? "" : "s"} to see your trend. The chart compares each session with your own normal.`;
  drawTrend();
}
function insight(pts) {
  const groups = {};
  for (const p of pts) (groups[dayPart(p.at)] ||= []).push(p.focus);
  const parts = Object.entries(groups).filter(([, v]) => v.length >= 2).map(([k, v]) => [k, Math.round(avg(v))]).sort((a, b) => b[1] - a[1]);
  if (parts.length < 2) return "50 is your normal. Record at different times of day to find out when you are sharpest.";
  const [best, worst] = [parts[0], parts[parts.length - 1]];
  return `You are sharpest in the ${best[0]} (focus ${best[1]} on average) and least focused in the ${worst[0]} (${worst[1]}). 50 is your normal.`;
}
function drawTrend() {
  const box = $("trend"), pts = trendPts;
  $("trend-legend").hidden = !pts.length;
  if (!pts.length) { box.innerHTML = ""; box.hidden = true; return; }
  box.hidden = false;
  const W = Math.max(320, box.clientWidth), H = 230, L = 34, R = 92, T = 12, B = 26;
  const X = (i) => L + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (W - L - R)), Y = (v) => T + (1 - v / 100) * (H - T - B);
  const every = Math.ceil(pts.length / Math.max(2, Math.floor((W - L - R) / 70)));
  let g = "";
  for (const v of [0, 50, 100]) g += `<line class="grid${v === 50 ? " mid" : ""}" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  pts.forEach((p, i) => { if (i % every === 0 || i === pts.length - 1) g += `<text class="tick" x="${X(i)}" y="${H - 6}" text-anchor="middle">${sessionName(p.id)}</text>`; });
  for (const [key, , color] of SERIES) {
    g += `<polyline class="line" style="stroke:var(${color})" points="${pts.map((p, i) => `${X(i)},${Y(p[key])}`).join(" ")}"/>`;
    if (pts.length <= 40) g += pts.map((p, i) => `<circle class="mark" style="fill:var(${color})" cx="${X(i)}" cy="${Y(p[key])}" r="4"/>`).join("");
  }
  // Direct labels at the line ends, nudged apart so they never overlap.
  const last = pts[pts.length - 1], ends = SERIES.map(([key, name]) => ({ name, v: last[key], y: Y(last[key]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 15);
  ends[ends.length - 1].y = Math.min(ends[ends.length - 1].y, H - B);
  for (let i = ends.length - 2; i >= 0; i--) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - 15);
  for (const e of ends) g += `<text class="end" x="${W - R + 12}" y="${e.y + 4}">${e.name} ${e.v}</text>`;
  g += `<line class="cross" id="trend-cross" y1="${T}" y2="${H - B}" hidden/>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Focus, fatigue and stress for each session, compared with your normal">${g}</svg><div id="trend-tip" class="tip" hidden></div>`;
  const svg = box.firstChild, tip = $("trend-tip"), cross = $("trend-cross");
  const nearest = (e) => { const x = e.clientX - svg.getBoundingClientRect().left; return Math.max(0, Math.min(pts.length - 1, Math.round(((x - L) / (W - L - R)) * (pts.length - 1)) || 0)); };
  svg.onmousemove = (e) => {
    const i = nearest(e), p = pts[i];
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.style.display = "";
    tip.innerHTML = `<div><strong>${sessionName(p.id)}</strong> <span class="muted">${esc(new Date(p.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span></div>`
      + SERIES.map(([key, name, color]) => `<div><i style="background:var(${color})"></i>${name} <b>${p[key]}</b> <span class="muted">${versusNormal(p[key])}</span></div>`).join("");
    tip.hidden = false;
    tip.style.left = `${Math.max(4, Math.min(X(i) + 12, W - tip.offsetWidth - 4))}px`;
  };
  svg.onmouseleave = () => { tip.hidden = true; cross.style.display = "none"; };
  cross.style.display = "none";
  svg.onclick = (e) => { if (live) return; const id = pts[nearest(e)].id; if (S.tampered !== id) S.tampered = null; select(id); };
}

// Collects key timings and mouse movement. Key identity is used only to count
// Backspace and to pair a key's press with its release; it is never stored.
function recorder(onKey = () => {}) {
  const down = new Map(), mouse = { dist: 0, turns: 0, x: null, y: null, dx: 0, dy: 0 };
  let keys, backspaces, t0, last, flight, dwell;
  const reset = () => { keys = backspaces = 0; t0 = last = null; flight = []; dwell = []; mouse.dist = mouse.turns = 0; };
  reset();
  const peek = () => {
    const d = { v: 1, kind: "typing", keys, backspaces, durationMs: Math.round(last - t0), flight: flight.slice(), dwell: dwell.slice(), mouse: { dist: Math.round(mouse.dist), turns: mouse.turns } };
    d.scores = score(d);
    return d;
  };
  return {
    get keys() { return keys; },
    get t0() { return t0; },
    get last() { return last; },
    peek,
    take() { const d = peek(); reset(); return d; },
    onDown(e) {
      if (e.repeat) return;
      const now = performance.now();
      if (t0 === null) t0 = now;
      keys++;
      if (e.key === "Backspace") backspaces++;
      if (last !== null) flight.push(Math.round(now - last));
      last = now;
      down.set(e.code, now);
      onKey(flight);
    },
    onUp(e) {
      const t = down.get(e.code);
      if (t !== undefined) { dwell.push(Math.round(performance.now() - t)); down.delete(e.code); }
    },
    onMove(e) {
      if (mouse.x !== null) {
        const dx = e.clientX - mouse.x, dy = e.clientY - mouse.y;
        mouse.dist += Math.hypot(dx, dy);
        if (dx * mouse.dx + dy * mouse.dy < 0) mouse.turns++;
        mouse.dx = dx; mouse.dy = dy;
      }
      mouse.x = e.clientX; mouse.y = e.clientY;
    },
  };
}
function listen(ta, rec, on) {
  const f = on ? "addEventListener" : "removeEventListener";
  ta[f]("keydown", rec.onDown); ta[f]("keyup", rec.onUp); document[f]("mousemove", rec.onMove);
}

// Records one timed typing session. Resolves to the recording,
// { tooShort: true }, or null when cancelled.
function capture() {
  return new Promise((resolve) => {
    const ta = $("cap-text");
    let timer = null;
    const rec = recorder((flight) => {
      if (!timer) timer = setInterval(tick, 200);
      if (flight.length > 1) drawWave(normalize(flight));
    });
    const finish = (result) => {
      clearInterval(timer);
      listen(ta, rec, false);
      ta.value = "";
      show("capture", false);
      resolve(result);
    };
    const save = () => finish(rec.keys < MIN_KEYS ? { tooShort: true } : rec.take());
    function tick() {
      const left = CAPTURE_MS - (performance.now() - rec.t0);
      $("cap-count").textContent = `${Math.max(0, Math.ceil(left / 1000))}s`;
      if (left <= 0) save();
    }
    listen(ta, rec, true);
    $("cap-stop").onclick = save;
    $("cap-cancel").onclick = () => finish(null);
    $("cap-count").textContent = `${CAPTURE_MS / 1000}s`;
    ta.value = "";
    show("capture", true);
    ta.focus();
  });
}

// ---------- live mode ----------
// Reads your rhythm while you write in the notepad: scores update as you type
// and each stretch of typing is encrypted and saved without a click.
let live = null;
async function startLive() {
  if (live || S.busy || !S.owner) return;
  const ta = $("live-text"), rec = recorder();
  live = { rec, ta, base: await baseline(-1), saved: 0, timer: setInterval(tickLive, 1000) };
  listen(ta, rec, true);
  ta.value = "";
  show("live-pad", true);
  hideScores();
  drawMessage("Live: start writing below", "--muted"); label("live", "fail");
  status("Live mode is on. Just write; sessions save themselves when you pause.");
  render();
  ta.focus();
}
function stopLive(note) {
  if (!live) return;
  const { rec, ta, timer, saved } = live;
  clearInterval(timer);
  listen(ta, rec, false);
  const rest = S.owner && !S.busy && !note && rec.keys >= LIVE_MIN_KEYS ? rec.take() : null;
  live = null;
  ta.value = "";
  show("live-pad", false);
  if (!S.owner) return;
  const done = () => {
    if (S.sessions.length) select(S.sessions[S.sessions.length - 1].id);
    else { drawMessage("No sessions yet. Record one.", "--muted"); label("idle", "pending"); render(); }
    if (note) status(note, true); else status(`Live mode stopped. ${saved + (rest ? 1 : 0)} session${saved + (rest ? 1 : 0) === 1 ? "" : "s"} saved.`);
  };
  if (rest) act(() => store(rest)).then(done); else done();
}
function tickLive() {
  if (!live) return;
  const { rec } = live, n = rec.keys;
  if (n >= MIN_KEYS) {
    const d = rec.peek();
    drawWave(normalize(d.flight)); label("live", "fail");
    renderScores(d, live.base, `Live reading from your last ${n} keys. `);
  }
  const quiet = rec.last === null ? 0 : performance.now() - rec.last;
  if (!S.busy && (n >= LIVE_KEYS || (n >= LIVE_MIN_KEYS && quiet > LIVE_PAUSE_MS))) saveLive(rec.take());
}
function saveLive(d) {
  act(async () => {
    try {
      const { id, kept, block } = await store(d);
      if (!live) return;
      live.saved++;
      live.base = await baseline(-1);
      status(kept ? `Live mode: ${sessionName(id)} saved by itself in block ${block}. Keep writing.` : `Live mode: ${sessionName(id)} is on chain, but this browser blocks local storage.`, !kept);
    } catch (err) {
      stopLive(`Live mode stopped: ${errText(err)}`);
    }
  });
}

// ---------- browser sensor (optional extension) ----------
// The extension in extension/ measures typing rhythm on other pages and keeps
// the recordings until this page, unlocked, collects them. What arrives is
// treated as untrusted: it is rebuilt field by field before it is stored.
const sensor = { seen: false, total: 0, paused: false };
const toPage = (type) => window.postMessage({ source: "brainvault-page", type }, location.origin);
const pullSensor = () => { if (S.owner && !S.busy && !live) toPage("pull"); };
function cleanRecording(r) {
  const int = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
  const list = (xs, max) => (Array.isArray(xs) && xs.length <= 5000 ? xs.map((v) => int(v, max)) : [null]);
  if (!r || typeof r !== "object" || !r.mouse) return null;
  const d = {
    v: 1, kind: "typing", source: "extension", at: int(r.at, Date.now() + 60000),
    keys: int(r.keys, 5000), backspaces: int(r.backspaces, 5000), durationMs: int(r.durationMs, 3600000),
    flight: list(r.flight, 3600000), dwell: list(r.dwell, 60000),
    mouse: { dist: int(r.mouse.dist, 1e9), turns: int(r.mouse.turns, 1e7) },
  };
  const all = [d.at, d.keys, d.backspaces, d.durationMs, d.mouse.dist, d.mouse.turns, ...d.flight, ...d.dwell];
  if (all.includes(null) || d.keys < MIN_KEYS || d.backspaces > d.keys || d.flight.length < MIN_KEYS - 1) return null;
  d.scores = score(d);
  return d;
}
function renderSensor() {
  $("s-sensor").textContent = !sensor.seen ? "not installed" : (sensor.paused ? "paused" : "on") + (sensor.total > 0 ? ` · ${sensor.total} waiting` : "");
}
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== "brainvault-ext" || e.data.type !== "pending") return;
  sensor.seen = true; sensor.total = Number(e.data.total) || 0; sensor.paused = Boolean(e.data.paused);
  renderSensor();
  const items = Array.isArray(e.data.items) ? e.data.items.slice(0, 10) : [];
  if (!items.length || !S.owner || S.busy || live) return;
  act(async () => {
    let saved = 0;
    for (const raw of items) {
      const d = cleanRecording(raw);
      if (d) { await store(d); saved++; }
      toPage("ack"); // stored or unusable: either way the sensor can forget it
      sensor.total = Math.max(0, sensor.total - 1);
      renderSensor();
      if (!S.owner) return;
    }
    if (saved && S.selected == null) select(S.sessions[S.sessions.length - 1].id);
    if (saved) status(`Browser sensor: ${saved} session${saved === 1 ? "" : "s"} from your typing on other pages encrypted and saved.`);
    if (sensor.total > 0) setTimeout(pullSensor, 1000);
  });
});
setInterval(pullSensor, 15000);

// ---------- lock / unlock ----------
function renderLocked() {
  const wasLive = live; live = null;
  if (wasLive) { clearInterval(wasLive.timer); listen(wasLive.ta, wasLive.rec, false); wasLive.ta.value = ""; show("live-pad", false); }
  Object.assign(S, { owner: null, address: null, vault: null, dataKey: null, apps: [], sessions: [], events: [], selected: null, tampered: null, busy: false });
  clearTimeout(idle);
  redraw = () => {};
  show("notice", false); show("app", false); show("locked", true);
  const has = !!readKeystore();
  show("f-unlock", has); show("f-create", !has);
  $("locked-title").textContent = has ? "Unlock your vault" : "Create your vault";
  $("unlock-msg").className = "hint";
  $("unlock-msg").textContent = "";
}

$("f-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("unlock-msg"), pw = $("create-pw").value;
  const fail = (text) => { m.className = "hint err"; m.textContent = text; };
  if (pw !== $("create-pw2").value) return fail("The two passwords do not match.");
  try {
    const w = ethers.Wallet.createRandom();
    const json = await w.encrypt(pw, (p) => { m.className = "hint"; m.textContent = `Encrypting key… ${Math.round(p * 100)}%`; });
    try { localStorage.setItem(KEYSTORE, json); } catch { throw new Error("This browser blocks local storage, so the key cannot be kept. Use a normal (non-private) window."); }
    $("create-pw").value = $("create-pw2").value = "";
    m.textContent = "";
    await start(new ethers.Wallet(w.privateKey));
  } catch (err) {
    fail(errText(err));
  }
});

$("f-unlock").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("unlock-msg");
  try {
    const w = await ethers.Wallet.fromEncryptedJson(readKeystore(), $("unlock-pw").value, (p) => { m.className = "hint"; m.textContent = `Decrypting… ${Math.round(p * 100)}%`; });
    $("unlock-pw").value = "";
    m.textContent = "";
    await start(w);
  } catch (err) {
    m.className = "hint err";
    m.textContent = /invalid password/i.test(err.message) ? "Wrong password." : errText(err);
  }
});

async function start(wallet) {
  S.owner = wallet.connect(S.provider);
  S.address = await S.owner.getAddress();
  S.vault = new ethers.Contract(S.cfg.address, ABI, S.owner);
  const seed = await S.owner.signMessage(SEED_MSG); // deterministic for a local key
  const derive = (tag) => ethers.keccak256(ethers.concat([seed, ethers.toUtf8Bytes(tag)]));
  S.dataKey = await crypto.subtle.importKey("raw", ethers.getBytes(derive("data-key")), "AES-GCM", false, ["encrypt", "decrypt"]);
  S.apps = APPS.map((a) => ({ ...a, wallet: new ethers.Wallet(derive("demo-app:" + a.id), S.provider), granted: false }));
  show("locked", false); show("app", true);
  label("idle", "pending");
  status(HINT);
  await refresh();
  if (S.sessions.length) select(S.sessions[S.sessions.length - 1].id);
  else drawMessage("No sessions yet. Record one.", "--muted");
  bumpIdle();
  renderSensor();
  pullSensor();
  autoFund();
}

function bumpIdle() {
  clearTimeout(idle);
  if (S.owner) idle = setTimeout(renderLocked, IDLE_LOCK_MS);
}
for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, bumpIdle, { passive: true });

// ---------- chain state ----------
async function refresh() {
  const v = S.vault, me = S.address, local = readLocal();
  const [count, balance, latest, ...grants] = await Promise.all([
    v.sessionCount(me), S.provider.getBalance(me), S.provider.getBlockNumber(),
    ...S.apps.map((a) => v.canRead(me, a.wallet.address)),
  ]);
  S.apps.forEach((a, i) => { a.granted = grants[i]; });
  S.balance = balance;
  const rows = await Promise.all(Array.from({ length: Number(count) }, (_, i) => v.session(me, i)));
  S.sessions = rows.map((r, id) => ({ id, fingerprint: r.fingerprint, storedAt: Number(r.storedAt), local: local[id] || null }));

  S.eventsFrom = Math.max(Number(S.cfg.deployBlock) || 0, latest - LOG_WINDOW);
  const logs = await S.provider.getLogs({ address: S.cfg.address, fromBlock: S.eventsFrom, toBlock: latest, topics: [null, ethers.zeroPadValue(me, 32)] });
  S.events = logs.map((l) => ({ log: l, ev: v.interface.parseLog(l) })).filter((e) => e.ev).reverse();
  render();
  await loadTrend();
}

function render() {
  $("s-owner").textContent = short(S.address, 6); $("s-owner").title = S.address;
  $("s-balance").innerHTML = `${fmtCoin(S.balance, 4)} <small>${esc(NET.symbol)}</small>`;
  $("s-contract").textContent = short(S.cfg.address, 6); $("s-contract").title = S.cfg.address;
  const low = S.balance < FUND_BELOW;
  $("fund").hidden = !low || !NET.local; $("fund").disabled = S.busy;
  show("coins", low && !NET.local && !S.funding);
  $("coins-addr").textContent = S.address;
  $("s-count").textContent = S.sessions.length;

  const sel = S.sessions.find((s) => s.id === S.selected);
  for (const id of ["rec", "dec", "tamper"]) $(id).disabled = S.busy;
  if (!sel || !sel.local) $("dec").disabled = $("tamper").disabled = true;
  if (live) $("rec").disabled = $("dec").disabled = $("tamper").disabled = true;
  $("live").disabled = S.busy && !live;
  $("live").textContent = live ? "Stop live mode" : "Start live mode";
  $("tamper").textContent = sel && S.tampered === sel.id ? "Undo tampering" : "Tamper with local copy";

  $("apps").innerHTML = S.apps.map((a) => `
    <div class="app-card${a.granted ? " on" : ""}" style="--c:var(${a.color})">
      <span class="app-avatar" aria-hidden="true">${esc(a.name[0])}</span>
      <div class="app-info"><strong>${esc(a.name)}</strong><span>${esc(a.desc)} · <span class="mono">${short(a.wallet.address, 4)}</span></span></div>
      <button type="button" class="switch" role="switch" aria-checked="${a.granted}" aria-label="Allow ${esc(a.name)}" title="${a.granted ? "Revoke" : "Grant"} access" data-toggle="${a.id}" ${S.busy ? "disabled" : ""}><span></span></button>
      <div class="app-foot"><span class="ev ${a.granted ? "ok" : "bad"}">${a.granted ? "Allowed" : "Blocked"}</span>
        <button type="button" class="ghost small" data-request="${a.id}" ${S.busy ? "disabled" : ""}>Request data</button></div>
    </div>`).join("");

  $("sessions").innerHTML = S.sessions.length ? S.sessions.slice().reverse().map((s) => `
    <tr class="pick ${s.id === S.selected ? "sel" : ""}" data-session="${s.id}">
      <td>${sessionName(s.id)}</td><td>${ago(s.storedAt)}</td><td>${short(s.fingerprint, 8)}</td>
      <td>${!s.local ? `<span class="muted">not stored here</span>` : matchesChain(s) ? `<span class="ev ok">Verified</span>` : `<span class="ev bad">Altered</span>`}</td>
    </tr>`).join("") : `<tr><td colspan="4" class="empty">No sessions yet. Record one to write its fingerprint to the chain.</td></tr>`;

  const appName = (addr) => S.apps.find((a) => a.wallet.address === addr)?.name || (addr === S.address ? "you" : short(addr, 4));
  const detail = ({ name, args }) => {
    if (name === "SessionStored") return `${sessionName(Number(args.sessionId))} · ${short(args.fingerprint, 6)}`;
    if (name === "AccessGranted" || name === "AccessRevoked") return esc(appName(args.app));
    return `${esc(appName(args.app))} · ${sessionName(Number(args.sessionId))}`;
  };
  $("events-note").textContent = `since block ${S.eventsFrom.toLocaleString("en-US")}`;
  $("events").innerHTML = S.events.length ? S.events.map(({ log, ev }) => `
    <tr><td><span class="ev ${ev.name === "ReadDenied" || ev.name === "AccessRevoked" ? "bad" : ev.name === "SessionStored" ? "info" : "ok"}">${EVENT_LABEL[ev.name] || ev.name}</span></td>
      <td>${detail(ev)}</td>
      <td>${log.blockNumber.toLocaleString("en-US")}</td>
      <td title="${log.transactionHash}">${short(log.transactionHash, 5)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">Nothing recorded for this account in this range.</td></tr>`;
}

function select(id) {
  const s = S.sessions.find((x) => x.id === id);
  if (!s) return;
  S.selected = id;
  if (!s.local) {
    drawMessage("Encrypted copy is not on this device", "--muted"); label("fingerprint only", "pending");
    status(`${sessionName(id)} was recorded in another browser. The chain has its fingerprint; the data stays where it was recorded.`);
  } else if (matchesChain(s)) {
    drawNoise(cipherOf(s)); label("encrypted", "pending");
    status(`${sessionName(id)}: this scramble is what anyone without your key sees. It matches the fingerprint on chain.`);
  } else {
    drawNoise(cipherOf(s)); label("altered", "fail");
    status(`${sessionName(id)}: the local copy no longer matches the fingerprint on chain, so it has been changed.`, true);
  }
  render();
}

// Run one user action at a time; refresh chain state afterwards.
async function act(fn) {
  if (S.busy || !S.owner) return;
  S.busy = true; render();
  try {
    await fn();
  } catch (err) {
    status(errText(err), true);
  } finally {
    S.busy = false;
    if (S.owner) await refresh().catch((err) => status(errText(err), true));
  }
}
async function mined(txPromise, what) {
  status(`${what}: waiting for the block…`);
  const tx = await txPromise;
  const r = await tx.wait(1, NET.local ? 60000 : 240000); // public test chains can take a while
  if (r.status !== 1) throw new Error(`${what}: included in block ${r.blockNumber} but failed.`);
  return r;
}
const eventIn = (receipt, name) => receipt.logs.map((l) => S.vault.interface.parseLog(l)).find((e) => e && e.name === name);

// ---------- free test coins ----------
// On the public test chain a new vault asks the Drip contract for its first
// coins, using the sponsor key published in vault.public.json. That key is
// public on purpose; the contract limits what it can do. If the drip is
// refused (already used, hourly limit, empty), the faucet steps show instead.
async function autoFund() {
  const d = S.cfg.drip;
  if (NET.local || S.balance >= FUND_BELOW || !d || !ethers.isAddress(d.address) || !/^0x[0-9a-fA-F]{64}$/.test(d.sponsorKey || "")) return;
  S.funding = true;
  const me = S.address;
  await act(async () => {
    const sponsor = new ethers.Wallet(d.sponsorKey, S.provider);
    const drip = new ethers.Contract(d.address, ["function drip(address to)", "error AlreadyFunded()", "error RateLimited()", "error Empty()", "error NotSponsor()"], sponsor);
    for (let attempt = 1; ; attempt++) {
      try {
        // The sponsor's top-up depends on its balance after gas is reserved, which
        // the estimate cannot see, so give it room.
        const gasLimit = (await drip.drip.estimateGas(me)) * 13n / 10n + 60000n;
        await mined(drip.drip(me, { gasLimit }), "Getting your free test coins (about 15 seconds)");
        if (S.address === me) status("Free test coins arrived. You're all set: record a session.");
        return;
      } catch (err) {
        // Two visitors at once can collide on the sponsor's nonce; one retry fixes that.
        const why = err.revert?.name || err.shortMessage || "";
        if (attempt < 2 && !/AlreadyFunded|RateLimited|Empty/.test(why)) { await new Promise((r) => setTimeout(r, 4000)); continue; }
        if (S.address === me) status(/RateLimited/.test(why) ? "Lots of new vaults this hour, so the free coins are paused. Use the faucet steps above, or try again later."
          : /Empty/.test(why) ? "The free-coin pot is empty right now. Use the faucet steps above."
          : "Couldn't get free coins automatically. Use the faucet steps above.", true);
        return;
      }
    }
  }).finally(() => { S.funding = false; if (S.owner) render(); });
}

// ---------- actions ----------
// Encrypts a recording, writes its fingerprint to the chain and keeps the
// ciphertext in this browser.
async function store(data, onCipher = () => {}) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, S.dataKey, new TextEncoder().encode(JSON.stringify(data))));
  onCipher(cipher);
  const r = await mined(S.vault.storeSession(ethers.sha256(cipher)), "Writing the fingerprint");
  const id = Number(eventIn(r, "SessionStored").args.sessionId);
  const kept = writeLocal(id, iv, cipher);
  await refresh();
  return { id, kept, block: r.blockNumber };
}
$("rec").addEventListener("click", () => act(async () => {
  label("recording", "fail");
  drawMessage("Start typing below", "--muted");
  status(`Type anything for ${CAPTURE_MS / 1000} seconds. The clock starts on your first key.`);
  const data = await capture();
  if (!data || data.tooShort) {
    if (S.selected != null) select(S.selected);
    else { drawMessage("No sessions yet. Record one.", "--muted"); label("idle", "pending"); }
    return status(data ? `Too short to read: type at least ${MIN_KEYS} keys.` : "Recording cancelled. Nothing was saved.", Boolean(data));
  }
  const { id, kept, block } = await store(data, (cipher) => { drawNoise(cipher); label("encrypted", "pending"); });
  select(id);
  status(kept ? `${sessionName(id)} encrypted here; its fingerprint is final in block ${block}.`
    : `${sessionName(id)} is on chain in block ${block}, but this browser blocks local storage, so the encrypted copy was not kept.`, !kept);
}));

$("dec").addEventListener("click", async () => {
  const s = S.sessions.find((x) => x.id === S.selected);
  if (!s || !s.local) return;
  try {
    await reveal(s); label("decrypted by owner", "ok");
    status(`${sessionName(s.id)} decrypted with your key. Nothing was sent anywhere.`);
  } catch {
    drawMessage("Decryption refused: data was altered", "--bad"); label("altered", "fail");
    status("AES-GCM rejects ciphertext that has been changed, so altered data cannot be passed off as real.", true);
  }
});

$("tamper").addEventListener("click", () => {
  if (S.selected == null) return;
  S.tampered = S.tampered === S.selected ? null : S.selected;
  select(S.selected);
  loadTrend(); // an altered copy drops out of the trend
});

$("lock").addEventListener("click", renderLocked);
$("coins-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(S.address); $("coins-copy").textContent = "Copied"; }
  catch { $("coins-copy").textContent = "Select and copy it"; }
});
// While the vault waits for test coins, look for them without a reload.
setInterval(() => { if (S.owner && !S.busy && !live && !NET.local && S.balance < FUND_BELOW) refresh().catch(() => {}); }, 8000);
$("live").addEventListener("click", () => (live ? stopLive() : startLive()));

// Local dev chains (anvil, hardhat) can set a balance directly; real chains cannot.
$("fund").addEventListener("click", () => act(async () => {
  try {
    await S.provider.send("anvil_setBalance", [S.address, ethers.toQuantity(ethers.parseEther("10"))]);
    await S.provider.send("evm_mine", []); // so the new balance shows without waiting for the next block
    status(`Added 10 test ${NET.symbol}.`);
  } catch {
    status(`This chain has no test-coin shortcut. Send some ${NET.symbol} to ${S.address} to pay for transactions.`, true);
  }
}));

$("sessions").addEventListener("click", (e) => {
  const row = e.target.closest("[data-session]");
  if (row && !live) { if (S.tampered !== Number(row.dataset.session)) S.tampered = null; select(Number(row.dataset.session)); }
});

$("apps").addEventListener("click", (e) => {
  const el = e.target.closest("[data-toggle], [data-request]");
  if (!el) return;
  const { toggle, request } = el.dataset;
  const app = S.apps.find((a) => a.id === (toggle || request));
  if (!app) return;
  if (toggle) act(async () => {
    const r = await mined(app.granted ? S.vault.revoke(app.wallet.address) : S.vault.grant(app.wallet.address), `${app.granted ? "Revoking" : "Granting"} ${app.name}`);
    status(`${app.name} ${app.granted ? "revoked" : "granted"} in block ${r.blockNumber}.`);
  });
  else act(() => requestRead(app));
});

async function requestRead(app) {
  const s = S.sessions.find((x) => x.id === S.selected);
  if (!s) return status("Select a session first.", true);
  if ((await S.provider.getBalance(app.wallet.address)) < APP_MIN) {
    await mined(S.owner.sendTransaction({ to: app.wallet.address, value: APP_FLOAT }), `Sending ${app.name} ${fmtCoin(APP_FLOAT, 6)} ${NET.symbol} for fees`);
  }
  const r = await mined(S.vault.connect(app.wallet).requestRead(S.address, s.id), `${app.name} is asking the contract`);
  if (!eventIn(r, "ReadAllowed")) {
    drawMessage(`ACCESS DENIED: ${app.name}`, "--bad"); label("denied", "fail");
    return status(`The contract denied ${app.name} in block ${r.blockNumber}. The attempt is on chain.`);
  }
  if (!s.local) {
    drawMessage("Allowed, but the data is not on this device", "--muted"); label("allowed", "ok");
    return status(`The contract allowed ${app.name} in block ${r.blockNumber}.`);
  }
  try {
    await reveal(s); label(`shared with ${app.name}`, "ok");
    status(`The contract allowed ${app.name} to read ${sessionName(s.id)} in block ${r.blockNumber}.`);
  } catch {
    drawMessage("Allowed, but the local copy was altered", "--bad"); label("altered", "fail");
    status(`The contract allowed ${app.name}, but the local copy fails its integrity check.`, true);
  }
}

// ---------- boot ----------
new ResizeObserver(() => { if (!S.busy) redraw(); }).observe($("cv"));
new ResizeObserver(() => { if (S.owner) drawTrend(); }).observe($("trend-panel"));

(async function boot() {
  // The local page reads the address deploy.sh wrote; the public site reads the
  // committed public test chain settings.
  let cfg = null;
  try { const r = await fetch(LOCAL_PAGE ? "vault.config.json" : "vault.public.json", { cache: "no-store" }); if (r.ok) cfg = await r.json(); } catch { /* not deployed */ }
  if (!cfg || !ethers.isAddress(cfg.address)) return notice(LOCAL_PAGE
    ? `The vault contract is not deployed yet. Run <span class="mono">make chain</span>, then <span class="mono">make deploy</span>, then reload.`
    : `The vault is not live yet. Its contract is still being put on the public test chain. Check back soon.`);
  const local = Number(cfg.chainId) === 31337;
  NET = { ...NET, local, chainId: Number(cfg.chainId), evmRpc: cfg.rpc || NET.evmRpc, name: cfg.name || NET.name, symbol: cfg.symbol || NET.symbol };
  if (!local) {
    LOG_WINDOW = Number(cfg.logWindow) || LOG_WINDOW;
    if (/^https:\/\//.test(cfg.faucet || "")) $("coins-faucet").href = cfg.faucet;
  }
  S.provider = new ethers.JsonRpcProvider(NET.evmRpc, NET.chainId, { staticNetwork: true, pollingInterval: local ? 500 : 4000 });
  const fix = local ? ` Start it with <span class="mono">make chain</span>, run <span class="mono">make deploy</span>, then reload.` : ` Try again in a minute.`;
  let chainId;
  try { chainId = Number(await S.provider.send("eth_chainId", [])); }
  catch { setConn(false); return notice(`Cannot reach the chain at <span class="mono">${esc(NET.evmRpc)}</span>.${fix}`); }
  if (chainId !== NET.chainId) { setConn(false); return notice(`The chain at <span class="mono">${esc(NET.evmRpc)}</span> is chain ${chainId}, but the vault was deployed to chain ${esc(NET.chainId)}.`); }
  setConn(true);
  if (!local) {
    // Public test chains are nearly idle, yet ethers would offer a 1 gwei tip and
    // reserve far more test coins per transaction than a new vault holds. Offer a
    // small tip over the current base fee instead.
    S.provider.getFeeData = async () => {
      const base = (await S.provider.getBlock("latest"))?.baseFeePerGas ?? 0n, tip = 10000000n; // 0.01 gwei
      return new ethers.FeeData(null, base * 4n + tip, tip);
    };
    // Size the amounts from that fee, with a floor.
    const fee = await S.provider.getFeeData().catch(() => ({}));
    const oneTx = (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) * 350000n; // a save costs about 250k gas on Sepolia
    const atLeast = (a, b) => (a > b ? a : b);
    APP_MIN = atLeast(oneTx * 2n, ethers.parseEther("0.00002"));
    APP_FLOAT = APP_MIN * 4n;
    FUND_BELOW = atLeast(oneTx * 5n, ethers.parseEther("0.0005"));
  }
  if ((await S.provider.getCode(cfg.address)) === "0x") return notice(`No contract at <span class="mono">${esc(cfg.address)}</span>.${local ? " The chain was probably restarted. Run <span class=\"mono\">make deploy</span>, then reload." : ""}`);
  S.cfg = cfg;
  renderLocked();
})();
