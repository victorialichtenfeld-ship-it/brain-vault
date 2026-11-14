// Background: a slowly turning 3D brain made of glowing nodes and links, with
// signals firing along the links. Typing in the try-it box, the recording box
// or the live notepad makes it fire harder. Purely visual: nothing here is
// stored or sent. Key presses in password fields are ignored.
"use strict";
(() => {
  const c = document.getElementById("bg"), g = c.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const PALETTE = [[200, 255, 62], [62, 230, 255], [155, 123, 255]]; // lime, cyan, violet
  const mix = (t) => {
    const s = Math.max(0, Math.min(1, t)) * (PALETTE.length - 1), i = Math.min(PALETTE.length - 2, Math.floor(s)), f = s - i;
    return PALETTE[i].map((v, k) => Math.round(v + (PALETTE[i + 1][k] - v) * f));
  };

  // Deterministic random, so the brain looks the same on every visit.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // Nodes on the surface of two hemispheres plus a cerebellum, with folds.
  const nodes = [];
  function lobe(n, cx, cy, cz, rx, ry, rz, keep) {
    for (let made = 0, tries = 0; made < n && tries < n * 20; tries++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      let x = s * Math.cos(a), y = u, z = s * Math.sin(a);
      if (!keep(x, y, z)) continue;
      const fold = 1 + 0.07 * Math.sin(9 * x + 5 * z) * Math.cos(7 * y + 3 * z);
      x = cx + x * rx * fold; y = cy + y * ry * fold; z = cz + z * rz * fold;
      nodes.push({ x, y, z, col: mix((z + 0.9) / 1.8), sx: 0, sy: 0, d: 0, heat: 0 });
      made++;
    }
  }
  lobe(190, -0.36, 0.08, 0, 0.5, 0.56, 0.86, (x) => x < 0.75);   // left hemisphere
  lobe(190, 0.36, 0.08, 0, 0.5, 0.56, 0.86, (x) => x > -0.75);   // right hemisphere
  lobe(50, 0, -0.5, -0.55, 0.42, 0.2, 0.26, (x, y) => y < 0.4);  // cerebellum
  lobe(16, 0, -0.62, -0.05, 0.1, 0.24, 0.1, () => true);          // brain stem

  // Links between near neighbours, a few per node.
  const edges = [], adj = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    const near = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y, dz = nodes[i].z - nodes[j].z, d = dx * dx + dy * dy + dz * dz;
      if (d < 0.05) near.push([d, j]);
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [, j] of near.slice(0, 3)) if (j > i || !adj[j].includes(i)) { edges.push([i, j]); adj[i].push(j); adj[j].push(i); }
  }

  const pulses = []; // signals travelling along links
  function fire(from = Math.floor(Math.random() * nodes.length), hops = 3) {
    const next = adj[from];
    if (!next.length) return;
    pulses.push({ a: from, b: next[Math.floor(Math.random() * next.length)], t: 0, speed: 1.6 + Math.random() * 1.4, hops });
  }

  let w = 0, h = 0, last = 0, angle = 0.6, quietUntil = 0;
  function size() {
    const r = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    c.width = w * r; c.height = h * r;
    g.setTransform(r, 0, 0, r, 0, 0);
  }

  function place() {
    const app = document.getElementById("app"), inApp = app && !app.hidden, narrow = w < 920;
    if (inApp) return { cx: w * 0.84, cy: h * 0.26, s: Math.min(w, h) * 0.24, alpha: 0.28 };
    if (narrow) return { cx: w * 0.62, cy: Math.min(h * 0.3, 300), s: Math.min(w * 0.5, 260), alpha: 0.45 };
    // Centre it in the free space of the landing's right column, above the scan box.
    const vis = document.querySelector(".hero-visual"), tryBox = document.querySelector(".try");
    if (vis && tryBox) {
      const r = vis.getBoundingClientRect(), free = r.height - tryBox.offsetHeight - 24;
      if (free > 200) return { cx: r.left + r.width / 2, cy: r.top + free / 2 + 10, s: Math.min(r.width * 0.4, free * 0.46), alpha: 1 };
    }
    return { cx: w * 0.73, cy: h * 0.45, s: Math.min(w * 0.27, h * 0.38), alpha: 1 };
  }

  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000 || 0);
    last = t;
    if (!still) angle += dt * 0.12;
    const { cx, cy, s, alpha } = place();
    const ca = Math.cos(angle), sa = Math.sin(angle), tilt = -0.32, ct = Math.cos(tilt), st = Math.sin(tilt);
    for (const n of nodes) {
      const x = n.x * ca - n.z * sa, z1 = n.x * sa + n.z * ca;
      const y = n.y * ct - z1 * st, z = n.y * st + z1 * ct;
      const p = 2.6 / (2.6 + z);
      n.sx = cx + x * s * p; n.sy = cy - y * s * p; n.d = (1 - z) / 2; // d: 0 back, 1 front
      n.heat = Math.max(0, n.heat - dt * 1.6);
    }
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = "lighter";

    // soft glow behind the brain
    const halo = g.createRadialGradient(cx, cy, 0, cx, cy, s * 1.5);
    halo.addColorStop(0, `rgba(62,230,255,${0.1 * alpha})`); halo.addColorStop(0.5, `rgba(155,123,255,${0.05 * alpha})`); halo.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = halo; g.fillRect(cx - s * 1.6, cy - s * 1.6, s * 3.2, s * 3.2);

    g.lineWidth = 0.7;
    for (const [i, j] of edges) {
      const a = nodes[i], b = nodes[j], depth = (a.d + b.d) / 2, hot = Math.max(a.heat, b.heat);
      const [r, gg, bb] = a.col;
      g.strokeStyle = `rgba(${r},${gg},${bb},${(0.05 + depth * 0.22 + hot * 0.5) * alpha})`;
      g.beginPath(); g.moveTo(a.sx, a.sy); g.lineTo(b.sx, b.sy); g.stroke();
    }
    for (const n of nodes) {
      const [r, gg, bb] = n.col, rad = 0.6 + n.d * 1.6 + n.heat * 2.2;
      g.fillStyle = `rgba(${r},${gg},${bb},${(0.25 + n.d * 0.6 + n.heat) * alpha})`;
      g.beginPath(); g.arc(n.sx, n.sy, rad, 0, Math.PI * 2); g.fill();
    }

    // travelling signals
    for (let k = pulses.length - 1; k >= 0; k--) {
      const p = pulses[k];
      p.t += dt * p.speed;
      const a = nodes[p.a], b = nodes[p.b];
      if (p.t >= 1) {
        b.heat = 1;
        pulses.splice(k, 1);
        if (p.hops > 0) fire(p.b, p.hops - 1);
        continue;
      }
      const x = a.sx + (b.sx - a.sx) * p.t, y = a.sy + (b.sy - a.sy) * p.t, [r, gg, bb] = a.col;
      const glow = g.createRadialGradient(x, y, 0, x, y, 7);
      glow.addColorStop(0, `rgba(255,255,255,${0.95 * alpha})`); glow.addColorStop(0.3, `rgba(${r},${gg},${bb},${0.7 * alpha})`); glow.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = glow; g.fillRect(x - 7, y - 7, 14, 14);
    }
    g.globalCompositeOperation = "source-over";

    if (!still && t > quietUntil && Math.random() < dt * 3.5 && pulses.length < 60) fire();
    if (!still) requestAnimationFrame(frame);
  }

  addEventListener("resize", () => { size(); if (still) frame(performance.now()); });
  size();
  requestAnimationFrame(frame);

  // Typing makes the brain fire.
  const SENSORS = new Set(["try-in", "cap-text", "live-text"]);
  document.addEventListener("keydown", (e) => {
    if (still || e.repeat || !e.target || !SENSORS.has(e.target.id)) return;
    for (let i = 0; i < 4; i++) fire(undefined, 4);
  }, true);

  // "Try it" readout on the landing screen.
  const box = document.getElementById("try-in");
  if (!box) return;
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const gaps = [];
  let prev = null, keys = 0;
  box.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const now = performance.now();
    keys++;
    if (prev !== null && now - prev < 2000) gaps.push(now - prev);
    if (gaps.length > 30) gaps.shift();
    prev = now;
    document.getElementById("try-keys").textContent = keys;
    if (gaps.length >= 5) {
      const m = avg(gaps), sd = Math.sqrt(avg(gaps.map((x) => (x - m) ** 2)));
      document.getElementById("try-speed").textContent = Math.round(60000 / m);
      document.getElementById("try-steady").textContent = Math.max(0, Math.min(100, Math.round(100 - (sd / m) * 100))) + "%";
    }
  });
})();
