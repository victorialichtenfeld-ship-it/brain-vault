// Brain Data Vault Sensor: content script.
// On ordinary pages it measures typing rhythm: when keys go down and up and how
// the mouse moves. It never reads which key was pressed (only whether it was
// Backspace), never reads page text or addresses, and skips password fields.
// On the vault page it does not record; it only hands waiting recordings over.
(() => {
  "use strict";
  const VAULT_ORIGINS = ["http://127.0.0.1:5180", "http://localhost:5180"];
  const KEYS = 120;      // hand over a recording every this many keys...
  const PAUSE_MS = 8000; // ...or after a pause this long
  const MIN_KEYS = 40;   // ...if at least this many keys were typed
  const STALE_MS = 30000; // a few stray keys followed by a long silence are dropped

  // The extension may be reloaded or removed while a page is open; then sending fails.
  const send = (msg) => { try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); } };

  if (VAULT_ORIGINS.includes(location.origin)) {
    if (window.top !== window) return;
    window.addEventListener("message", async (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== "brainvault-page") return;
      if (e.data.type === "pull") {
        const r = await send({ type: "pending" });
        if (r) window.postMessage({ source: "brainvault-ext", type: "pending", items: r.items, total: r.total, paused: r.paused }, location.origin);
      } else if (e.data.type === "ack") {
        await send({ type: "ack" }); // removes the oldest waiting recording
      }
    });
    return;
  }

  const down = new Map(), mouse = { dist: 0, turns: 0, x: null, y: null, dx: 0, dy: 0 };
  let keys, backspaces, t0, last, prev, flight, dwell, timer = null, paused = false;
  const reset = () => { keys = backspaces = 0; t0 = last = prev = null; flight = []; dwell = []; mouse.dist = mouse.turns = 0; down.clear(); };
  reset();

  try {
    chrome.storage.local.get("paused").then((v) => { paused = Boolean(v.paused); });
    chrome.storage.onChanged.addListener((c) => { if (c.paused) { paused = Boolean(c.paused.newValue); reset(); } });
  } catch { /* extension context gone */ }

  const secret = (t) => Boolean(t && t.tagName === "INPUT" && t.type === "password");

  function flush() {
    const d = { v: 1, kind: "typing", source: "extension", at: Date.now(), keys, backspaces, durationMs: Math.round(last - t0), flight, dwell, mouse: { dist: Math.round(mouse.dist), turns: mouse.turns } };
    reset();
    send({ type: "chunk", d });
  }
  function check() {
    if (!keys) { clearInterval(timer); timer = null; return; }
    const quiet = performance.now() - last;
    if (keys >= MIN_KEYS && quiet > PAUSE_MS) flush();
    else if (quiet > STALE_MS) reset();
  }

  window.addEventListener("keydown", (e) => {
    if (paused || e.repeat || !e.isTrusted) return;
    if (secret(e.target)) { prev = null; return; } // nothing from password fields, not even timing
    const now = performance.now();
    if (t0 === null) t0 = now;
    keys++;
    if (e.key === "Backspace") backspaces++;
    if (prev !== null) flight.push(Math.round(now - prev));
    prev = last = now;
    down.set(e.code, now);
    if (!timer) timer = setInterval(check, 2000);
    if (keys >= KEYS) flush();
  }, true);
  window.addEventListener("keyup", (e) => {
    const t = down.get(e.code);
    if (t !== undefined) { dwell.push(Math.round(performance.now() - t)); down.delete(e.code); }
  }, true);
  window.addEventListener("mousemove", (e) => {
    if (paused) return;
    if (mouse.x !== null) {
      const dx = e.clientX - mouse.x, dy = e.clientY - mouse.y;
      mouse.dist += Math.hypot(dx, dy);
      if (dx * mouse.dx + dy * mouse.dy < 0) mouse.turns++;
      mouse.dx = dx; mouse.dy = dy;
    }
    mouse.x = e.clientX; mouse.y = e.clientY;
  }, true);
  window.addEventListener("pagehide", () => { if (keys >= MIN_KEYS) flush(); });
})();
