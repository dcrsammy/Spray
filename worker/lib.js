// Shared helpers for the spray and events modules.
/* ---------- helpers ---------- */
export const now = () => new Date().toISOString();
export const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const code = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPH[b % ALPH.length]).join("");
export const secret = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const clean = (s, n = 40) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export const fail = (s, m) => { throw new HttpError(s, m); };
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
export const db = (env) => ({
  first: (sql, ...a) => env.DB.prepare(sql).bind(...a).first(),
  all: async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results,
  run: (sql, ...a) => env.DB.prepare(sql).bind(...a).run(),
  p: (sql, ...a) => env.DB.prepare(sql).bind(...a),
});
export async function eventByCode(env, c) {
  const e = await db(env).first("SELECT * FROM events WHERE code=?", String(c || "").toUpperCase());
  if (!e) fail(404, "We couldn't find that party. Check the code and try again.");
  return e;
}
export async function hostOnly(env, req, e) {
  const k = req.headers.get("X-Host-Key") || "";
  if (!k || (await sha(k)) !== e.host_hash) fail(403, "Only the host can do that.");
}
