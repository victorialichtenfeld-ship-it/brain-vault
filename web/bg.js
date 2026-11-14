// Background and landing demo: slow flowing signal lines behind the page.
// Typing in the "try it" box sends pulses along them and shows a live rhythm
// readout. Purely visual: nothing here is stored or sent.
"use strict";
(() => {
  const c = document.getElementById("bg"), g = c.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pulses = [], LINES = 7, MID = 3;
  let w = 0, h = 0;
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#c8ff3e";
  function size() {
    const r = window.devicePixelRatio || 1;
    w = innerWidth; h = innerHeight;
    c.width = w * r; c.height = h * r;
    g.setTransform(r, 0, 0, r, 0, 0);
  }
  function frame(t) {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = accent();
    for (let i = 0; i < LINES; i++) {
      const y0 = h * (0.3 + i * 0.075), near = 1 - Math.abs(i - MID) / MID;
      g.beginPath();
      for (let x = 0; x <= w; x += 6) {
        let y = y0 + Math.sin(x * 0.004 + t * 0.0004 + i) * 18 + Math.sin(x * 0.011 - t * 0.0007 + i * 2) * 7;
        for (const p of pulses) {
          const age = (t - p.born) / 1000, d = x - age * w * 0.5;
          if (d > -120 && d < 120) y += Math.exp(-(d * d) / 1800) * p.amp * Math.exp(-age * 0.8) * Math.sin(d * 0.16 + i) * (0.4 + near);
        }
        if (x) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.globalAlpha = i === MID ? 0.32 : 0.05 + 0.1 * near;
      g.lineWidth = i === MID ? 1.6 : 1;
      g.stroke();
    }
    g.globalAlpha = 1;
    while (pulses.length && t - pulses[0].born > 3500) pulses.shift();
    if (!still) requestAnimationFrame(frame);
  }
  addEventListener("resize", () => { size(); if (still) frame(0); });
  size();
  requestAnimationFrame(frame);

  // "Try it" readout on the landing screen.
  const box = document.getElementById("try-in");
  if (!box) return;
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const gaps = [];
  let last = null, keys = 0;
  box.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const now = performance.now();
    keys++;
    if (last !== null && now - last < 2000) gaps.push(now - last);
    if (gaps.length > 30) gaps.shift();
    last = now;
    if (!still) pulses.push({ born: now, amp: 26 + Math.random() * 18 });
    document.getElementById("try-keys").textContent = keys;
    if (gaps.length >= 5) {
      const m = avg(gaps), sd = Math.sqrt(avg(gaps.map((x) => (x - m) ** 2)));
      document.getElementById("try-speed").textContent = Math.round(60000 / m);
      document.getElementById("try-steady").textContent = Math.max(0, Math.min(100, Math.round(100 - (sd / m) * 100))) + "%";
    }
  });
})();
