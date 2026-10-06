/**
 * Spray (working name): digital money spraying for parties and clubs.
 * Cloudflare Worker + D1. Serves the web pages and the API.
 *
 * Money model (no balances held): a guest picks WHO to spray, buys a stack for that person,
 * and the payment goes to them. Flicks only reveal on screen money that is already theirs;
 * when the event ends, whatever is unrevealed goes out in one "finale rain".
 *
 * PAYMENTS_MODE: "demo" (default) marks stacks paid instantly with no real money.
 * "paystack" is where Paystack split payments to each recipient's subaccount plug in (see paystack()).
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, host_hash TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', partner TEXT, created TEXT NOT NULL, closed TEXT)`,
  `CREATE TABLE IF NOT EXISTS recipients (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, name TEXT NOT NULL, role TEXT, person_code TEXT, created TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS rec_event ON recipients (event_id)`,
  `CREATE TABLE IF NOT EXISTS people (code TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, key_hash TEXT NOT NULL, created TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stacks (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL, guest TEXT NOT NULL, anonymous INTEGER NOT NULL DEFAULT 0, amount INTEGER NOT NULL, fee INTEGER NOT NULL, note INTEGER NOT NULL, revealed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, token_hash TEXT NOT NULL, pay_ref TEXT, created TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS stack_event ON stacks (event_id)`,
  `CREATE TABLE IF NOT EXISTS flicks (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, stack_id INTEGER NOT NULL, amount INTEGER NOT NULL, notes INTEGER NOT NULL, finale INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS flick_event ON flicks (event_id, id)`
];
let ready = false;

/* ---------- settings (defaults agreed with Olawale; change here) ---------- */
const FEE_RATE = 0.03;            // added on top of each stack, paid by the guest
const PARTNER_SHARE = 0.25;       // DJ / MC / club share of our fee
const NOTES = [200, 500, 1000];   // note sizes a guest can throw
const MIN_STACK = 1000, MAX_STACK = 5_000_000;

/* ---------- helpers ---------- */
const now = () => new Date().toISOString();
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPH[b % ALPH.length]).join("");
const secret = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const clean = (s, n = 40) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (s, m) => { throw new HttpError(s, m); };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const db = (env) => ({
  first: (sql, ...a) => env.DB.prepare(sql).bind(...a).first(),
  all: async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results,
  run: (sql, ...a) => env.DB.prepare(sql).bind(...a).run(),
  p: (sql, ...a) => env.DB.prepare(sql).bind(...a),
});
const feeFor = (amount) => Math.ceil(amount * FEE_RATE);

async function eventByCode(env, c) {
  const e = await db(env).first("SELECT * FROM events WHERE code=?", String(c || "").toUpperCase());
  if (!e) fail(404, "We couldn't find that party. Check the code and try again.");
  return e;
}
async function hostOnly(env, req, e) {
  const k = req.headers.get("X-Host-Key") || "";
  if (!k || (await sha(k)) !== e.host_hash) fail(403, "Only the host can do that.");
}
const publicEvent = (e) => ({ code: e.code, name: e.name, kind: e.kind, status: e.status, partner: e.partner || null });

/** Sends any unrevealed money from every stack out as one finale rain. */
async function finale(env, e) {
  const D = db(env);
  const open = await D.all("SELECT id, amount, revealed, note FROM stacks WHERE event_id=? AND status='paid' AND revealed < amount", e.id);
  const stmts = [];
  for (const s of open) {
    const left = s.amount - s.revealed;
    stmts.push(D.p("INSERT INTO flicks (event_id, stack_id, amount, notes, finale, created) VALUES (?,?,?,?,1,?)", e.id, s.id, left, Math.ceil(left / s.note), now()));
    stmts.push(D.p("UPDATE stacks SET revealed = amount WHERE id=?", s.id));
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  return open.length;
}

/* ---------- payments ---------- */
async function takePayment(env, stack, recipient) {
  if ((env.PAYMENTS_MODE || "demo") === "demo") return { status: "paid", ref: "DEMO-" + code(8) };
  // Paystack (later): initialize a transaction for amount+fee with the recipient's subaccount as the split,
  // return its authorization_url to the guest, and mark the stack paid from the charge.success webhook.
  fail(501, "Live payments aren't switched on yet.");
}

/* ---------- API ---------- */
async function api(req, env, path) {
  const D = db(env), m = req.method;
  const body = m === "GET" ? {} : await req.json().catch(() => ({}));
  const seg = path.split("/").filter(Boolean); // ["events","CODE",...]

  if (path === "/config" && m === "GET") return json(200, { fee: FEE_RATE, notes: NOTES, min: MIN_STACK, max: MAX_STACK, stacks: [10000, 20000, 50000, 100000], mode: env.PAYMENTS_MODE || "demo" });

  // Personal spray code: anyone can get one and be sprayed at any event or club
  if (path === "/people" && m === "POST") {
    const name = clean(body.name, 30); if (!name) fail(400, "Enter the name people know you by.");
    const k = secret(); let c;
    for (let i = 0; i < 5; i++) { c = code(6); if (!(await D.first("SELECT code FROM people WHERE code=?", c))) break; }
    await D.run("INSERT INTO people (code, name, phone, key_hash, created) VALUES (?,?,?,?,?)", c, name, clean(body.phone, 20) || null, await sha(k), now());
    return json(201, { code: c, name, key: k });
  }
  if (seg[0] === "people" && seg[1] && m === "GET") {
    const p = await D.first("SELECT code, name FROM people WHERE code=?", seg[1].toUpperCase());
    if (!p) fail(404, "No one has that spray code.");
    const k = req.headers.get("X-Person-Key"); let received = null;
    if (k && (await sha(k)) === (await D.first("SELECT key_hash FROM people WHERE code=?", p.code)).key_hash) {
      const r = await D.first("SELECT COALESCE(SUM(s.amount),0) AS total, COUNT(*) AS n FROM stacks s JOIN recipients r ON r.id=s.recipient_id WHERE r.person_code=? AND s.status='paid'", p.code);
      received = { total: r.total, stacks: r.n };
    }
    return json(200, { ...p, received });
  }

  // Create an event (party or club night)
  if (path === "/events" && m === "POST") {
    const name = clean(body.name, 60); if (!name) fail(400, "Give the party a name, e.g. \"Tunde & Bisi's Wedding\".");
    const kind = ["wedding", "birthday", "club", "other"].includes(body.kind) ? body.kind : "other";
    const recs = (Array.isArray(body.recipients) ? body.recipients : []).map((r) => ({ name: clean(r.name, 30), role: clean(r.role, 20) })).filter((r) => r.name).slice(0, 20);
    if (!recs.length) fail(400, "Add at least one person guests can spray (the celebrant, the DJ…).");
    const k = secret(); let c;
    for (let i = 0; i < 5; i++) { c = code(5); if (!(await D.first("SELECT id FROM events WHERE code=?", c))) break; }
    const r = await D.run("INSERT INTO events (code, host_hash, name, kind, partner, created) VALUES (?,?,?,?,?,?)", c, await sha(k), name, kind, clean(body.partner, 40) || null, now());
    const id = r.meta.last_row_id;
    await env.DB.batch(recs.map((x) => D.p("INSERT INTO recipients (event_id, name, role, created) VALUES (?,?,?,?)", id, x.name, x.role || null, now())));
    return json(201, { code: c, hostKey: k });
  }

  if (seg[0] !== "events" || !seg[1]) fail(404, "Not found.");
  const e = await eventByCode(env, seg[1]);
  const sub = seg.slice(2).join("/");

  if (!sub && m === "GET") {
    const recipients = await D.all("SELECT id, name, role, person_code FROM recipients WHERE event_id=? ORDER BY id", e.id);
    return json(200, { event: publicEvent(e), recipients: recipients.map((r) => ({ id: r.id, name: r.name, role: r.role, guest: Boolean(r.person_code) })) });
  }

  // Buy a stack for one person
  if (sub === "stacks" && m === "POST") {
    if (e.status === "ended") fail(409, "This party has ended. Thanks for coming!");
    const amount = Math.round(Number(body.amount)), note = Number(body.note);
    if (!NOTES.includes(note)) fail(400, "Pick a note size.");
    if (!(amount >= MIN_STACK && amount <= MAX_STACK) || amount % note) fail(400, `Choose an amount between ₦${MIN_STACK.toLocaleString()} and ₦${MAX_STACK.toLocaleString()}, in whole ₦${note} notes.`);
    let rec;
    if (body.personCode) {   // spraying someone in the room by their personal spray code
      const p = await D.first("SELECT code, name FROM people WHERE code=?", String(body.personCode).toUpperCase());
      if (!p) fail(404, "No one has that spray code. Ask them to show it again.");
      rec = await D.first("SELECT * FROM recipients WHERE event_id=? AND person_code=?", e.id, p.code);
      if (!rec) { const r = await D.run("INSERT INTO recipients (event_id, name, role, person_code, created) VALUES (?,?,?,?,?)", e.id, p.name, "Guest", p.code, now()); rec = { id: r.meta.last_row_id, name: p.name }; }
    } else {
      rec = await D.first("SELECT * FROM recipients WHERE id=? AND event_id=?", Number(body.recipientId), e.id);
      if (!rec) fail(404, "Pick who you're spraying.");
    }
    const anonymous = body.anonymous ? 1 : 0, guest = clean(body.name, 30) || "Odogwu";
    const token = secret(), fee = feeFor(amount);
    const pay = await takePayment(env, { amount, fee }, rec);
    const r = await D.run("INSERT INTO stacks (event_id, recipient_id, guest, anonymous, amount, fee, note, status, token_hash, pay_ref, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      e.id, rec.id, guest, anonymous, amount, fee, note, pay.status, await sha(token), pay.ref, now());
    return json(201, { stack: { id: r.meta.last_row_id, amount, fee, note, revealed: 0, recipient: rec.name }, token, ref: pay.ref });
  }

  // Throw notes from a stack (the client batches quick flicks)
  if (/^stacks\/\d+\/flick$/.test(sub) && m === "POST") {
    if (e.status === "ended") fail(409, "This party has ended. Anything left went out in the finale.");
    const s = await D.first("SELECT * FROM stacks WHERE id=? AND event_id=?", Number(seg[3]), e.id);
    if (!s || (await sha(req.headers.get("X-Stack-Token") || "")) !== s.token_hash) fail(403, "This stack isn't yours.");
    if (s.status !== "paid") fail(409, "This stack hasn't been paid for yet.");
    const left = s.amount - s.revealed; if (left <= 0) return json(200, { revealed: s.revealed, left: 0 });
    const notes = Math.max(1, Math.min(50, Math.round(Number(body.notes) || 1)));
    const amt = Math.min(left, notes * s.note);
    const upd = await D.run("UPDATE stacks SET revealed = revealed + ? WHERE id=? AND revealed + ? <= amount", amt, s.id, amt);
    if (!upd.meta.changes) fail(409, "Try again.");
    await D.run("INSERT INTO flicks (event_id, stack_id, amount, notes, created) VALUES (?,?,?,?,?)", e.id, s.id, amt, Math.ceil(amt / s.note), now());
    return json(200, { revealed: s.revealed + amt, left: left - amt });
  }

  // Live feed for the big screen and guests: new flicks since an id, plus totals and leaderboard
  if (sub === "feed" && m === "GET") {
    const since = Math.max(0, Number(new URL(req.url).searchParams.get("since")) || 0);
    const rows = await D.all(
      `SELECT f.id, f.amount, f.notes, f.finale, s.note, CASE WHEN s.anonymous=1 THEN 'Odogwu' ELSE s.guest END AS guest, r.name AS recipient
       FROM flicks f JOIN stacks s ON s.id=f.stack_id JOIN recipients r ON r.id=s.recipient_id
       WHERE f.event_id=? AND f.id>? ORDER BY f.id LIMIT 200`, e.id, since);
    const tot = await D.first("SELECT COALESCE(SUM(f.amount),0) AS sprayed, COUNT(DISTINCT CASE WHEN s.anonymous=1 THEN 'anon'||s.id ELSE s.guest END) AS sprayers FROM flicks f JOIN stacks s ON s.id=f.stack_id WHERE f.event_id=?", e.id);
    const top = await D.all(
      `SELECT CASE WHEN s.anonymous=1 THEN 'Odogwu' ELSE s.guest END AS guest, SUM(f.amount) AS total
       FROM flicks f JOIN stacks s ON s.id=f.stack_id WHERE f.event_id=? GROUP BY s.anonymous, CASE WHEN s.anonymous=1 THEN s.id ELSE s.guest END ORDER BY total DESC LIMIT 5`, e.id);
    return json(200, { event: publicEvent(e), flicks: rows, sprayed: tot.sprayed, sprayers: tot.sprayers, top });
  }

  // Host controls
  if (sub === "status" && m === "POST") {
    await hostOnly(env, req, e);
    const to = body.status;
    if (!["open", "closing", "ended"].includes(to)) fail(400, "Unknown status.");
    if (e.status === "ended") fail(409, "This party has already ended.");
    await D.run("UPDATE events SET status=?, closed=CASE WHEN ?='ended' THEN ? ELSE closed END WHERE id=?", to, to, now(), e.id);
    const n = to === "ended" ? await finale(env, e) : 0;
    return json(200, { status: to, finaleStacks: n });
  }
  if (sub === "dashboard" && m === "GET") {
    await hostOnly(env, req, e);
    const ledger = await D.all(
      `SELECT s.id, s.guest, s.anonymous, s.amount, s.revealed, s.fee, s.created, r.name AS recipient, r.role
       FROM stacks s JOIN recipients r ON r.id=s.recipient_id WHERE s.event_id=? AND s.status='paid' ORDER BY s.id DESC`, e.id);
    const byRecipient = await D.all(
      `SELECT r.name, r.role, COALESCE(SUM(s.amount),0) AS total, COUNT(s.id) AS stacks FROM recipients r
       LEFT JOIN stacks s ON s.recipient_id=r.id AND s.status='paid' WHERE r.event_id=? GROUP BY r.id ORDER BY total DESC`, e.id);
    const total = ledger.reduce((a, x) => a + x.amount, 0), fees = ledger.reduce((a, x) => a + x.fee, 0);
    return json(200, { event: publicEvent(e), total, fees, partnerEarnings: e.partner ? Math.floor(fees * PARTNER_SHARE) : 0, byRecipient, ledger });
  }
  fail(404, "Not found.");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Short links: /e/CODE (guests), /s/CODE (big screen), /d/CODE (host dashboard), /p/CODE (personal spray code)
    const short = /^\/(e|s|d|p)\/[A-Za-z0-9]+\/?$/.exec(url.pathname);
    if (short) return env.ASSETS.fetch(new Request(new URL("/" + short[1], url), req));   // served as e.html, s.html…
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!env.DB) return json(503, { error: "The database isn't connected yet." });
    try {
      if (!ready) { await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))); ready = true; }
      if (req.method !== "GET") { const o = req.headers.get("Origin"); if (o && o !== url.origin) return json(403, { error: "Blocked." }); }
      return await api(req, env, url.pathname.slice(4));
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: "Something went wrong. Please try again." });
    }
  },
};
