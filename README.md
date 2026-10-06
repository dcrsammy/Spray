# Spray (working name)

Digital money spraying for parties and club nights. Guests scan a QR code, pick who they're spraying, buy a stack and flick their phone: notes rain on the big screen with their name, and the money goes to the person they sprayed. No app to download.

## Pages
| Link | Who it's for |
|---|---|
| `/` | Home: join a party by code, set one up, or get a spray code |
| `/host.html` | Set up a party or club night (name, who can be sprayed, DJ/MC partner) |
| `/e/CODE` | **Guests**: pick who to spray, buy a stack, flick |
| `/s/CODE` | **Big screen**: money rain, running total, top sprayers, ticker, QR code. Open on the laptop connected to the LED wall/projector |
| `/d/CODE` | **Host dashboard**: who sprayed what (downloadable), totals per person, partner earnings, *Wind down* and *End & finale* |
| `/p` | Personal spray code, so anyone in the room (dancers, hype men, birthday people) can be sprayed |

## How the money works
- A guest picks **who** they're spraying, then buys a stack for that person. Payment goes to them; nobody holds a balance.
- Flicks only reveal on screen money that's already theirs.
- **Wind down** reminds guests with money left to throw it. **End & finale** rains whatever is left on the people it was meant for.
- Fee 3% on top, paid by the guest; DJ/MC/planner partner gets 25% of the fee. Change in `worker/index.js` (top of file).

## Payments
`PAYMENTS_MODE` in `wrangler.jsonc`:
- `demo` (now): stacks are marked paid instantly, no real money.
- `paystack` (later): each recipient gets a Paystack subaccount; a stack is a transaction split to that subaccount, confirmed by the `charge.success` webhook. Plug-in point: `takePayment()` in `worker/index.js`. Needs a registered business.

## Deploy on Cloudflare
1. Cloudflare → **Storage & Databases → D1 → Create database** named `spray`. Copy its ID into `wrangler.jsonc` (`database_id`).
2. **Workers & Pages → Create → Import a repository** → this repo. No build command; Cloudflare reads `wrangler.jsonc`.
3. Tables are created automatically on first use.

Run locally: `npm install`, then `npx wrangler dev` (uses a local database).

## Rename
Change `BRAND` in `public/common.js` and the page titles.

## Planned next (saved for later)
**Live connections instead of check-ins** (decided to do before scaling up):
- One live "room" per party (Cloudflare Durable Object with WebSocket hibernation). Guest phones and big screens connect to it.
- Sprays go to the room, which pushes them to every screen instantly; running totals and the leaderboard live in the room (no recalculating).
- Wind-down and finale reach every phone instantly.
- D1 keeps the permanent record (stacks, sprays, who-sprayed-what).
- Auto-reconnect, with a fallback to check-ins only while a phone can't connect (unreliable venue networks).
- Test: full party plus a network cut mid-party.

Why: the current version has every guest phone check in every 5 seconds and the screen re-total every second. Fine for testing, but a 500-guest party would exhaust Cloudflare's free daily allowance. Also needed before the first real event: **Workers Paid ($5/month)**.
