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
