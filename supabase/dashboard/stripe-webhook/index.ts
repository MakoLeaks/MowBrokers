// @ts-nocheck
// MowBrokers Edge Function "stripe-webhook" — single-file build of supabase/functions/stripe-webhook + _shared for the Supabase dashboard editor.
// Source of truth is supabase/functions; regenerate with scripts/bundle-functions.mjs.

// _shared/env.ts
function need(name) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}. Run: supabase secrets set ${name}=...`);
  return v;
}
var opt = (name, d = "") => Deno.env.get(name) || d;
var env = {
  supabaseUrl: () => need("SUPABASE_URL"),
  serviceKey: () => need("SUPABASE_SERVICE_ROLE_KEY"),
  siteUrl: () => opt("SITE_URL", "http://localhost:8080").replace(/\/$/, ""),
  stripeSecret: () => need("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: () => opt("STRIPE_WEBHOOK_SECRET"),
  stripeConnectWebhookSecret: () => opt("STRIPE_CONNECT_WEBHOOK_SECRET"),
  resendKey: () => opt("RESEND_API_KEY"),
  emailFrom: () => opt("EMAIL_FROM", "MowBrokers <onboarding@resend.dev>"),
  twilioSid: () => opt("TWILIO_ACCOUNT_SID"),
  twilioToken: () => opt("TWILIO_AUTH_TOKEN"),
  twilioService: () => opt("TWILIO_MESSAGING_SERVICE_SID"),
  adminEmail: () => opt("ADMIN_NOTIFY_EMAIL"),
  adminPhone: () => opt("ADMIN_NOTIFY_PHONE"),
  cronSecret: () => opt("CRON_SECRET"),
  allowedOrigins: () => opt("ALLOWED_ORIGINS", "*")
};

// _shared/db.ts
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

// _shared/pricing.mjs
var DEFAULT_SETTINGS = {
  takeRate: 0.12,
  roundTo: 5,
  goalPairs: 500,
  season: { weeks: 30, label: "April–October" },
  fertApps: 6,
  lots: [
    { label: "Under ¼ acre", min: 0, scale: 1 },
    { label: "¼–½ acre", min: 0.25, scale: 1.6 },
    { label: "½–1 acre", min: 0.5, scale: 2.6 },
    { label: "1–2 acres", min: 1, scale: 4 },
    { label: "Over 2 acres", min: 2, scale: 6 }
  ],
  terrains: [{ label: "Flat and open", mult: 1 }, { label: "Some slopes or obstacles", mult: 1.15 }, { label: "Steep or heavily landscaped", mult: 1.3 }],
  coverages: [{ label: "Front and back", mult: 1 }, { label: "Front yard only", mult: 0.6 }, { label: "Back yard only", mult: 0.55 }],
  suggested: { mowTiers: [45, 55, 70, 95, 130], biweeklyPremium: 0.15, oneTimeMult: 1.5, fertTiers: [55, 70, 95, 135, 190], bundleDiscount: 0.1, addons: { aeration: 95, leafCleanup: 175, shrubTrim: 85 } },
  extras: { referralCreditCents: 2500, prepayDiscount: 0.05, respondHours: 24, reviewAfterVisits: 2 }
};
var DEFAULT_EXTRAS = DEFAULT_SETTINGS.extras;
var extrasOf = (s2) => ({ ...DEFAULT_EXTRAS, ...s2?.extras || {} });
function addBusinessHours(from, hours = 24) {
  const d = new Date(from instanceof Date ? from.getTime() : from);
  d.setTime(d.getTime() + hours * 36e5);
  const dow = () => new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" })).getDay();
  while (dow() === 0 || dow() === 6) d.setTime(d.getTime() + 864e5);
  return d;
}

// _shared/db.ts
var client = null;
function db() {
  if (!client) client = createClient(env.supabaseUrl(), env.serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
async function getSettings() {
  const { data } = await db().from("settings").select("*").eq("id", 1).maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  return { takeRate: Number(data.take_rate), roundTo: data.round_to, goalPairs: data.goal_pairs, season: data.season ?? DEFAULT_SETTINGS.season, fertApps: data.fert_apps ?? DEFAULT_SETTINGS.fertApps, lots: data.lots, terrains: data.terrains, coverages: data.coverages, suggested: data.suggested, extras: extrasOf({ extras: data.extras }) };
}
async function logEvent(bookingId, vendorId, type, detail = "") {
  try {
    await db().from("booking_events").insert({ booking_id: bookingId, vendor_id: vendorId, type, detail: detail.slice(0, 500) });
  } catch {
  }
}

// _shared/payments.ts
import Stripe from "npm:stripe@16.12.0";

// _shared/util.ts
function toE164(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
var usd = (n, d = 0) => "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso.length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}

// _shared/notify.ts
async function log(event, channel, recipient, ok, error) {
  try {
    await db().from("notifications").insert({ event, channel, recipient, ok, error: error?.slice(0, 500) ?? null });
  } catch {
  }
}
async function sendEmail(event, to, subject, text) {
  if (!to) return;
  const key = env.resendKey();
  if (!key) return log(event, "email", to, false, "RESEND_API_KEY not set");
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.emailFrom(), to: [to], subject, text: text + "\n\n— MowBrokers\nThe right lawn pro, matched." })
    });
    await log(event, "email", to, r.ok, r.ok ? void 0 : await r.text());
  } catch (e) {
    await log(event, "email", to, false, String(e));
  }
}
async function sendSms(event, to, body) {
  const num = to ? toE164(to) : null;
  if (!num) return;
  const sid = env.twilioSid(), tok = env.twilioToken(), svc = env.twilioService();
  if (!sid || !tok || !svc) return log(event, "sms", num, false, "Twilio not configured");
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: num, MessagingServiceSid: svc, Body: `MowBrokers: ${body} Reply STOP to opt out.` })
    });
    await log(event, "sms", num, r.ok, r.ok ? void 0 : await r.text());
  } catch (e) {
    await log(event, "sms", num, false, String(e));
  }
}
async function notifyAdmin(event, subject, text, sms) {
  await Promise.all([sendEmail(event, env.adminEmail(), `[Ops] ${subject}`, text), sms ? sendSms(event, env.adminPhone(), sms) : Promise.resolve()]);
}
var bookingLink = (ref, tok) => `${env.siteUrl()}/booking.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(tok)}`;

// _shared/payments.ts
var s = null;
function stripe() {
  if (!s) s = new Stripe(env.stripeSecret(), { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient(), appInfo: { name: "MowBrokers" } });
  return s;
}
var cryptoProvider = Stripe.createSubtleCryptoProvider();
var V2_VERSION = "2026-09-30.preview";
async function stripeV2(method, path, body) {
  const r = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.stripeSecret()}`, "Stripe-Version": V2_VERSION, ...body ? { "Content-Type": "application/json" } : {} },
    body: body ? JSON.stringify(body) : void 0
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${method} ${path}: ${j?.error?.message ?? r.status}`);
  return j;
}
async function providerReady(account) {
  const a = await stripeV2(
    "GET",
    `/v2/core/accounts/${encodeURIComponent(account)}?include=configuration.recipient`
  );
  return a.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === "active";
}
async function syncProviderStatus(account) {
  const ready = await providerReady(account);
  await db().from("vendors").update({ stripe_charges_enabled: ready, stripe_payouts_enabled: ready }).eq("stripe_account_id", account);
  return ready;
}
async function sendReceipt(b, label, amount) {
  await sendEmail("payment.receipt", b.customer_email, `Receipt: ${label} ${usd(amount, 2)} — ${b.ref}`, `Hi ${b.customer_name},

We charged ${usd(amount, 2)} for your ${label.toLowerCase()}.
Missed spot, or weeds back between treatments? Request a free re-service: ${bookingLink(b.ref, b.access_token)}`);
}
async function notifyCardProblem(b, label, amount, why) {
  const link = bookingLink(b.ref, b.access_token) + "&card=1";
  await sendEmail("payment.failed", b.customer_email, `Action needed: update your card — ${b.ref}`, `Hi ${b.customer_name},

We couldn't charge ${usd(amount, 2)} for your ${label.toLowerCase()}${why ? ` (${why})` : ""}. Please update your card: ${link}`);
  if (b.sms_consent) await sendSms("payment.failed", b.customer_phone, `We couldn't charge your card for ${label.toLowerCase()}. Update it here: ${link}`);
  await notifyAdmin("payment.failed", `Card failed on ${b.ref}`, `${label} ${usd(amount, 2)} failed: ${why ?? "unknown"}`);
}

// _shared/services.ts
var firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";
async function loadVendor(id) {
  if (!id) return null;
  const { data } = await db().from("vendors").select("*").eq("id", id).maybeSingle();
  return data ?? null;
}
async function startResponseClock(b, vendorId) {
  const s2 = await getSettings();
  const by = addBusinessHours(/* @__PURE__ */ new Date(), extrasOf(s2).respondHours).toISOString();
  await db().from("bookings").update({ respond_by: by, contacted_at: null }).eq("id", b.id);
  await logEvent(b.id, vendorId, "matched", `respond by ${by}`);
  return by;
}
async function notifyNewJob(b, v, reassigned = false) {
  const price = b.quote ? `Season price: ${usd(b.quote.annual)} (${b.plan}${b.quote.perVisit ? `, ${usd(b.quote.perVisit)} per cut` : ""}).` : "";
  const when = [b.preferred_start ? `Preferred first visit: ${fmtDate(b.preferred_start)}` : "", b.preferred_alt ? `Backup date: ${fmtDate(b.preferred_alt)}` : "", b.visit_window !== "any" ? `Time of day: ${b.visit_window}` : ""].filter(Boolean).join("\n");
  await sendEmail(
    "booking.new_job",
    v.email,
    `New MowBrokers customer: ${b.customer_name} (${b.ref})`,
    `${b.customer_name} ${reassigned ? "was matched to you" : "chose you"} on MowBrokers.

Phone: ${b.customer_phone}
Address: ${b.street}, ${b.zip}
Yard: ${b.yard.acres} acres, ${b.yard.terrain}, ${b.yard.coverage}
Plan: ${b.plan}${b.prepay ? " (season prepay)" : ""}
${price}
${when ? when + "\n" : ""}${b.custom.length ? "Inspect and quote: " + b.custom.join(", ") + "\n" : ""}${b.notes ? "Customer says: " + b.notes + "\n" : ""}
Call within one business day and tap “I called them” (or mark the visit scheduled) in your portal, or the booking moves to another pro: ${env.siteUrl()}/portal.html`
  );
  await sendSms("booking.new_job", v.phone, `New customer ${b.customer_name} (${b.ref}), ${b.zip}. Call within 1 business day and log it in your portal, or it moves to another pro.`);
}
async function attachCardFromSetupIntent(si) {
  const bookingId = si.metadata?.booking_id;
  if (!bookingId || si.status !== "succeeded" || !si.payment_method) return null;
  const pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method.id;
  const { data } = await db().from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!data) return null;
  const b = data;
  if (b.stripe_payment_method_id === pm) return b;
  const custId = typeof si.customer === "string" ? si.customer : si.customer?.id;
  if (custId) await stripe().customers.update(custId, { invoice_settings: { default_payment_method: pm } });
  const wasPending = b.status === "pending_card";
  const nextStatus = wasPending ? b.vendor_id ? "matched" : "new" : b.status;
  const { data: up } = await db().from("bookings").update({ stripe_payment_method_id: pm, status: nextStatus, matched_at: b.vendor_id && !b.matched_at ? (/* @__PURE__ */ new Date()).toISOString() : b.matched_at }).eq("id", b.id).select("*").single();
  if (wasPending) {
    if (b.vendor_id) await startResponseClock(up, b.vendor_id);
    await announceBooking(up);
  } else await logEvent(b.id, b.vendor_id, "card_updated");
  return up;
}
async function announceBooking(b) {
  const link = bookingLink(b.ref, b.access_token);
  const v = await loadVendor(b.vendor_id);
  const price = b.quote ? `Season price: ${usd(b.quote.annual)} (${b.plan}${b.prepay ? ", season prepay" : ""}).` : "";
  if (v) {
    await sendEmail(
      "booking.confirmed",
      b.customer_email,
      `Booked with ${v.business} — ${b.ref}`,
      `Hi ${firstName(b.customer_name)},

You're booked with ${v.business}. They'll call ${b.customer_phone} within one business day to set your first visit.
${price}
Your card is saved and is charged only after each visit${b.prepay ? " (your season prepay is charged at the first visit)" : ""}.

Your account (visit reports, receipts, free re-service, pause or cancel): ${link}
Reference code: ${b.ref}`
    );
    if (b.sms_consent) await sendSms("booking.confirmed", b.customer_phone, `You're booked with ${v.business} (${b.ref}). They'll call within 1 business day. Details: ${link}`);
    await notifyNewJob(b, v);
  } else {
    await sendEmail("booking.request", b.customer_email, `We're finding your pro — ${b.ref}`, `Hi ${firstName(b.customer_name)},

We got your request. We'll find a vetted lawn pro for your yard and send you their price before anything is booked.

Track it here: ${link}`);
  }
  await notifyAdmin("booking.created", `${v ? "New booking" : "Needs manual match"}: ${b.ref}`, `${b.customer_name}, ${b.zip}, ${b.plan}${v ? " → " + v.business : " — no automatic match"}.`, v ? void 0 : `Needs manual match: ${b.ref} in ${b.zip}.`);
}

// stripe-webhook/index.ts
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Use POST", { status: 405 });
  const sig = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();
  let event = null;
  for (const secret of [env.stripeWebhookSecret(), env.stripeConnectWebhookSecret()].filter(Boolean)) {
    try {
      event = await stripe().webhooks.constructEventAsync(body, sig, secret, void 0, cryptoProvider);
      break;
    } catch {
    }
  }
  if (!event) {
    try {
      const claimed = JSON.parse(body);
      const id = typeof claimed.id === "string" && /^evt_[A-Za-z0-9]+$/.test(claimed.id) ? claimed.id : null;
      const acct = typeof claimed.account === "string" && /^acct_[A-Za-z0-9]+$/.test(claimed.account) ? claimed.account : null;
      if (id) event = await stripe().events.retrieve(id, void 0, acct ? { stripeAccount: acct } : void 0);
    } catch {
    }
  }
  if (!event) return new Response(JSON.stringify({ error: "bad signature" }), { status: 400 });
  try {
    switch (event.type) {
      case "setup_intent.succeeded":
        await attachCardFromSetupIntent(event.data.object);
        break;
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const { data: pay } = await db().from("payments").select("*").eq("stripe_payment_intent_id", pi.id).maybeSingle();
        if (!pay) break;
        const ok = event.type === "payment_intent.succeeded";
        if (pay.status === (ok ? "succeeded" : "failed")) break;
        const msg = ok ? null : pi.last_payment_error?.message ?? "Card was declined.";
        await db().from("payments").update({ status: ok ? "succeeded" : "failed", failure_message: msg }).eq("id", pay.id);
        const { data: b } = await db().from("bookings").select("*").eq("id", pay.booking_id).single();
        if (ok && pay.status === "processing") await sendReceipt(b, pay.label, pay.amount_cents / 100);
        if (!ok) await notifyCardProblem(b, pay.label, pay.amount_cents / 100, msg);
        break;
      }
      case "account.updated": {
        const a = event.data.object;
        await syncProviderStatus(a.id);
        break;
      }
      case "charge.dispute.created": {
        const d = event.data.object;
        await notifyAdmin("dispute", `Chargeback opened: $${(d.amount / 100).toFixed(2)}`, `Reason: ${d.reason}. Respond in the Stripe dashboard before the deadline.`, "A customer opened a chargeback. Check Stripe.");
        break;
      }
    }
  } catch (e) {
    console.error("webhook", event.type, e);
    return new Response(JSON.stringify({ error: "handler failed" }), { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
