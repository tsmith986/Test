# Pindrop (personal edition)

A self-hosted, single-user version of the tools [pindrop.host](https://pindrop.host) offers: find local businesses that have no website, build each one a site in minutes, host it, and bill the owner a setup fee plus a monthly plan. Payments go straight to **your own** Stripe account, with no platform cut and no credits.

## What's included

| Tool | What it does |
| --- | --- |
| **🗺️ Lead finder** | A map of businesses near you (OpenStreetMap data). Each one is flagged 🔴 no website, 🟣 social media only, or ⚪ has a website. Filter by category, hide chains, and save leads or build a site with one click. |
| **📋 Pipeline** | A kanban board (new → contacted → building → pitched → won/lost) with notes, follow-up dates and click-to-call. |
| **🌐 Site builder** | A one-page site per business: hero photo, about, services and prices, gallery, reviews, hours, map, contact form and booking requests. Comes with 3 templates, an accent color and a live desktop/mobile preview. |
| **✨ AI copy** *(optional)* | Writes the tagline, about text, services and plain-English hours from the facts you've gathered. Needs an Anthropic API key. |
| **Hosting** | Sites are served at `/s/<slug>` or on the client's own custom domain. |
| **💳 Billing** | One click creates a Stripe Checkout link for the build fee plus the monthly subscription. Renewals and cancellations are tracked by webhook. You can also log cash or other payments by hand. The dashboard shows MRR and money collected. |
| **🔑 Owner portal** | A private link per client. Owners can pay, update their card, see their site's messages and bookings, and request changes. |
| **📥 Inbox** | Every form message, booking request and change request, in one place. |

## Run it

Requires Node.js 20+.

```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start
# open http://localhost:3000
```

If you don't set `ADMIN_PASSWORD`, a password is generated and printed on first start. It's also saved in `data/.admin-password`.

Everything is stored in `data/` (`db.json` plus uploaded photos). Back up that folder, or use **Settings → Download backup**.

### Configuration

Most settings can be entered in the **Settings** page. Environment variables, if set, take priority:

| Variable | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Login password |
| `PORT` | Port to listen on (default `3000`) |
| `BASE_URL` | Public URL, e.g. `https://sites.example.com`; used for site links, portals and Stripe redirects |
| `DATA_DIR` | Where data is stored (default `./data`) |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…` / `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_…`) |
| `ANTHROPIC_API_KEY` | Enables ✨ AI copy |

## Putting it online

Business owners need to be able to open their site, so run this on a small VPS (a $5/month one is enough). Put [Caddy](https://caddyserver.com) in front for automatic HTTPS:

```
sites.example.com {
    reverse_proxy localhost:3000
}

# One block per client domain (or use Caddy's on-demand TLS)
rosastacos.com, www.rosastacos.com {
    reverse_proxy localhost:3000
}
```

**Custom domains:** set the domain in the site's *Publish* section. Then point the domain's DNS at your server: an `A` record for `@` and a `CNAME` for `www`. The app works out which site to serve from the requested hostname.

### Stripe setup

1. Paste your secret key in **Settings** (start with a test key).
2. In the Stripe dashboard, add a webhook to `https://<your BASE_URL>/stripe/webhook` with these events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`. Paste the signing secret in Settings.
3. Turn on the **Customer Portal** in Stripe, so owners can update their card or cancel from their portal.

Without the webhook, the first payment is still recorded when the owner returns from checkout. Use **Sync from Stripe** on a site to refresh its subscription status.

## Typical workflow

1. **Find leads**: zoom into a neighborhood, then press *Scan this area*.
2. Click a 🔴 business, then **Build site**. Its name, phone, address and hours are pre-filled.
3. Add photos (take them on-site, or ask the owner), press ✨ *AI copy*, check the result, and tick **Site is live**.
4. Press **Copy pitch message** and send it, or walk in and show the owner their site on your phone.
5. Send the **owner portal link**. They pay the setup fee and monthly plan by card.

## Notes & limits

- Lead data comes from OpenStreetMap. It's free and needs no API key, but coverage varies by area, and some businesses with websites aren't tagged as having one. Check with a quick search before you pitch.
- Only use photos and reviews the owner is happy for you to use.
- The map search uses the free public Nominatim and Overpass services. Please don't run scans in a loop.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # API + rendering tests
```
