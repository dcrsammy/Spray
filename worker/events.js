/**
 * Events: ticketing on top of Spray.
 * An event (the same row a spray party uses) can have details (date, venue, flyer, lineup, what's included),
 * tickets (free RSVP, one flat price, or several types with limits and early-bird prices),
 * orders with a ticket page per order, and QR check-in at the door.
 *
 * Payments follow PAYMENTS_MODE like spraying: "demo" marks orders paid instantly with no real money.
 */
import { now, code, secret, sha, clean, fail, json, db, eventByCode, hostOnly } from "./lib.js";

/* ---------- settings ---------- */
export const TICKET_FEE_RATE = 0.03;   // service fee on paid tickets, paid by the buyer…
export const TICKET_FEE_FLAT = 100;    // …plus ₦100 per paid ticket
const MAX_PER_ORDER = 20;
const LAGOS = "+01:00";                // dates are entered in Nigerian time

export const EVENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ticket_types (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, early_price INTEGER, early_until TEXT, quantity INTEGER, sold INTEGER NOT NULL DEFAULT 0, admits INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS tt_event ON ticket_types (event_id)`,
  `CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, event_id INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT, email TEXT, subtotal INTEGER NOT NULL, fee INTEGER NOT NULL, status TEXT NOT NULL, pay_ref TEXT, created TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS order_event ON orders (event_id)`,
  `CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, order_id INTEGER NOT NULL, event_id INTEGER NOT NULL, type_id INTEGER NOT NULL, price INTEGER NOT NULL, admits INTEGER NOT NULL DEFAULT 1, checked_in TEXT, created TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ticket_event ON tickets (event_id)`,
  `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created TEXT NOT NULL)`,
];
// Columns added to the existing events table (safe to run repeatedly; "duplicate column" errors are ignored).
export const EVENT_MIGRATIONS = [
  "ALTER TABLE events ADD COLUMN starts_at TEXT",
  "ALTER TABLE events ADD COLUMN venue TEXT",
  "ALTER TABLE events ADD COLUMN address TEXT",
  "ALTER TABLE events ADD COLUMN city TEXT",
  "ALTER TABLE events ADD COLUMN venue_hidden INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE events ADD COLUMN age_min INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE events ADD COLUMN about TEXT",
  "ALTER TABLE events ADD COLUMN includes TEXT",
  "ALTER TABLE events ADD COLUMN price_label TEXT",
  "ALTER TABLE events ADD COLUMN contact TEXT",
  "ALTER TABLE events ADD COLUMN flyer TEXT",
  "ALTER TABLE events ADD COLUMN listed INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE events ADD COLUMN ticketing TEXT NOT NULL DEFAULT 'none'",
  "ALTER TABLE events ADD COLUMN door_hash TEXT",
];

/* ---------- helpers ---------- */
const toTime = (v) => { const s = clean(v, 16); if (!s) return null; if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) fail(400, "Pick a valid date and time."); return s + ":00" + LAGOS; };
const priceNow = (t, at = Date.now()) => (t.early_price != null && t.early_until && at < Date.parse(t.early_until) ? t.early_price : t.price);
export const ticketFee = (subtotal, paidTickets) => (subtotal > 0 ? Math.ceil(subtotal * TICKET_FEE_RATE) + paidTickets * TICKET_FEE_FLAT : 0);
const parseList = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

/** Public view of an event's details. The venue stays hidden unless revealed (ticket holders, host). */
export function eventDetails(e, { reveal = false } = {}) {
  const hide = e.venue_hidden && !reveal;
  return {
    code: e.code, name: e.name, kind: e.kind, status: e.status, partner: e.partner || null,
    startsAt: e.starts_at || null, city: e.city || null,
    venue: hide ? null : e.venue || null, address: hide ? null : e.address || null, venueHidden: Boolean(e.venue_hidden),
    ageMin: e.age_min || 0, about: e.about || null, includes: parseList(e.includes),
    priceLabel: e.price_label || "Ticket", contact: e.contact || null,
    flyer: e.flyer ? "/img/" + e.flyer : null, listed: Boolean(e.listed), ticketing: e.ticketing || "none",
  };
}
const typeOut = (t) => ({ id: t.id, name: t.name, price: priceNow(t), fullPrice: t.price, earlyUntil: t.early_price != null && t.early_until && Date.now() < Date.parse(t.early_until) ? t.early_until : null,
  admits: t.admits, left: t.quantity == null ? null : Math.max(0, t.quantity - t.sold) });

/** Saves a flyer sent as a data URL (the page resizes it to a JPEG first). Returns the image id. */
async function saveImage(env, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) fail(400, "The flyer must be a JPEG, PNG or WebP image.");
  const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (bin.length > 1_500_000) fail(400, "That flyer is too large. Try a smaller image.");
  const id = code(16);
  await db(env).run("INSERT INTO images (id, mime, data, created) VALUES (?,?,?,?)", id, m[1], bin, now());
  return id;
}
export async function serveImage(env, id) {
  const r = await db(env).first("SELECT mime, data FROM images WHERE id=?", id);
  if (!r) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(r.data), { headers: { "Content-Type": r.mime, "Cache-Control": "public, max-age=604800, immutable" } });
}

/** Called when an event is created: details and ticket types. */
export async function createEventDetails(env, eventId, body) {
  const D = db(env);
  const ticketing = ["none", "free", "single", "types"].includes(body.ticketing) ? body.ticketing : "none";
  const includes = (Array.isArray(body.includes) ? body.includes : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 10);
  const flyer = body.flyer ? await saveImage(env, body.flyer) : null;
  const ageMin = Number(body.ageMin) === 18 ? 18 : 0;
  if (ticketing !== "none" && !body.startsAt) fail(400, "Add the date and time of the event.");
  await D.run(`UPDATE events SET starts_at=?, venue=?, address=?, city=?, venue_hidden=?, age_min=?, about=?, includes=?, price_label=?, contact=?, flyer=?, listed=?, ticketing=? WHERE id=?`,
    toTime(body.startsAt), clean(body.venue, 80) || null, clean(body.address, 160) || null, clean(body.city, 40) || null, body.venueHidden ? 1 : 0, ageMin,
    clean(body.about, 1000) || null, JSON.stringify(includes), clean(body.priceLabel, 20) || "Ticket", clean(body.contact, 40) || null, flyer, body.listed ? 1 : 0, ticketing, eventId);

  let types = [];
  if (ticketing === "free") types = [{ name: "Free RSVP", price: 0, quantity: body.capacity, admits: 1 }];
  else if (ticketing === "single") types = [{ name: clean(body.priceLabel, 20) || "Ticket", price: body.price, quantity: body.capacity, admits: 1, earlyPrice: body.earlyPrice, earlyUntil: body.earlyUntil }];
  else if (ticketing === "types") types = (Array.isArray(body.tickets) ? body.tickets : []).slice(0, 8);
  if (ticketing !== "none" && !types.length) fail(400, "Add at least one ticket type.");
  const stmts = types.map((t, i) => {
    const name = clean(t.name, 30); if (!name) fail(400, "Every ticket type needs a name.");
    const price = Math.round(Number(t.price) || 0); if (price < 0 || price > 10_000_000) fail(400, `Check the price of "${name}".`);
    if (ticketing !== "free" && price < 100) fail(400, `"${name}" needs a price of at least ₦100 (or choose Free RSVP).`);
    const qty = t.quantity === "" || t.quantity == null ? null : Math.round(Number(t.quantity));
    if (qty != null && !(qty >= 1 && qty <= 100000)) fail(400, `Check how many "${name}" tickets are available.`);
    const admits = Math.max(1, Math.min(50, Math.round(Number(t.admits) || 1)));
    const early = t.earlyPrice === "" || t.earlyPrice == null ? null : Math.round(Number(t.earlyPrice));
    const earlyUntil = early != null ? toTime(t.earlyUntil) : null;
    if (early != null && (!(early >= 100 && early < price) || !earlyUntil)) fail(400, `For "${name}", the early-bird price must be lower than the normal price and have an end date.`);
    return D.p("INSERT INTO ticket_types (event_id, name, price, early_price, early_until, quantity, admits, sort) VALUES (?,?,?,?,?,?,?,?)", eventId, name, price, early, earlyUntil, qty, admits, i);
  });
  if (stmts.length) await env.DB.batch(stmts);
}

/** Ticket numbers for the host dashboard. */
export async function ticketStats(env, e) {
  const D = db(env);
  const types = await D.all("SELECT * FROM ticket_types WHERE event_id=? ORDER BY sort, id", e.id);
  const t = await D.first(`SELECT COUNT(*) AS tickets, COALESCE(SUM(admits),0) AS people, COALESCE(SUM(CASE WHEN checked_in IS NOT NULL THEN admits ELSE 0 END),0) AS inside FROM tickets WHERE event_id=?`, e.id);
  const o = await D.first("SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal),0) AS revenue, COALESCE(SUM(fee),0) AS fees FROM orders WHERE event_id=? AND status='paid'", e.id);
  return { ticketing: e.ticketing || "none", types: types.map((x) => ({ name: x.name, price: priceNow(x), sold: x.sold, quantity: x.quantity, admits: x.admits })), ...t, ...o };
}

/* ---------- payments ---------- */
async function takeOrderPayment(env, total) {
  if (total === 0 || (env.PAYMENTS_MODE || "demo") === "demo") return { status: "paid", ref: total === 0 ? "FREE" : "DEMO-" + code(8) };
  // Paystack (later): initialize a transaction split to the organiser's subaccount; confirm from the charge.success webhook.
  fail(501, "Live payments aren't switched on yet.");
}

/* ---------- API ---------- */
export async function eventsApi(req, env, path, body) {
  const D = db(env), m = req.method, seg = path.split("/").filter(Boolean);

  // Upcoming events the organisers chose to list on the homepage
  if (path === "/listing" && m === "GET") {
    const rows = await D.all(`SELECT * FROM events WHERE listed=1 AND status<>'ended' AND starts_at IS NOT NULL AND starts_at >= ? ORDER BY starts_at LIMIT 30`, new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 16));
    const out = [];
    for (const e of rows) {
      const prices = (await D.all("SELECT * FROM ticket_types WHERE event_id=?", e.id)).map((t) => priceNow(t));
      out.push({ ...eventDetails(e), from: prices.length ? Math.min(...prices) : null });
    }
    return json(200, { events: out });
  }

  // A buyer's ticket page: the order code is the secret
  if (seg[0] === "orders" && seg[1] && m === "GET") {
    const o = await D.first("SELECT * FROM orders WHERE code=?", seg[1].toUpperCase());
    if (!o) fail(404, "We couldn't find that ticket. Check the link.");
    const e = await D.first("SELECT * FROM events WHERE id=?", o.event_id);
    const tickets = await D.all("SELECT t.code, t.admits, t.checked_in, t.price, y.name AS type FROM tickets t JOIN ticket_types y ON y.id=t.type_id WHERE t.order_id=? ORDER BY t.id", o.id);
    return json(200, { event: eventDetails(e, { reveal: o.status === "paid" }), order: { code: o.code, name: o.name, status: o.status, subtotal: o.subtotal, fee: o.fee, created: o.created }, tickets });
  }

  if (seg[0] !== "events" || !seg[1]) return null;
  const e = await eventByCode(env, seg[1]);
  const sub = seg.slice(2).join("/");

  // Event page data (public)
  if (sub === "page" && m === "GET") {
    const types = await D.all("SELECT * FROM ticket_types WHERE event_id=? ORDER BY sort, id", e.id);
    const lineup = await D.all("SELECT name, role FROM recipients WHERE event_id=? AND person_code IS NULL ORDER BY id", e.id);
    return json(200, { event: eventDetails(e), tickets: types.map(typeOut), lineup, fee: { rate: TICKET_FEE_RATE, flat: TICKET_FEE_FLAT } });
  }

  // Buy tickets / RSVP
  if (sub === "orders" && m === "POST") {
    if (e.status === "ended") fail(409, "This event has ended.");
    if (!e.ticketing || e.ticketing === "none") fail(409, "This event doesn't sell tickets here.");
    if (e.starts_at && Date.now() > Date.parse(e.starts_at) + 12 * 3600e3) fail(409, "Ticket sales for this event have closed.");
    if (e.age_min && !body.ageOk) fail(400, `This event is ${e.age_min}+. Please confirm you're ${e.age_min} or older.`);
    const name = clean(body.name, 40); if (!name) fail(400, "Enter your name for the ticket.");
    const phone = clean(body.phone, 20), email = clean(body.email, 80).toLowerCase();
    if (!phone && !email) fail(400, "Add a phone number or email so the organiser can reach you.");
    if (email && !/^\S+@\S+\.\S+$/.test(email)) fail(400, "Check your email address.");
    const items = (Array.isArray(body.items) ? body.items : []).map((i) => ({ typeId: Number(i.typeId), qty: Math.round(Number(i.qty) || 0) })).filter((i) => i.qty > 0);
    if (!items.length) fail(400, "Choose at least one ticket.");
    if (items.reduce((a, i) => a + i.qty, 0) > MAX_PER_ORDER) fail(400, `You can get up to ${MAX_PER_ORDER} tickets at once.`);
    const types = new Map((await D.all("SELECT * FROM ticket_types WHERE event_id=?", e.id)).map((t) => [t.id, t]));
    if (e.ticketing === "free" && items.reduce((a, i) => a + i.qty, 0) > 5) fail(400, "You can RSVP for up to 5 people at once.");
    // Reserve seats one type at a time; undo if any type is sold out.
    const done = [];
    for (const i of items) {
      const t = types.get(i.typeId); if (!t) { await undo(); fail(400, "That ticket type doesn't exist."); }
      const r = await D.run("UPDATE ticket_types SET sold = sold + ? WHERE id=? AND (quantity IS NULL OR sold + ? <= quantity)", i.qty, t.id, i.qty);
      if (!r.meta.changes) { await undo(); const left = Math.max(0, (t.quantity ?? 0) - t.sold); fail(409, left ? `Only ${left} "${t.name}" left.` : `"${t.name}" is sold out.`); }
      done.push(i);
    }
    async function undo() { for (const d of done) await D.run("UPDATE ticket_types SET sold = sold - ? WHERE id=?", d.qty, d.typeId); }

    const at = Date.now(); let subtotal = 0, paid = 0;
    for (const i of items) { const p = priceNow(types.get(i.typeId), at); subtotal += p * i.qty; if (p > 0) paid += i.qty; }
    const fee = ticketFee(subtotal, paid);
    let pay; try { pay = await takeOrderPayment(env, subtotal + fee); } catch (x) { await undo(); throw x; }
    const oc = code(12);
    const r = await D.run("INSERT INTO orders (code, event_id, name, phone, email, subtotal, fee, status, pay_ref, created) VALUES (?,?,?,?,?,?,?,?,?,?)", oc, e.id, name, phone || null, email || null, subtotal, fee, pay.status, pay.ref, now());
    const oid = r.meta.last_row_id, stmts = [];
    for (const i of items) { const t = types.get(i.typeId), p = priceNow(t, at);
      for (let k = 0; k < i.qty; k++) stmts.push(D.p("INSERT INTO tickets (code, order_id, event_id, type_id, price, admits, created) VALUES (?,?,?,?,?,?,?)", "T" + code(11), oid, e.id, t.id, p, t.admits, now())); }
    await env.DB.batch(stmts);
    return json(201, { order: oc, subtotal, fee, total: subtotal + fee });
  }

  // Door check-in: door key (for the bouncer) or the host key
  if (sub === "checkin" && m === "POST") {
    const dk = req.headers.get("X-Door-Key") || "", hk = req.headers.get("X-Host-Key") || "";
    const okDoor = (dk && e.door_hash && (await sha(dk)) === e.door_hash) || (hk && (await sha(hk)) === e.host_hash);
    if (!okDoor) fail(403, "This door link is no longer valid. Ask the organiser for a new one.");
    const tcode = clean(body.ticket, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const t = await D.first("SELECT t.*, o.name, o.status, y.name AS type FROM tickets t JOIN orders o ON o.id=t.order_id JOIN ticket_types y ON y.id=t.type_id WHERE t.code=?", tcode);
    if (!t) return json(404, { result: "invalid", error: "Not a valid ticket." });
    if (t.event_id !== e.id) return json(409, { result: "wrong", error: "This ticket is for a different event." });
    if (t.status !== "paid") return json(409, { result: "unpaid", error: "This ticket hasn't been paid for." });
    const u = await D.run("UPDATE tickets SET checked_in=? WHERE id=? AND checked_in IS NULL", now(), t.id);
    if (!u.meta.changes) return json(409, { result: "used", error: "Already used", name: t.name, type: t.type, at: t.checked_in });
    const inside = await D.first("SELECT COALESCE(SUM(admits),0) AS n FROM tickets WHERE event_id=? AND checked_in IS NOT NULL", e.id);
    return json(200, { result: "ok", name: t.name, type: t.type, admits: t.admits, inside: inside.n });
  }
  if (sub === "door" && m === "GET") {   // the door page checks its link is valid
    const dk = req.headers.get("X-Door-Key") || "", hk = req.headers.get("X-Host-Key") || "";
    const ok = (dk && e.door_hash && (await sha(dk)) === e.door_hash) || (hk && (await sha(hk)) === e.host_hash);
    if (!ok) fail(403, "This door link is no longer valid. Ask the organiser for a new one.");
    const s = await D.first("SELECT COALESCE(SUM(admits),0) AS expected, COALESCE(SUM(CASE WHEN checked_in IS NOT NULL THEN admits ELSE 0 END),0) AS inside FROM tickets WHERE event_id=?", e.id);
    return json(200, { event: eventDetails(e, { reveal: true }), ...s });
  }

  // Host only
  if (sub === "door-link" && m === "POST") {   // new door key; the old link stops working
    await hostOnly(env, req, e);
    const k = secret(); await D.run("UPDATE events SET door_hash=? WHERE id=?", await sha(k), e.id);
    return json(200, { doorKey: k });
  }
  if (sub === "attendees" && m === "GET") {
    await hostOnly(env, req, e);
    const rows = await D.all(`SELECT o.code AS order_code, o.name, o.phone, o.email, o.created, t.code, t.admits, t.price, t.checked_in, y.name AS type
      FROM tickets t JOIN orders o ON o.id=t.order_id JOIN ticket_types y ON y.id=t.type_id WHERE t.event_id=? AND o.status='paid' ORDER BY o.id DESC, t.id`, e.id);
    return json(200, { attendees: rows });
  }
  if (sub === "listed" && m === "POST") {
    await hostOnly(env, req, e);
    await D.run("UPDATE events SET listed=? WHERE id=?", body.listed ? 1 : 0, e.id);
    return json(200, { listed: Boolean(body.listed) });
  }
  return null;   // not an events route: let the spray API handle it
}
