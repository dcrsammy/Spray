/* Spray: motion and gestures shared by every page.
 * Tilt (mouse or phone gyroscope), reveal on scroll, tap ripples and haptics, a glyph field
 * that scatters under your finger, decoding words, a live Lagos clock, count-ups and a cash burst.
 * Everything switches off for people who ask their phone for reduced motion. */
(function () {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(pointer: fine)").matches;
  const root = document.documentElement;

  /* ---------- device tilt + pointer → shared parallax values ---------- */
  let tx = 0, ty = 0, px = 0, py = 0;
  window.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { tx = (e.clientX / innerWidth - .5) * 2; ty = (e.clientY / innerHeight - .5) * 2; } }, { passive: true });
  function onTilt(e) { if (e.gamma == null) return; tx = Math.max(-1, Math.min(1, e.gamma / 22)); ty = Math.max(-1, Math.min(1, (e.beta - 45) / 22)); }
  let asked = false;
  function askTilt() {
    if (asked || reduce) return; asked = true;
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === "function") D.requestPermission().then((r) => { if (r === "granted") addEventListener("deviceorientation", onTilt); }).catch(() => {});
    else if (D) addEventListener("deviceorientation", onTilt);
  }
  if (!(window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function")) askTilt();
  else document.addEventListener("touchend", askTilt, { once: true });

  const tilts = new Set();
  function frame() {
    requestAnimationFrame(frame);
    if (reduce || document.hidden) return;
    px += (tx - px) * .07; py += (ty - py) * .07;
    root.style.setProperty("--px", px.toFixed(3)); root.style.setProperty("--py", py.toFixed(3));
    for (const el of tilts) {
      if (el._hover) continue;   // mouse is steering this one directly
      const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) continue;
      const k = el.dataset.tilt ? Number(el.dataset.tilt) : 7;
      el.style.transform = `perspective(900px) rotateY(${(px * k).toFixed(2)}deg) rotateX(${(-py * k * .8).toFixed(2)}deg)`;
      el.style.setProperty("--gx", (50 + px * 40).toFixed(1) + "%"); el.style.setProperty("--gy", (30 + py * 40).toFixed(1) + "%");
    }
  }
  requestAnimationFrame(frame);

  function makeTilt(el) {
    if (reduce || el._tilt) return; el._tilt = true; tilts.add(el);
    if (!el.querySelector(":scope > .glare")) { const g = document.createElement("span"); g.className = "glare"; el.append(g); }
    if (!fine) return;
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
      const k = el.dataset.tilt ? Number(el.dataset.tilt) * 1.6 : 12;
      el._hover = true; el.classList.add("live");
      el.style.transform = `perspective(900px) rotateY(${(x * k).toFixed(2)}deg) rotateX(${(-y * k).toFixed(2)}deg) scale(1.02)`;
      el.style.setProperty("--gx", ((x + .5) * 100).toFixed(1) + "%"); el.style.setProperty("--gy", ((y + .5) * 100).toFixed(1) + "%");
    });
    el.addEventListener("pointerleave", () => { el._hover = false; el.classList.remove("live"); el.style.transform = ""; });
  }

  /* ---------- reveal on scroll, staggered ---------- */
  const io = "IntersectionObserver" in window && !reduce ? new IntersectionObserver((list) => {
    list.forEach((x) => { if (x.isIntersecting) { x.target.classList.add("in"); io.unobserve(x.target); } });
  }, { rootMargin: "0px 0px -6% 0px" }) : null;
  const REVEAL = ".card, fieldset, .ev, .ticket, .tt, .fact, .lede, .hero > *, main > h1, main > h2, section > h2, .wrap > h1, .wrap > h2, .deck-item";
  function reveal(scope = document) {
    if (!io) return;
    const batch = new Map();
    scope.querySelectorAll(REVEAL).forEach((el) => {
      if (el.classList.contains("rv") || el.closest("[data-norv]")) return;
      const n = batch.get(el.parentNode) || 0; batch.set(el.parentNode, n + 1);
      el.classList.add("rv"); el.style.setProperty("--d", Math.min(n, 8) * 0.06 + "s"); io.observe(el);
    });
  }

  /* ---------- taps: ripple + tiny haptic ---------- */
  document.addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".btn, .chip, .pick"); if (!b || b.disabled) return;
    if (!reduce && b.classList.contains("btn")) {
      const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height) * 2.2, d = document.createElement("span");
      d.className = "ripple"; d.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
      b.append(d); setTimeout(() => d.remove(), 650);
    }
  }, { passive: true });
  document.addEventListener("click", (e) => { if (e.target.closest(".btn, .chip, .pick, .step button")) navigator.vibrate?.(6); });

  /* ---------- decoding words (data-rotate="owambe|rave|wedding") ---------- */
  const GLYPHS = "₦ẸỌṢẹọṣ#*+=%@0123456789";
  function decode(el, target) {
    if (reduce) { el.textContent = target; return; }
    const len = Math.max(el.textContent.length, target.length); let f = 0; const total = 16;
    clearInterval(el._dec);
    el._dec = setInterval(() => {
      let out = ""; const rev = Math.floor((f / total) * len);
      for (let k = 0; k < len; k++) out += k < rev ? target[k] || "" : target[k] === " " ? " " : k < target.length ? GLYPHS[(Math.random() * GLYPHS.length) | 0] : "";
      el.textContent = out; if (++f > total) { clearInterval(el._dec); el.textContent = target; }
    }, 42);
  }
  function rotators() {
    document.querySelectorAll("[data-rotate]").forEach((el) => {
      if (el._rot) return; el._rot = true;
      const words = el.dataset.rotate.split("|"); let i = 0; el.textContent = words[0];
      setInterval(() => { if (document.hidden) return; i = (i + 1) % words.length; decode(el, words[i]); }, 2600);
    });
  }

  /* ---------- live Lagos clock ---------- */
  function clocks() {
    const els = document.querySelectorAll("[data-clock]"); if (!els.length) return;
    const tick = () => { const t = new Date().toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" }); els.forEach((e) => (e.textContent = t)); };
    tick(); setInterval(tick, 15000);
  }

  /* ---------- count up a number (₦ or plain) ---------- */
  window.countTo = function (el, to, fmt = (n) => Math.round(n).toLocaleString("en-NG")) {
    const from = el._v ?? 0; el._v = to;
    if (reduce || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = Math.min(900, 300 + Math.abs(to - from) / 50);
    cancelAnimationFrame(el._raf);
    const step = (now) => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) el._raf = requestAnimationFrame(step); };
    el._raf = requestAnimationFrame(step);
  };

  /* ---------- cash burst: little naira notes fly out from a point ---------- */
  window.burst = function (x = innerWidth / 2, y = innerHeight / 2, n = 22) {
    if (reduce) return;
    const layer = document.createElement("div"); layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:999;overflow:hidden"; document.body.append(layer);
    const notes = [["#b9d8a8", "#2f5d34", "₦200"], ["#d8b3e8", "#5b2a6e", "₦500"], ["#a9c7e6", "#24476e", "₦1000"], ["#f2b632", "#1a1407", "₦"]];
    for (let i = 0; i < n; i++) {
      const [bg, fg, label] = notes[i % notes.length], d = document.createElement("span");
      const a = Math.random() * Math.PI * 2, v = 120 + Math.random() * 260, dx = Math.cos(a) * v, dy = Math.sin(a) * v - 160, rot = (Math.random() - .5) * 720;
      d.textContent = label;
      d.style.cssText = `position:absolute;left:${x}px;top:${y}px;padding:3px 8px;border-radius:4px;font:600 11px var(--mono);background:${bg};color:${fg};box-shadow:0 4px 10px rgba(0,0,0,.3);transform:translate(-50%,-50%)`;
      layer.append(d);
      d.animate([{ transform: "translate(-50%,-50%) scale(.4)", opacity: 1 }, { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 380}px)) rotate(${rot}deg) scale(1)`, opacity: 0 }],
        { duration: 1100 + Math.random() * 700, easing: "cubic-bezier(.2,.7,.4,1)", fill: "forwards" });
    }
    setTimeout(() => layer.remove(), 2000);
  };

  /* ---------- glyph field: a big ₦ made of characters that scatter under your finger ---------- */
  function field() {
    const cv = document.getElementById("field"); if (!cv) return;
    const cx = cv.getContext("2d"), dpr = Math.min(devicePixelRatio || 1, 2), SET = "₦ẸỌṢẹọṣ#*+=%@0125", word = cv.dataset.word || "₦";
    let cells = [], mx = -9999, my = -9999, born = performance.now(), last = 0;
    const pick = () => SET[(Math.random() * SET.length) | 0];
    function build() {
      const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
      cv.width = W * dpr; cv.height = H * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const small = W < 600, cw = small ? 8 : 10, ch = small ? 13 : 16;
      const off = document.createElement("canvas"); off.width = W; off.height = H; const o = off.getContext("2d");
      const top = cv.dataset.place === "top", size = top ? Math.min(H * .52, W * .92) : Math.min(H * .95, W * (small ? .95 : .5));
      o.font = `700 ${size}px "Hanken Grotesk", system-ui, sans-serif`; o.textAlign = "center"; o.textBaseline = "middle";
      o.fillText(word, top ? W * .5 : small ? W * .62 : W * .72, top ? H * .29 : H * .5);
      const data = o.getImageData(0, 0, W, H).data; cells = [];
      for (let y = ch / 2; y < H; y += ch) for (let x = cw / 2; x < W; x += cw) {
        const a = data[(((y | 0) * W) + (x | 0)) * 4 + 3];
        if (a > 120) cells.push({ x, y, c: pick(), d: Math.random() * 900 });
        else if (Math.random() < .014) cells.push({ x, y, c: "·", d: Math.random() * 900, faint: true });
      }
    }
    function draw(now) {
      requestAnimationFrame(draw);
      if (document.hidden || now - last < 33) return; last = now;
      const W = cv.clientWidth, H = cv.clientHeight; cx.clearRect(0, 0, W, H);
      cx.save(); cx.translate(-px * 16, -py * 12);
      cx.font = `500 ${W < 600 ? 10 : 12}px "JetBrains Mono", ui-monospace, monospace`; cx.textAlign = "center"; cx.textBaseline = "middle";
      const t = now / 1000, age = now - born, R = W < 600 ? 80 : 120;
      for (const c of cells) {
        if (age < c.d && !reduce) continue;
        if (c.faint) { cx.fillStyle = "rgba(163,172,198,.22)"; cx.fillText(c.c, c.x, c.y); continue; }
        const dx = c.x - mx, dy = c.y - my, dist = Math.hypot(dx, dy); let x = c.x, y = c.y, a = .28 + .14 * Math.sin(t * 1.4 + c.x * .03 + c.y * .05), col = "242,182,50";
        if (!reduce && Math.random() < .004) c.c = pick();
        if (dist < R) { const k = (R - dist) / R, push = k * k * 26; x += (dx / (dist || 1)) * push; y += (dy / (dist || 1)) * push; a = .45 + .5 * k; if (Math.random() < .25) c.c = pick(); if (k > .6) col = "238,240,246"; }
        cx.fillStyle = `rgba(${col},${a.toFixed(3)})`; cx.fillText(c.c, x, y);
      }
      cx.restore();
    }
    const host = cv.parentElement;
    const point = (x, y) => { const r = cv.getBoundingClientRect(); mx = x - r.left + px * 16; my = y - r.top + py * 12; };
    host.addEventListener("pointermove", (e) => point(e.clientX, e.clientY), { passive: true });
    host.addEventListener("pointerdown", (e) => point(e.clientX, e.clientY), { passive: true });
    host.addEventListener("touchmove", (e) => { const p = e.touches[0]; point(p.clientX, p.clientY); }, { passive: true });
    const away = () => { mx = my = -9999; };
    host.addEventListener("pointerleave", away); host.addEventListener("touchend", away);
    (document.fonts?.ready || Promise.resolve()).then(() => { build(); requestAnimationFrame(draw); });
    addEventListener("resize", () => { clearTimeout(cv._r); cv._r = setTimeout(build, 150); });
  }

  /* ---------- boot + watch for content added later (lists that load from the API) ---------- */
  function scan(scope) { reveal(scope); (scope.querySelectorAll ? scope : document).querySelectorAll(".tilt").forEach(makeTilt); }
  window.alive = { scan, makeTilt, decode };
  function boot() {
    scan(document); rotators(); clocks(); field();
    let q = false;
    new MutationObserver(() => { if (q) return; q = true; requestAnimationFrame(() => { q = false; scan(document); }); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
