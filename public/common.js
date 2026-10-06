// Shared helpers for every page.
window.BRAND = { name: "Spray", mark: "₦" }; // working name: change here to rename everywhere

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const naira = (n) => "₦" + Math.round(Number(n) || 0).toLocaleString("en-NG");

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch("/api" + path, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}

function qr(target, text) {
  const q = qrcode(0, "M"); q.addData(text); q.make();
  target.innerHTML = q.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
}

function toast(msg) {
  let t = $(".toast"); if (!t) { t = el("div", { class: "toast", role: "status" }); document.body.append(t); }
  t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const codeFromPath = () => (location.pathname.split("/")[2] || "").toUpperCase();
document.addEventListener("DOMContentLoaded", () => $$("[data-brand]").forEach((n) => (n.textContent = BRAND.name)));

/** "Sat 31 Oct, 10:00 pm" in Nigerian time. */
function when(iso, opts = {}) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-NG", { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, ...opts });
}
/** Shrinks a photo to a JPEG (longest side 1200px) so flyers upload quickly on mobile data. */
function shrinkImage(file, max = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => reject(new Error("That file isn't an image we can read."));
    img.src = url;
  });
}
