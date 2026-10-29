# MowBrokers

Lawn-care sister company of Bug Brokers (pest control), with the same business model, operator and tech. Homeowners in North Alabama describe their yard (lot size, terrain, what to mow), compare posted prices from vetted lawn care pros, choose one, and save a card. They're charged after each visit. Pros apply, post their own prices by lot size, get vetted, connect Stripe, and receive booked customers. One operator runs everything from a console.

**This is a plain HTML site.** No framework and no build step: upload the `public/` folder to any static host (Netlify, Cloudflare Pages, GitHub Pages, Vercel, S3). Everything that needs secrets runs on **Supabase**: Postgres with Row Level Security, Auth, Storage, and Edge Functions for Stripe Connect, email (Resend) and text messages (Twilio).

To take it live, follow **[docs/LAUNCH.md](docs/LAUNCH.md)**.

## Before launch: open items

- **Domain:** `mowbrokers.com` is used throughout (canonical URLs, sitemap, `help@mowbrokers.com`) but **has not been registered yet**. Register it, or search-and-replace the domain before deploying.
- **Separate backend:** MowBrokers needs its **own Supabase project** (its own database, auth users and Edge Functions). `public/assets/config.js` and the cron URLs in the migrations hold `YOUR-…` placeholders until it exists.
- **Stripe:** the default is a separate Stripe platform account for MowBrokers. You can share Bug Brokers' Stripe account instead (see LAUNCH.md step 2), but providers onboard per platform either way.
- **Legal:** `terms.html` and `privacy.html` are drafts for attorney review; fill in `[SUPPORT EMAIL]`, `[MAILING ADDRESS]` and the `[24]`-month non-circumvention term. `join.html` has a `[TYPICAL VETTING TIME]` placeholder.
- GitHub: `MakoLeaks/MowBrokers` (no remote is configured in this checkout).

## Layout

```
public/                     ← deploy this folder
  index.html                  home: describe your yard
  results.html                matched providers with prices
  pro.html?slug=…             provider profile
  book.html?slug=…            contact details → booking
  booking.html?ref=…&t=…      customer's private booking page, card on file, re-service
  reservice.html              re-service by reference code (MB-…) + phone
  join.html, signup.html, login.html, reset.html
  portal.html, profile.html   provider portal and application / prices
  admin.html#overview         operator console (bookings, providers, payments, re-service, settings)
  terms.html, privacy.html    drafts for attorney review
  lawn-care/<town>/…          local search pages (generated; see below)
  assets/config.js            ← your public Supabase and Stripe keys (window.MB_CONFIG)
  assets/core.mjs             shared browser code
  assets/pricing.mjs          pricing engine (copy of supabase/functions/_shared/pricing.mjs)
  assets/pages/*.mjs          one script per page
  _headers                    security headers (Netlify / Cloudflare Pages)
supabase/
  migrations/0001_init.sql    tables, Row Level Security, public views and lookups
  migrations/0002_daily_job.sql  schedules the daily reminder job
  migrations/0003_enhancements.sql  visit reports, reviews, referrals, prepay, scorecards, hourly job
  functions/public            booking, card setup, re-service (no login)
  functions/portal            provider actions (provider login)
  functions/admin             operator actions (admin login)
  functions/stripe-webhook    Stripe events
  functions/daily             reminders, insurance warnings, seasonal offers, operator digest
  functions/_shared           pricing engine, Stripe, email/SMS, database helpers
  dashboard/<fn>/index.ts     single-file builds for pasting into the Supabase dashboard
scripts/
  sync-pricing.sh             copies the pricing engine to the browser (npm run sync)
  bundle-functions.mjs        rebuilds supabase/dashboard/* (needs esbuild)
  build-local-pages.mjs       regenerates public/lawn-care/ and sitemap.xml
tests/pricing.test.mjs        pricing tests (node --test)
```

## Pricing model: lot size × frequency

Pros post a **price per weekly cut** (mow, edge, trim, blow) for each lot tier (under ¼ acre, ¼–½, ½–1, 1–2, over 2 acres), plus an every-two-weeks premium, a one-time-cut multiplier, an optional **fertilizer and weed control** price per application by lot tier (only pros with ADAI OTPS), a bundle discount on fertilizer when combined with recurring mowing, and add-on prices (core aeration and fall leaf cleanup scale by lot; shrub trimming is per visit).

The platform applies the same **terrain** (flat 1.00, some slopes 1.15, steep 1.30) and **coverage** (front and back 1.00, front only 0.60, back only 0.55) factors to every pro. Season = 30 weeks (April–October): weekly is 30 cuts, every two weeks is 15. All defaults are editable in **Console → Settings**. Lots over two acres show a guide price, confirmed on site. Formulas are in `supabase/functions/_shared/pricing.mjs` and pinned by the tests.

## Licensing (Alabama)

Mowing and yard maintenance need a city business license and general liability insurance. Fertilizer, weed control or any pesticide or herbicide for hire needs the ADAI **Horticulture Professional Services** license in category **Ornamental & Turf Pest Control (OTPS)** with a certified operator. Provider categories: `MOW`, `OTPS`, `SLP` (Setting of Landscape Plants; needed for landscape bed installs), `TS` (Tree Surgery; needed for tree and stump removal).

## How it fits together

- **Reads** come straight from the browser through Supabase with the public anon key. Row Level Security limits what each person sees: anyone can read the public provider directory and settings; providers see only their own records; the operator sees everything. Customers have no accounts and see their booking through a lookup that needs its reference and secret token.
- **Writes** never go directly from the browser to the database. Every write goes through an Edge Function that checks who is calling, validates the input, and recalculates prices on the server.
- **Money:** at booking the customer saves a card (Stripe SetupIntent). After each visit the provider presses **Visit done**, and an Edge Function charges the saved card with `transfer_data.destination` = the provider's Stripe account and `application_fee_amount` = your take (default 12%). Stripe pays providers every Friday.
- **Guarantee:** if a scheduled cut is missed or done poorly, or weeds come back between treatment visits, the pro comes back within two business days at no charge (re-service).
- **Pricing:** one engine in `supabase/functions/_shared/pricing.mjs`, used by both the Edge Functions and the browser. After editing it, run `npm run sync` to copy it to `public/assets/`, and `node scripts/bundle-functions.mjs` to refresh the dashboard builds. `npm test` fails if the two engine copies differ.

## Local preview

```bash
npm run serve          # http://localhost:8080 (python3)
npm test               # pricing tests
node scripts/build-local-pages.mjs   # after editing towns or local-page copy
```

Without real keys in `public/assets/config.js`, pages render with a "Setup needed" banner.
