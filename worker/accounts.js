/**
 * Organiser accounts: sign up / sign in with a phone number or email and a password.
 * Sessions are random tokens kept on the phone (localStorage) and stored here only as a SHA-256 hash.
 * Passwords are hashed with PBKDF2 (100,000 rounds, per-user salt).
 */
import { now, secret, sha, clean, fail, json, db, sessionOrganiser } from "./lib.js";

export const ACCOUNT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS organisers (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, organiser_id INTEGER NOT NULL, created TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_fails (login TEXT NOT NULL, at TEXT NOT NULL)`,
];
export const ACCOUNT_MIGRATIONS = ["ALTER TABLE events ADD COLUMN organiser_id INTEGER"];

/** One way to write each login: emails lower-case, Nigerian numbers as 0XXXXXXXXXX. */
export function normalLogin(v) {
  const s = clean(v, 80).toLowerCase();
  if (s.includes("@")) { if (!/^\S+@\S+\.\S+$/.test(s)) fail(400, "Check your email address."); return s; }
  let d = s.replace(/[^\d+]/g, "");
  if (d.startsWith("+234")) d = "0" + d.slice(4); else if (d.startsWith("234") && d.length === 13) d = "0" + d.slice(3);
  d = d.replace(/\D/g, "");
  if (d.length < 10 || d.length > 15) fail(400, "Enter your phone number (e.g. 0803 123 4567) or your email.");
  return d;
}
async function hashPassword(pw, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function newSession(env, organiserId) {
  const t = secret();
  await db(env).run("INSERT INTO sessions (token_hash, organiser_id, created) VALUES (?,?,?)", await sha(t), organiserId, now());
  return t;
}

export async function accountsApi(req, env, path, body) {
  const D = db(env), m = req.method;

  if (path === "/auth/signup" && m === "POST") {
    const name = clean(body.name, 50); if (!name) fail(400, "Enter your name or your brand's name.");
    const login = normalLogin(body.login);
    const pw = String(body.password || ""); if (pw.length < 8) fail(400, "Use a password of at least 8 characters.");
    if (await D.first("SELECT id FROM organisers WHERE login=?", login)) fail(409, "There's already an account with that number or email. Sign in instead.");
    const salt = secret();
    const r = await D.run("INSERT INTO organisers (login, name, pass_hash, salt, created) VALUES (?,?,?,?,?)", login, name, await hashPassword(pw, salt), salt, now());
    return json(201, { token: await newSession(env, r.meta.last_row_id), organiser: { name, login } });
  }

  if (path === "/auth/login" && m === "POST") {
    const login = normalLogin(body.login);
    const since = new Date(Date.now() - 15 * 60e3).toISOString();
    const fails = await D.first("SELECT COUNT(*) AS n FROM login_fails WHERE login=? AND at > ?", login, since);
    if (fails.n >= 8) fail(429, "Too many wrong tries. Wait 15 minutes and try again.");
    const o = await D.first("SELECT * FROM organisers WHERE login=?", login);
    if (!o || !same(await hashPassword(String(body.password || ""), o.salt), o.pass_hash)) {
      await D.run("INSERT INTO login_fails (login, at) VALUES (?,?)", login, now());
      fail(401, "That number/email and password don't match.");
    }
    await D.run("DELETE FROM login_fails WHERE login=? OR at < ?", login, since);
    return json(200, { token: await newSession(env, o.id), organiser: { name: o.name, login: o.login } });
  }

  if (path === "/auth/logout" && m === "POST") {
    const t = req.headers.get("X-Session") || "";
    if (t) await D.run("DELETE FROM sessions WHERE token_hash=?", await sha(t));
    return json(200, { ok: true });
  }

  if (path === "/me" && m === "GET") {
    const o = await sessionOrganiser(env, req); if (!o) fail(401, "Please sign in.");
    const rows = await D.all(`SELECT e.code, e.name, e.status, e.starts_at, e.city, e.flyer, e.listed, e.ticketing, e.created,
        (SELECT COUNT(*) FROM tickets t JOIN orders x ON x.id=t.order_id WHERE t.event_id=e.id AND x.status='paid') AS sold,
        (SELECT COALESCE(SUM(subtotal),0) FROM orders x WHERE x.event_id=e.id AND x.status='paid') AS revenue,
        (SELECT COALESCE(SUM(amount),0) FROM stacks s WHERE s.event_id=e.id AND s.status='paid') AS sprayed
      FROM events e WHERE e.organiser_id=? ORDER BY COALESCE(e.starts_at, e.created) DESC LIMIT 200`, o.id);
    return json(200, { organiser: { name: o.name, login: o.login }, events: rows.map((e) => ({ ...e, flyer: e.flyer ? "/img/" + e.flyer : null, listed: Boolean(e.listed), startsAt: e.starts_at })) });
  }

  // Move events created on this phone (before signing in) into the account
  if (path === "/me/claim" && m === "POST") {
    const o = await sessionOrganiser(env, req); if (!o) fail(401, "Please sign in.");
    let n = 0;
    for (const x of (Array.isArray(body.events) ? body.events : []).slice(0, 50)) {
      const e = await D.first("SELECT id, host_hash, organiser_id FROM events WHERE code=?", String(x.code || "").toUpperCase());
      if (e && !e.organiser_id && (await sha(String(x.hostKey || ""))) === e.host_hash) { await D.run("UPDATE events SET organiser_id=? WHERE id=?", o.id, e.id); n++; }
    }
    return json(200, { claimed: n });
  }
  return null;
}
