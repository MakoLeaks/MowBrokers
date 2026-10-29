# MowBrokers launch guide

MowBrokers runs on its **own** Supabase project, separate from Bug Brokers. Register `mowbrokers.com` first (it is not registered yet); every URL below assumes it.

Budget an afternoon for steps 1–7. Twilio's text-message registration takes 1–3 weeks, so start it on day one; you can launch with email only. Do everything in **Stripe test mode** first, run the test script in step 8, then switch to live keys in step 9.

You'll need the [Supabase CLI](https://supabase.com/docs/guides/cli) to deploy the Edge Functions (`brew install supabase/tap/supabase`, or `npx supabase` with Node installed).

---

## 1. Supabase project

1. Create a project at supabase.com (region **East US**). Save the database password.
2. **SQL Editor → New query**: paste all of `supabase/migrations/0001_init.sql` and run it. (`0003_enhancements.sql` comes later, in step 5, because it needs `0002` first.)
3. **Project Settings → API Keys**: note the Project URL, the publishable key (`sb_publishable_…`, or the legacy `anon` key) and the project ref (the `xxxx` in `https://xxxx.supabase.co`).
4. **Authentication → URL Configuration**: Site URL = your site (for example `https://mowbrokers.com`). Add redirect URLs `https://mowbrokers.com/profile.html` and `https://mowbrokers.com/reset.html`.
5. **Authentication → Emails → SMTP Settings**: enter Resend's SMTP details (step 3) so sign-up and password emails come from your domain.

## 2. Stripe

1. Create the MowBrokers Stripe account (LLC, EIN, business bank account). **Option:** reuse the Bug Brokers Stripe account as the platform instead. That saves a second business verification, but both brands then share one balance, one Connect branding and one statement descriptor setting (the code sets the suffix `MOWBROKERS` per charge), and a webhook endpoint per Supabase project. Providers onboard to whichever platform you choose.
2. **Connect → Get started**: Platform or marketplace, **Express** accounts. Fill in the platform profile; under **Settings → Connect → Branding** upload `public/assets/icon.svg` (as PNG) and set color `#13283D`.
3. **Developers → API keys** (test mode): note the publishable key (`pk_test_…`) and secret key (`sk_test_…`).
4. **Developers → Webhooks → Add endpoint**: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/stripe-webhook` with events `setup_intent.succeeded`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.dispute.created`. Note its signing secret.
5. Add a second endpoint, same URL, with **Listen to events on Connected accounts** and event `account.updated`. Note its signing secret.

## 3. Resend (email)

Create an account at resend.com, **add your domain**, add its DNS records at your registrar, and wait for "Verified." Create an API key.

## 4. Twilio (texts; optional at launch)

Buy a local 256 number (a separate number from Bug Brokers, so replies go to the right brand), register **A2P 10DLC** (brand + "Customer Care" campaign, needs your EIN), create a **Messaging Service** containing the number, and note the Account SID, Auth Token and Messaging Service SID. Texts start working when you add these secrets, even after launch.

## 5. Deploy the Edge Functions

From this folder:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set \
  SITE_URL=https://mowbrokers.com \
  ALLOWED_ORIGINS=https://mowbrokers.com \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_...platform... \
  STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...connect... \
  RESEND_API_KEY=re_... \
  EMAIL_FROM="MowBrokers <bookings@mowbrokers.com>" \
  ADMIN_NOTIFY_EMAIL=you@example.com \
  ADMIN_NOTIFY_PHONE=+12565550100 \
  CRON_SECRET=$(openssl rand -hex 24)
# The two whsec_ secrets are optional: if neither matches, the webhook re-fetches each event from Stripe by id
# with STRIPE_SECRET_KEY, so only genuine events are processed. Setting them just skips that extra API call.
# optional, for texts:
supabase secrets set TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_MESSAGING_SERVICE_SID=MG...
supabase functions deploy public portal admin stripe-webhook daily
```

`supabase/config.toml` already marks `public`, `stripe-webhook` and `daily` as not needing a login token (they check their own secrets).

Then schedule the daily job: open `supabase/migrations/0002_daily_job.sql`, replace `YOUR-PROJECT-REF` and `YOUR-CRON-SECRET` (the value you set above; see it with `supabase secrets list` or set it again), and run it in the SQL Editor. Then do the same with `supabase/migrations/0003_enhancements.sql` (replace `YOUR-PROJECT-REF` in its hourly job too). The cron job names are `mowbrokers-daily` and `mowbrokers-hourly`, so they won't collide with Bug Brokers if you ever share a database.

## 6. Publish the website

1. Edit `public/assets/config.js`: set `supabaseUrl`, `supabaseAnonKey`, `stripePublishableKey` and `supportEmail`.
2. Host the `public/` folder. Easiest options:
   - **Netlify:** connect the GitHub repo; `netlify.toml` already says "publish `public`, no build." `_headers` adds security headers.
   - **Cloudflare Pages:** connect the repo, build command empty, output directory `public`.
   - **GitHub Pages:** Settings → Pages → deploy from a branch, folder `/public` (use a workflow, since Pages only offers `/` or `/docs`), or move `public/` contents to `/docs`.
3. Point `mowbrokers.com` at the host and turn on HTTPS.

## 7. Make yourself the operator

1. Sign up at `https://mowbrokers.com/signup.html`.
2. In Supabase **SQL Editor**:
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'YOU@EXAMPLE.COM');
   ```
3. Open `https://mowbrokers.com/admin.html`.

## 8. Test script (Stripe test mode)

| # | Do this | You should see |
|---|---|---|
| 1 | Sign up a test provider with a second email; tick **Mowing** and **OTPS**, keep the suggested prices, ZIP `35758` | Application email to you; provider in **Console → Providers** |
| 2 | In the portal, **Set up payouts with Stripe** with Stripe's test data (SSN `000-00-0000`, routing `110000000`, account `000123456789`) | Back in the portal, the payouts banner is gone |
| 3 | In the console, tick all seven vetting checks and **Approve** | "You're live" email to the provider |
| 4 | Signed out, search `0.3` acres, ZIP `35758`, flat and open, front and back, every two weeks, fertilizer and aeration on, shrub trimming 2 | The provider appears at $65 per cut, $1,673 for the season (suggested prices) |
| 5 | **Choose** → contact details → card `4242 4242 4242 4242` | Booking page says you're booked; customer, provider and operator emails |
| 6 | Provider portal: **Mark scheduled**, then **Visit done** and log a cut | Payment shows "Paid" ($65); Stripe shows a 12% application fee and a transfer to the provider |
| 7 | Book again with card `4000 0000 0000 0341` and charge it | Charge fails; customer gets an "update your card" email; the console queue shows it |
| 8 | Request a free re-service from the booking page | Provider email; it appears in the portal and **Console → Re-service** |
| 9 | `curl -X POST -H "x-cron-secret: YOUR-CRON-SECRET" https://YOUR-PROJECT-REF.supabase.co/functions/v1/daily` | JSON listing actions; morning digest email |

## 9. Go live

1. Activate Stripe, then set the live secret key and live webhook secrets with `supabase secrets set`, and the live publishable key in `config.js`. Providers onboard again in live mode.
2. Have an Alabama attorney finish `terms.html` and `privacy.html` (marked as drafts) and a provider agreement; fill in `[SUPPORT EMAIL]` and `[MAILING ADDRESS]`.
3. Get the platform's general liability and E&O policies.
5. Confirm with an Alabama attorney and ADAI that the OTPS rules described on `join.html` and in the terms match current regulations.
4. Delete test providers and bookings in Supabase **Table editor**.

## Running costs at launch

Static hosting $0 (Netlify or Cloudflare Pages free tiers), Supabase Free to start (Pro $25/mo recommended at launch for daily backups), Resend free to 3,000 emails/mo, Twilio about $1.15/mo per number plus ~$0.008 per text plus one-time 10DLC fees, Stripe 2.9% + 30¢ per charge plus 0.25% + 25¢ per payout and $2 per active connected account per month (paid from the platform's share).
