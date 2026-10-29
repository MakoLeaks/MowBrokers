// @ts-nocheck
// MowBrokers Edge Function "portal" — single-file build of supabase/functions/portal + _shared for the Supabase dashboard editor.
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

// _shared/http.ts
function cors(req) {
  const allowed = env.allowedOrigins().split(",").map((s2) => s2.trim()).filter(Boolean);
  const origin = req.headers.get("origin") ?? "";
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}
var UserError = class extends Error {
};
function serveActions(actions) {
  Deno.serve(async (req) => {
    const h = cors(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: h });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, "Content-Type": "application/json" } });
    if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "Invalid request." }, 400);
    }
    const fn = actions[String(body.action ?? "")];
    if (!fn) return json({ ok: false, error: "Unknown action." }, 400);
    try {
      return json({ ok: true, data: await fn(body, req) ?? null });
    } catch (e) {
      if (e instanceof UserError) return json({ ok: false, error: e.message });
      console.error(body.action, e);
      return json({ ok: false, error: "Something went wrong on our side. Try again in a moment." });
    }
  });
}

// _shared/db.ts
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

// _shared/pricing.mjs
var ADDONS = [
  { key: "aeration", label: "Core aeration", unit: "once a year", scaled: true },
  { key: "leafCleanup", label: "Fall leaf cleanup", unit: "once", scaled: true },
  { key: "shrubTrim", label: "Shrub trimming", unit: "per visit", scaled: false }
];
var CUSTOM_JOBS = ["Sod installation", "Irrigation repair", "Tree and stump removal", "Drainage and grading", "Landscape bed install", "Overgrown yard cleanup"];
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
var ITEMS = [
  { key: "visit", label: "Mowing visit" },
  { key: "fert", label: "Fertilizer and weed control application" },
  { key: "aeration", label: "Core aeration" },
  { key: "leaves", label: "Fall leaf cleanup" },
  { key: "shrubs", label: "Shrub trimming" }
];
var itemLabel = (k, plan) => k === "visit" ? plan === "Weekly" ? "Weekly cut" : plan === "Every two weeks" ? "Every-two-weeks cut" : plan === "One-time cut" ? "One-time cut" : "Mowing visit" : ITEMS.find((i) => i.key === k)?.label ?? k;
function itemAmount(x, kind) {
  if (kind === "visit") return x.perVisit;
  if (kind === "fert") return x.fertVisit ?? x.fertPerApp;
  if (kind === "aeration") return x.aeration;
  if (kind === "leaves") return x.leaves;
  if (kind === "shrubs") return x.shrubVisit;
  return 0;
}
function itemLimits(plan, x, addons = {}) {
  return { visit: x.visits || 0, fert: addons.fert ? x.fertApps || DEFAULT_SETTINGS.fertApps : 0, aeration: addons.aerate ? 1 : 0, leaves: addons.leaves ? 1 : 0, shrubs: +addons.shrubs || 0 };
}
var visitIntervalDays = (plan) => plan === "Weekly" ? 7 : plan === "Every two weeks" ? 14 : plan === "No mowing" ? 35 : null;
function applyCredit(amount_cents, fee_cents, credit_cents) {
  const discount_cents = Math.max(0, Math.min(credit_cents || 0, fee_cents, amount_cents - 50));
  return { charge_cents: amount_cents - discount_cents, fee_cents: fee_cents - discount_cents, discount_cents };
}
function prepaidPayout(amountDollars, prepayDiscount, takeRate) {
  const gross = Math.round(amountDollars * (1 - prepayDiscount) * 100);
  const fee = Math.round(gross * takeRate);
  return { amount_cents: gross, fee_cents: fee, net_cents: gross - fee };
}
function splitFee(amountDollars, takeRate) {
  const amount_cents = Math.round(amountDollars * 100);
  const fee_cents = Math.round(amount_cents * takeRate);
  return { amount_cents, fee_cents, net_cents: amount_cents - fee_cents };
}
function validRateCard(rc, tierCount) {
  const x = rc;
  const num = (n, lo, hi) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
  const tiers = (a) => Array.isArray(a) && a.length === tierCount && a.every((n) => num(n, 1, 9999));
  return !!x && tiers(x.mowTiers) && (x.fertTiers === null || tiers(x.fertTiers)) && num(x.biweeklyPremium, 0, 1) && num(x.oneTimeMult, 0.5, 5) && num(x.bundleDiscount, 0, 0.5) && !!x.addons && ADDONS.every((a) => x.addons[a.key] === null || num(x.addons[a.key], 0, 9999));
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
async function callerUser(req) {
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db().auth.getUser(jwt);
  return data.user ?? null;
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
var rand = (n) => crypto.getRandomValues(new Uint8Array(n));
function slugify(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "pro";
  return `${base}-${Array.from(rand(2)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
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
var isDate = (s2) => typeof s2 === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s2);
var str = (v, max) => String(v ?? "").trim().slice(0, max);

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
async function createProviderAccount(v) {
  const a = await stripeV2("POST", "/v2/core/accounts", {
    contact_email: v.email,
    display_name: v.business,
    dashboard: "express",
    identity: { country: "us" },
    defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    metadata: { vendor_id: v.id }
  });
  try {
    await stripe().accounts.update(a.id, { settings: { payouts: { schedule: { interval: "weekly", weekly_anchor: "friday" } } } });
  } catch (e) {
    console.error("payout schedule", a.id, e);
  }
  return a.id;
}
async function providerOnboardingUrl(account, refreshUrl, returnUrl) {
  const l = await stripeV2("POST", "/v2/core/account_links", {
    account,
    use_case: { type: "account_onboarding", account_onboarding: { refresh_url: refreshUrl, return_url: returnUrl } }
  });
  return l.url;
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
async function notifyCardProblem(b, label, amount, why) {
  const link = bookingLink(b.ref, b.access_token) + "&card=1";
  await sendEmail("payment.failed", b.customer_email, `Action needed: update your card — ${b.ref}`, `Hi ${b.customer_name},

We couldn't charge ${usd(amount, 2)} for your ${label.toLowerCase()}${why ? ` (${why})` : ""}. Please update your card: ${link}`);
  if (b.sms_consent) await sendSms("payment.failed", b.customer_phone, `We couldn't charge your card for ${label.toLowerCase()}. Update it here: ${link}`);
  await notifyAdmin("payment.failed", `Card failed on ${b.ref}`, `${label} ${usd(amount, 2)} failed: ${why ?? "unknown"}`);
}

// _shared/services.ts
var todayCT = () => (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
var addDays = (iso, n) => {
  const d = /* @__PURE__ */ new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
var addYear = (iso) => {
  const d = /* @__PURE__ */ new Date(iso + "T12:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
};
var KINDS = ["visit", "fert", "aeration", "leaves", "shrubs"];
var cents = (dollars) => Math.round(dollars * 100);
var firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";
async function loadBooking(id) {
  const { data } = await db().from("bookings").select("*").eq("id", id).maybeSingle();
  if (!data) throw new UserError("Booking not found.");
  return data;
}
async function loadVendor(id) {
  if (!id) return null;
  const { data } = await db().from("vendors").select("*").eq("id", id).maybeSingle();
  return data ?? null;
}
function serviceYear(b, date) {
  let start = b.service_year_start ?? date;
  while (addYear(start) <= date) start = addYear(start);
  return { start, end: addYear(start) };
}
async function usedItems(b, year) {
  const { data } = await db().from("visits").select("visit_date,items").eq("booking_id", b.id);
  const used = Object.fromEntries(KINDS.map((k) => [k, 0]));
  let inYear = 0;
  for (const v of data ?? []) {
    const within = v.visit_date >= year.start && v.visit_date < year.end;
    if (within) {
      for (const k of v.items) used[k] = (used[k] ?? 0) + 1;
      inYear++;
    }
  }
  return { used, inYear, total: (data ?? []).length };
}
async function visitOptions(b, date = todayCT()) {
  if (!b.quote) return [];
  const year = serviceYear(b, date);
  const { used } = await usedItems(b, year);
  const lim = itemLimits(b.plan, b.quote, b.addons);
  return KINDS.filter((k) => lim[k] > 0).map((k) => ({
    kind: k,
    label: itemLabel(k, b.plan),
    amount: itemAmount(b.quote, k),
    remaining: Math.max(0, lim[k] - (used[k] ?? 0)),
    blocked: false
  }));
}
async function completeVisit(bookingId, input, by) {
  const b = await loadBooking(bookingId);
  const v = await loadVendor(b.vendor_id);
  if (!v || !b.quote) throw new UserError("This booking has no provider and price yet.");
  if (!["matched", "scheduled", "active"].includes(b.status)) throw new UserError("Visits can be logged only on scheduled or active bookings.");
  if (!b.stripe_payment_method_id || !b.stripe_customer_id) throw new UserError("The customer hasn't saved a card yet.");
  if (!v.stripe_account_id || !v.stripe_charges_enabled) throw new UserError("Stripe payouts aren't active for this provider yet.");
  const date = isDate(input.date) ? String(input.date) : todayCT();
  if (date > todayCT()) throw new UserError("A visit can't be logged for a future date.");
  if (date < addDays(todayCT(), -60)) throw new UserError("Visits older than 60 days need the MowBrokers team.");
  if (b.paused_until && date <= b.paused_until) throw new UserError(`The customer paused service until ${fmtDate(b.paused_until)}.`);
  const notes = str(input.notes, 2e3);
  if (notes.length < 10) throw new UserError("Add a short service note: what you did and anything the customer should know.");
  const items = [...new Set((Array.isArray(input.items) ? input.items : []).map(String))];
  if (!items.length || items.some((k) => !KINDS.includes(k))) throw new UserError("Choose what you did on this visit.");
  const photo = input.photoPath ? str(input.photoPath, 300) : null;
  if (photo && !photo.startsWith(`${v.id}/${b.id}/`)) throw new UserError("That photo doesn't belong to this booking.");
  const year = serviceYear(b, date);
  const { used, total } = await usedItems(b, year);
  const lim = itemLimits(b.plan, b.quote, b.addons);
  for (const k of items) {
    if ((lim[k] ?? 0) <= 0) throw new UserError(`${itemLabel(k, b.plan)} isn't part of this customer's plan.`);
    if ((used[k] ?? 0) >= lim[k]) throw new UserError(`${itemLabel(k, b.plan)}: all ${lim[k]} for this service year are already logged. Re-service visits under the guarantee are free.`);
  }
  const s2 = await getSettings();
  const ex = extrasOf(s2);
  const takeRate = b.quote.takeRate ?? s2.takeRate;
  const prepayActive = !!(b.prepay_payment_id && b.prepaid_through && date < b.prepaid_through);
  const usedThisYear = KINDS.reduce((t, k) => t + (used[k] ?? 0), 0);
  const startPrepay = b.prepay && b.plan !== "One-time cut" && !prepayActive && usedThisYear === 0;
  const covers = startPrepay ? Object.fromEntries(KINDS.map((k) => [k, lim[k] ?? 0])) : b.prepay_covers ?? {};
  const discount = b.quote.prepayDiscount ?? ex.prepayDiscount;
  const lines = items.map((k) => {
    const amount = itemAmount(b.quote, k);
    const covered2 = (prepayActive || startPrepay) && (used[k] ?? 0) < (covers[k] ?? 0);
    return { kind: k, amount, covered: covered2 };
  });
  const { data: visit, error: vErr } = await db().from("visits").insert({ booking_id: b.id, vendor_id: v.id, visit_date: date, items, notes, photo_path: photo, logged_by: by }).select("*").single();
  if (vErr) throw vErr;
  const interval = visitIntervalDays(b.plan);
  const patch = {
    status: b.plan === "One-time cut" && items.includes("visit") && !KINDS.some((k) => k !== "visit" && (lim[k] ?? 0) > (used[k] ?? 0) + (items.includes(k) ? 1 : 0)) ? "completed" : "active",
    first_visit: b.first_visit ?? date,
    service_year_start: b.service_year_start ?? date,
    contacted_at: b.contacted_at ?? (/* @__PURE__ */ new Date()).toISOString(),
    respond_by: null,
    visits_charged: b.visits_charged + items.filter((k) => k === "visit").length,
    fert_charged: b.fert_charged + items.filter((k) => k === "fert").length
  };
  if (interval && (items.includes("visit") || b.plan === "No mowing" && items.length)) patch.next_visit_due = addDays(date, interval);
  await db().from("bookings").update(patch).eq("id", b.id);
  const fresh = { ...b, ...patch };
  await logEvent(b.id, v.id, "visit", `${items.join(", ")} on ${date} (${by})`);
  const results = { charged: 0, status: "succeeded", covered: 0 };
  const billed = lines.filter((l) => !l.covered);
  const covered = lines.filter((l) => l.covered);
  const label = (ls) => ls.map((l) => itemLabel(l.kind, b.plan)).join(" + ");
  if (startPrepay) {
    const prepayCents = cents(b.quote.prepay ?? Math.round(b.quote.annual * (1 - discount)));
    const billedCents = billed.reduce((t, l) => t + cents(l.amount), 0);
    const billedFee = billed.reduce((t, l) => t + splitFee(l.amount, takeRate).fee_cents, 0);
    const credit = applyCredit(billedCents + prepayCents, billedFee + Math.round(prepayCents * takeRate), fresh.credit_cents);
    const row = await insertPayment({
      booking_id: b.id,
      vendor_id: v.id,
      kind: "prepay",
      label: `${billed.length ? label(billed) + " + " : ""}Season prepay (${Math.round(discount * 100)}% off)`,
      amount_cents: credit.charge_cents,
      fee_cents: Math.max(0, billedFee - credit.discount_cents),
      net_cents: billedCents - billedFee,
      discount_cents: credit.discount_cents,
      visit_id: visit.id,
      status: "processing",
      items: [
        ...billed.map((l) => ({ kind: l.kind, amount_cents: cents(l.amount) })),
        ...covered.map((l) => ({ kind: l.kind, amount_cents: cents(l.amount), covered: true })),
        { kind: "prepay", amount_cents: prepayCents, through: year.end, covers }
      ]
    });
    await db().from("visits").update({ payment_id: row.id }).eq("id", visit.id);
    const r = await executePayment(row, fresh, v);
    Object.assign(results, { charged: credit.charge_cents / 100, status: r.status, message: r.message, covered: covered.length });
  } else {
    if (covered.length) {
      const r = await payoutCovered(fresh, v, visit.id, covered.map((l) => ({ kind: l.kind, amount: l.amount })), discount, takeRate);
      results.covered = covered.length;
      if (r.status !== "succeeded") Object.assign(results, { status: "payout_failed", message: r.message });
    }
    if (billed.length) {
      const sum = billed.reduce((t, l) => t + l.amount, 0);
      const split = splitFee(sum, takeRate);
      const credit = applyCredit(split.amount_cents, split.fee_cents, fresh.credit_cents);
      const row = await insertPayment({
        booking_id: b.id,
        vendor_id: v.id,
        kind: "service",
        label: label(billed),
        amount_cents: credit.charge_cents,
        fee_cents: credit.fee_cents,
        net_cents: split.net_cents,
        discount_cents: credit.discount_cents,
        visit_id: visit.id,
        status: "processing",
        items: billed.map((l) => ({ kind: l.kind, amount_cents: cents(l.amount) }))
      });
      await db().from("visits").update({ payment_id: row.id }).eq("id", visit.id);
      const r = await executePayment(row, fresh, v);
      Object.assign(results, { charged: credit.charge_cents / 100, status: r.status, message: r.message });
    }
  }
  await sendServiceReport(fresh, v, visit.id, date, items, notes, !!photo, results);
  await maybeRequestReview(fresh, v, total + 1);
  return { visitId: visit.id, ...results };
}
async function insertPayment(row) {
  const { data, error } = await db().from("payments").insert(row).select("*").single();
  if (error) throw error;
  return data;
}
async function executePayment(p, b, v) {
  const attempt = (p.attempts ?? 0) + 1;
  await db().from("payments").update({ attempts: attempt }).eq("id", p.id);
  const common = {
    customer: b.stripe_customer_id,
    payment_method: b.stripe_payment_method_id,
    off_session: true,
    confirm: true,
    currency: "usd",
    description: `${p.label} — ${v.business} — ${b.ref}`,
    statement_descriptor_suffix: "MOWBROKERS",
    metadata: { booking_id: b.id, ref: b.ref, vendor_id: v.id, payment_id: p.id, kind: p.kind }
  };
  let pi = null, status = "processing", failure = null;
  try {
    if (p.kind === "prepay") pi = await stripe().paymentIntents.create({ amount: p.amount_cents, ...common }, { idempotencyKey: `pay-${p.id}-${attempt}` });
    else pi = await stripe().paymentIntents.create({ amount: p.amount_cents, ...common, application_fee_amount: p.fee_cents, transfer_data: { destination: v.stripe_account_id } }, { idempotencyKey: `pay-${p.id}-${attempt}` });
    status = pi.status === "succeeded" ? "succeeded" : pi.status === "processing" ? "processing" : "failed";
    if (status === "failed") failure = `Payment needs attention (${pi.status}).`;
  } catch (e) {
    const err = e;
    status = "failed";
    failure = err.message || "Card was declined.";
    pi = err.payment_intent ?? null;
  }
  const chargeId = typeof pi?.latest_charge === "string" ? pi.latest_charge : pi?.latest_charge?.id ?? null;
  await db().from("payments").update({ status, failure_message: failure, stripe_payment_intent_id: pi?.id ?? p.stripe_payment_intent_id, stripe_charge_id: chargeId }).eq("id", p.id);
  if (status === "failed") {
    await notifyCardProblem(b, p.label, p.amount_cents / 100, failure);
    return { status, message: `Charge failed: ${failure}. We emailed the customer to update their card; retry once they have.` };
  }
  await afterSuccessfulCharge(p, b);
  if (p.kind === "prepay" && chargeId) {
    const pre = p.items;
    const meta = pre.find((i) => i.kind === "prepay");
    await db().from("bookings").update({ prepay_payment_id: p.id, prepaid_through: meta?.through ?? null, prepay_covers: meta?.covers ?? null }).eq("id", b.id);
    if (p.net_cents > 0) await transferTo(v, p.net_cents, chargeId, b, `${p.label} (provider share)`, p.id);
    const cov = pre.filter((i) => i.covered);
    if (cov.length) {
      const fresh = await loadBooking(b.id);
      await payoutCovered(fresh, v, p.visit_id, cov.map((i) => ({ kind: i.kind, amount: i.amount_cents / 100 })), fresh.quote?.prepayDiscount ?? 0.05, fresh.quote?.takeRate ?? 0.12, chargeId);
    }
  }
  return { status };
}
async function transferTo(v, amount_cents, sourceCharge, b, what, paymentId) {
  try {
    const t = await stripe().transfers.create({ amount: amount_cents, currency: "usd", destination: v.stripe_account_id, source_transaction: sourceCharge, transfer_group: b.ref, description: what, metadata: { booking_id: b.id, payment_id: paymentId } }, { idempotencyKey: `xfer-${paymentId}` });
    await db().from("payments").update({ stripe_transfer_id: t.id }).eq("id", paymentId);
    return t.id;
  } catch (e) {
    await notifyAdmin("payout.failed", `Provider payout failed on ${b.ref}`, `${what}: ${e.message}. Retry from the booking in the console.`);
    return null;
  }
}
async function payoutCovered(b, v, visitId, items, discount, takeRate, sourceCharge) {
  let source = sourceCharge ?? null;
  if (!source && b.prepay_payment_id) {
    const { data } = await db().from("payments").select("stripe_charge_id").eq("id", b.prepay_payment_id).maybeSingle();
    source = data?.stripe_charge_id ?? null;
  }
  const parts = items.map((i) => ({ kind: i.kind, ...prepaidPayout(i.amount, discount, takeRate) }));
  const row = await insertPayment({
    booking_id: b.id,
    vendor_id: v.id,
    kind: "prepaid_visit",
    label: `${items.map((i) => itemLabel(i.kind, b.plan)).join(" + ")} (prepaid)`,
    amount_cents: parts.reduce((t2, p) => t2 + p.amount_cents, 0),
    fee_cents: parts.reduce((t2, p) => t2 + p.fee_cents, 0),
    net_cents: parts.reduce((t2, p) => t2 + p.net_cents, 0),
    visit_id: visitId,
    status: "processing",
    items: parts.map((p) => ({ kind: p.kind, amount_cents: p.amount_cents, covered: true }))
  });
  if (!source) {
    await db().from("payments").update({ status: "failed", failure_message: "No prepay charge found to pay from." }).eq("id", row.id);
    await notifyAdmin("payout.failed", `Prepaid payout missing source on ${b.ref}`, "Retry from the booking in the console.");
    return { status: "failed", message: "Logged, but the provider payout needs the MowBrokers team." };
  }
  const t = await transferTo(v, row.net_cents, source, b, row.label, row.id);
  await db().from("payments").update({ status: t ? "succeeded" : "failed", failure_message: t ? null : "Transfer failed" }).eq("id", row.id);
  return t ? { status: "succeeded" } : { status: "failed", message: "Logged, but the payout failed. The MowBrokers team has been alerted." };
}
async function afterSuccessfulCharge(p, b) {
  if (p.discount_cents > 0) {
    const fresh = await loadBooking(b.id);
    await db().from("bookings").update({ credit_cents: Math.max(0, fresh.credit_cents - p.discount_cents) }).eq("id", b.id);
  }
  const { data: ref } = await db().from("referrals").select("*").eq("referee_booking_id", b.id).eq("status", "pending").maybeSingle();
  if (ref) {
    const s2 = await getSettings();
    const amt = extrasOf(s2).referralCreditCents;
    const { data: rb } = await db().from("bookings").select("*").eq("id", ref.referrer_booking_id).maybeSingle();
    await db().from("referrals").update({ status: "earned", earned_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", ref.id);
    if (rb) {
      await db().from("bookings").update({ credit_cents: (rb.credit_cents ?? 0) + amt }).eq("id", rb.id);
      await sendEmail("referral.earned", rb.customer_email, `You earned ${usd(amt / 100)} — thanks for the referral`, `Hi ${firstName(rb.customer_name)},

${firstName(b.customer_name)} booked through your link, so you've earned ${usd(amt / 100)} off your lawn care. It comes off your next charges automatically.

Your account: ${bookingLink(rb.ref, rb.access_token)}`);
      await logEvent(rb.id, rb.vendor_id, "referral_earned", b.ref);
    }
  }
}
async function retryPayment(paymentId) {
  const { data } = await db().from("payments").select("*").eq("id", paymentId).maybeSingle();
  const p = data;
  if (!p || p.status !== "failed") throw new UserError("Only failed payments can be retried.");
  const b = await loadBooking(p.booking_id);
  const v = await loadVendor(p.vendor_id);
  if (!v) throw new UserError("Provider not found.");
  if (p.kind === "prepaid_visit") {
    const fresh2 = b;
    let source = null;
    if (fresh2.prepay_payment_id) {
      const { data: pp } = await db().from("payments").select("stripe_charge_id").eq("id", fresh2.prepay_payment_id).maybeSingle();
      source = pp?.stripe_charge_id ?? null;
    }
    if (!source) throw new UserError("The prepay charge hasn't gone through yet.");
    const t = await transferTo(v, p.net_cents, source, b, p.label, p.id);
    await db().from("payments").update({ status: t ? "succeeded" : "failed" }).eq("id", p.id);
    return { status: t ? "succeeded" : "failed" };
  }
  if (!b.stripe_payment_method_id) throw new UserError("The customer has no card on file.");
  const r = await executePayment(p, b, v);
  if (r.status === "failed") throw new UserError(r.message ?? "Charge failed again.");
  const fresh = await loadBooking(b.id);
  await sendEmail("payment.receipt", b.customer_email, `Receipt: ${p.label} ${usd(p.amount_cents / 100, 2)} — ${b.ref}`, `Hi ${firstName(b.customer_name)},

We charged ${usd(p.amount_cents / 100, 2)} for ${p.label.toLowerCase()} with ${v.business}.

Your account: ${bookingLink(fresh.ref, fresh.access_token)}`);
  return r;
}
async function sendServiceReport(b, v, visitId, date, items, notes, hasPhoto, money) {
  const link = bookingLink(b.ref, b.access_token);
  const lines = items.map((k) => `• ${itemLabel(k, b.plan)}`).join("\n");
  const pay = money.status === "failed" ? "We couldn't charge your card for this visit. Please update it from your account page." : money.charged ? `Charged to your card: ${usd(money.charged, 2)}.${money.covered ? " The rest was covered by your season prepay." : ""}` : money.covered ? "Covered by your season prepay. Nothing was charged today." : "";
  const next = b.next_visit_due && b.plan !== "One-time cut" ? `
Next visit due around ${fmtDate(b.next_visit_due)}. ${v.business} will reach out to schedule.` : "";
  await sendEmail(
    "visit.report",
    b.customer_email,
    `Service report: ${fmtDate(date)} — ${v.business}`,
    `Hi ${firstName(b.customer_name)},

${v.business} completed your service on ${fmtDate(date)}.

What was done:
${lines}

Technician's notes:
${notes}
${hasPhoto ? "\nA photo from the visit is on your account page.\n" : ""}
${pay}${next}

Missed spot, or weeds back before your next treatment? Re-service is free: ${link}`
  );
  if (b.sms_consent) await sendSms("visit.report", b.customer_phone, `${v.business} finished your service today. Report${hasPhoto ? " and photo" : ""}: ${link}`);
}
async function maybeRequestReview(b, v, visitCount) {
  if (b.review_requested_at) return;
  const s2 = await getSettings();
  const need2 = b.plan === "One-time cut" ? 1 : extrasOf(s2).reviewAfterVisits;
  if (visitCount < need2) return;
  const { count } = await db().from("reviews").select("id", { count: "exact", head: true }).eq("booking_id", b.id);
  if (count) return;
  await db().from("bookings").update({ review_requested_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", b.id);
  await sendEmail(
    "review.request",
    b.customer_email,
    `How is ${v.business} doing?`,
    `Hi ${firstName(b.customer_name)},

You've had ${visitCount} visit${visitCount === 1 ? "" : "s"} with ${v.business}. Would you rate them? It takes 20 seconds and helps your neighbors pick a pro.

Rate ${v.business}: ${bookingLink(b.ref, b.access_token)}#review`
  );
}

// portal/index.ts
var CATEGORIES = ["MOW", "OTPS", "SLP", "TS"];
async function me(req) {
  const user = await callerUser(req);
  if (!user) throw new UserError("Please sign in again.");
  const { data } = await db().from("vendors").select("*").eq("owner_id", user.id).maybeSingle();
  return { user, vendor: data ?? null };
}
async function mine(req, bookingId) {
  const { vendor } = await me(req);
  if (!vendor) throw new UserError("No provider profile.");
  const { data } = await db().from("bookings").select("*").eq("id", str(bookingId, 60)).maybeSingle();
  if (!data || data.vendor_id !== vendor.id) throw new UserError("That booking isn't yours.");
  return { vendor, booking: data };
}
serveActions({
  async saveProfile(body, req) {
    const { user, vendor } = await me(req);
    const f = body.profile ?? {};
    const business = str(f.business, 120), contact = str(f.contact, 120), phone = toE164(f.phone), email = str(f.email, 200);
    const license = str(f.license, 60), operator = str(f.operator, 120), carrier = str(f.insurance_carrier, 120);
    const categories = (Array.isArray(f.categories) ? f.categories : []).filter((c) => CATEGORIES.includes(String(c)));
    const zips = (Array.isArray(f.zips) ? f.zips : []).map(String).filter((z) => /^\d{5}$/.test(z)).slice(0, 200);
    const custom_jobs = (Array.isArray(f.custom_jobs) ? f.custom_jobs : []).map(String).filter((c) => CUSTOM_JOBS.includes(c));
    const treats = categories.some((c) => c !== "MOW");
    const errs = [
      [business.length < 2, "Enter your business name."],
      [contact.length < 2, "Enter an owner or contact name."],
      [!phone, "Enter a 10-digit business phone."],
      [!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "Enter a valid business email."],
      [license.length < 2, treats ? "Enter your ADAI Horticulture Professional Services license number." : "Enter your city business license number."],
      [treats && operator.length < 2, "Enter your certified operator's name."],
      [!categories.length, "Choose at least one service category."],
      [carrier.length < 2, "Enter your insurance carrier."],
      [!isDate(f.insurance_expires), "Enter your policy expiration date."],
      [!zips.length, "List at least one ZIP code you serve."],
      [f.agree !== true, "Accept the program terms to continue."]
    ];
    const e = errs.find(([bad]) => bad);
    if (e) throw new UserError(e[1]);
    const s2 = await getSettings();
    if (!validRateCard(f.rate_card, s2.lots.length)) throw new UserError("Check your prices: every lot size needs a price, and percentages must be reasonable.");
    const row = {
      business,
      contact,
      phone,
      email,
      license,
      operator,
      categories,
      zips,
      custom_jobs,
      rate_card: f.rate_card,
      years: Math.max(0, Math.min(150, Math.round(Number(f.years) || 0))),
      techs: Math.max(1, Math.min(1e3, Math.round(Number(f.techs) || 1))),
      about: str(f.about, 1200),
      insurance_carrier: carrier,
      insurance_coverage: Math.max(0, Math.min(1e8, Math.round(Number(f.insurance_coverage) || 0))),
      insurance_expires: String(f.insurance_expires),
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (!vendor) {
      const { error: error2 } = await db().from("vendors").insert({ ...row, owner_id: user.id, slug: slugify(business), status: "applied" });
      if (error2) throw error2;
      await notifyAdmin("vendor.applied", `New provider application: ${business}`, `${contact} · ${phone} · ${email}
License ${license} · ${categories.join(", ")}. Start vetting in the console.`, `New provider application: ${business}.`);
      return { created: true };
    }
    const credentialChange = vendor.status === "approved" && (vendor.license !== license || vendor.insurance_expires !== row.insurance_expires || vendor.insurance_carrier !== carrier);
    const { error } = await db().from("vendors").update(row).eq("id", vendor.id);
    if (error) throw error;
    if (credentialChange) await notifyAdmin("vendor.credentials", `${business} changed license or insurance`, "Re-verify their credentials in the console.");
    return { created: false };
  },
  async coiUploadUrl(body, req) {
    const { vendor } = await me(req);
    if (!vendor) throw new UserError("Save your company details first.");
    const ext = str(body.fileName, 200).split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    if (!["pdf", "png", "jpg", "jpeg"].includes(ext)) throw new UserError("Upload a PDF, PNG or JPG.");
    const path = `${vendor.id}/${Date.now()}.${ext}`;
    const { data, error } = await db().storage.from("coi").createSignedUploadUrl(path);
    if (error || !data) throw new UserError("Upload isn't available right now.");
    return { path, token: data.token };
  },
  async saveCoiPath(body, req) {
    const { vendor } = await me(req);
    const path = str(body.path, 200);
    if (!vendor || !path.startsWith(vendor.id + "/")) throw new UserError("Not allowed.");
    await db().from("vendors").update({ coi_path: path }).eq("id", vendor.id);
    await notifyAdmin("vendor.coi", `${vendor.business} uploaded an insurance certificate`, "Verify it in the console.");
    return { ok: true };
  },
  async stripeOnboarding(_b, req) {
    const { vendor } = await me(req);
    if (!vendor) throw new UserError("Save your company details first.");
    let acct = vendor.stripe_account_id;
    if (!acct) {
      acct = await createProviderAccount(vendor);
      await db().from("vendors").update({ stripe_account_id: acct }).eq("id", vendor.id);
    }
    return { url: await providerOnboardingUrl(acct, `${env.siteUrl()}/portal.html?stripe=refresh`, `${env.siteUrl()}/portal.html?stripe=return`) };
  },
  async stripeDashboard(_b, req) {
    const { vendor } = await me(req);
    if (!vendor?.stripe_account_id) throw new UserError("Connect Stripe first.");
    try {
      return { url: (await stripe().accounts.createLoginLink(vendor.stripe_account_id)).url };
    } catch {
      throw new UserError("Finish Stripe setup first.");
    }
  },
  async refreshStripe(_b, req) {
    const { vendor } = await me(req);
    if (!vendor?.stripe_account_id) return { charges: false };
    return { charges: await syncProviderStatus(vendor.stripe_account_id) };
  },
  async schedule(body, req) {
    if (!isDate(body.date)) throw new UserError("Choose a visit date.");
    const { vendor, booking: b } = await mine(req, body.bookingId);
    if (!["matched", "scheduled", "active"].includes(b.status)) throw new UserError("This booking can't be scheduled now.");
    const date = String(body.date);
    const first = b.status === "matched";
    await db().from("bookings").update({ status: first ? "scheduled" : b.status, ...first ? { first_visit: date, scheduled_at: (/* @__PURE__ */ new Date()).toISOString() } : { next_visit_due: date }, contacted_at: b.contacted_at ?? (/* @__PURE__ */ new Date()).toISOString(), respond_by: null }).eq("id", b.id);
    await logEvent(b.id, vendor.id, "scheduled", date);
    const link = bookingLink(b.ref, b.access_token);
    await sendEmail("booking.scheduled", b.customer_email, `${first ? "First visit" : "Next visit"} set for ${fmtDate(date)} — ${b.ref}`, `Hi ${b.customer_name.split(" ")[0]},

${vendor.business} scheduled your ${first ? "first" : "next"} visit for ${fmtDate(date)}. Your card is charged after the visit.

Your account: ${link}`);
    if (b.sms_consent) await sendSms("booking.scheduled", b.customer_phone, `${vendor.business} set your ${first ? "first" : "next"} visit for ${fmtDate(date)}. Details: ${link}`);
    return { ok: true };
  },
  async markContacted(body, req) {
    const { vendor, booking: b } = await mine(req, body.bookingId);
    if (b.status !== "matched") return { ok: true };
    await db().from("bookings").update({ contacted_at: (/* @__PURE__ */ new Date()).toISOString(), respond_by: null }).eq("id", b.id);
    await logEvent(b.id, vendor.id, "contacted", str(body.note, 200));
    return { ok: true };
  },
  async visitOptions(body, req) {
    const { booking: b } = await mine(req, body.bookingId);
    return { options: await visitOptions(b, isDate(body.date) ? String(body.date) : void 0) };
  },
  async visitPhotoUploadUrl(body, req) {
    const { vendor, booking: b } = await mine(req, body.bookingId);
    const ext = str(body.fileName, 200).split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    if (!["jpg", "jpeg", "png", "webp", "heic"].includes(ext)) throw new UserError("Upload a JPG, PNG, WEBP or HEIC photo.");
    const path = `${vendor.id}/${b.id}/${Date.now()}.${ext}`;
    const { data, error } = await db().storage.from("visit-photos").createSignedUploadUrl(path);
    if (error || !data) throw new UserError("Photo upload isn't available right now.");
    return { path, token: data.token };
  },
  async completeVisit(body, req) {
    const { booking: b } = await mine(req, body.bookingId);
    return completeVisit(b.id, { date: body.date, items: body.items, notes: body.notes, photoPath: body.photoPath }, "provider");
  },
  async retryPayment(body, req) {
    const { vendor } = await me(req);
    const { data } = await db().from("payments").select("vendor_id").eq("id", str(body.paymentId, 60)).maybeSingle();
    if (!vendor || !data || data.vendor_id !== vendor.id) throw new UserError("Not allowed.");
    return retryPayment(String(body.paymentId));
  },
  async claim(body, req) {
    const { vendor } = await me(req);
    const status = String(body.status);
    if (!["vendor_notified", "resolved"].includes(status)) throw new UserError("Unknown status.");
    const { data } = await db().from("claims").select("vendor_id").eq("id", str(body.claimId, 60)).maybeSingle();
    if (!vendor || !data || data.vendor_id !== vendor.id) throw new UserError("Not allowed.");
    await db().from("claims").update({ status, resolved_at: status === "resolved" ? (/* @__PURE__ */ new Date()).toISOString() : null }).eq("id", String(body.claimId));
    return { ok: true };
  }
});
