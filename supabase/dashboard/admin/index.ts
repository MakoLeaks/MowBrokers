// @ts-nocheck
// MowBrokers Edge Function "admin" — single-file build of supabase/functions/admin + _shared for the Supabase dashboard editor.
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
var JOB_CATEGORY = { "Tree and stump removal": "TS", "Landscape bed install": "SLP" };
var RECURRING_MOW = ["Weekly", "Every two weeks"];
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
var seasonOf = (s2) => ({ ...DEFAULT_SETTINGS.season, ...s2?.season || {} });
var fertAppsOf = (s2) => +s2?.fertApps || DEFAULT_SETTINGS.fertApps;
var roundTo = (x, r) => Math.round(x / r) * r;
var cents = (x) => Math.round(x * 100) / 100;
function tierIndex(s2, acres) {
  let k = 0;
  s2.lots.forEach((t, i) => {
    if ((+acres || 0) >= t.min) k = i;
  });
  return k;
}
function quote(s2, rc, i) {
  const r = s2.roundTo || 5;
  const ti = tierIndex(s2, i.acres);
  const lot = s2.lots[ti];
  const T = (s2.terrains.find((t) => t.label === i.terrain) ?? s2.terrains[0]).mult;
  const C = (s2.coverages.find((t) => t.label === i.coverage) ?? s2.coverages[0]).mult;
  const pick = (arr) => +arr?.[ti] || +arr?.[arr.length - 1] || 0;
  const q = roundTo(pick(rc.mowTiers) * T * C, r);
  const season = seasonOf(s2), apps = fertAppsOf(s2);
  let perVisit = 0, visits = 0;
  if (i.plan === "Weekly") {
    perVisit = q;
    visits = season.weeks;
  } else if (i.plan === "Every two weeks") {
    perVisit = roundTo(q * (1 + (+rc.biweeklyPremium || 0)), r);
    visits = Math.round(season.weeks / 2);
  } else if (i.plan === "One-time cut") {
    perVisit = roundTo(q * (+rc.oneTimeMult || 1.5), r);
    visits = 1;
  }
  const mowing = perVisit * visits;
  const fertPerApp = i.fert && rc.fertTiers ? roundTo(pick(rc.fertTiers) * C, r) : 0;
  const fert = fertPerApp * apps;
  const bundle = i.fert && RECURRING_MOW.includes(i.plan) ? 0 - Math.round(fert * (+rc.bundleDiscount || 0)) || 0 : 0;
  const a = rc.addons ?? {};
  const aeration = i.aerate && a.aeration != null ? roundTo(a.aeration * lot.scale, r) : 0;
  const leaves = i.leaves && a.leafCleanup != null ? roundTo(a.leafCleanup * lot.scale, r) : 0;
  const shrubVisit = +a.shrubTrim || 0;
  const shrubs = (+i.shrubs || 0) * shrubVisit;
  const annual = mowing + fert + bundle + aeration + leaves + shrubs;
  const prepayDiscount = extrasOf(s2).prepayDiscount;
  const prepay = i.plan === "One-time cut" ? 0 : Math.round(annual * (1 - prepayDiscount));
  return {
    tier: lot.label,
    q,
    perVisit,
    visits,
    mowing,
    fertPerApp,
    fertApps: i.fert ? apps : 0,
    fert,
    bundle,
    fertVisit: i.fert ? cents((fert + bundle) / apps) : 0,
    aeration,
    leaves,
    shrubs,
    shrubVisit,
    annual,
    monthly: annual / 12,
    guideOnly: ti === s2.lots.length - 1,
    takeRate: s2.takeRate,
    prepay,
    prepayDiscount
  };
}
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
function addBusinessHours(from, hours = 24) {
  const d = new Date(from instanceof Date ? from.getTime() : from);
  d.setTime(d.getTime() + hours * 36e5);
  const dow = () => new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" })).getDay();
  while (dow() === 0 || dow() === 6) d.setTime(d.getTime() + 864e5);
  return d;
}
function eligibility(v, i, today = /* @__PURE__ */ new Date()) {
  if (v.status !== "approved") return "not approved";
  const cats = v.categories || [];
  if (i.plan !== "No mowing" && !cats.includes("MOW")) return "mowing";
  const zips = v.zips || [];
  if (zips.length && !zips.includes(i.zip)) return "zip";
  if (v.insurance_expires && /* @__PURE__ */ new Date(v.insurance_expires + "T23:59:59") < today) return "insurance expired";
  if (v.stripe_charges_enabled === false) return "payments not set up";
  const rc = v.rate_card;
  if (!rc || !rc.addons) return "no prices";
  if (i.fert && (!cats.includes("OTPS") || !rc.fertTiers)) return "fertilization";
  if (i.aerate && rc.addons.aeration == null) return "aeration";
  if (i.leaves && rc.addons.leafCleanup == null) return "leaf cleanup";
  if (i.shrubs > 0 && rc.addons.shrubTrim == null) return "shrub trimming";
  for (const c of i.custom || []) {
    if (!(v.custom_jobs || []).includes(c)) return c;
    if (JOB_CATEGORY[c] && !cats.includes(JOB_CATEGORY[c])) return c;
  }
  return "";
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
async function isAdmin(userId) {
  const { data } = await db().from("profiles").select("role").eq("id", userId).maybeSingle();
  return data?.role === "admin";
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
var isDate = (s2) => typeof s2 === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s2);
var str = (v, max) => String(v ?? "").trim().slice(0, max);
var CHECKS = [
  ["business", "City business license verified"],
  ["license", "ADAI Horticulture license and OTPS certified operator verified (only if offering treatments)"],
  ["insurance", "Certificate of insurance verified with carrier"],
  ["background", "Background checks on owner and crew who visit homes"],
  ["references", "Three customer references called"],
  ["rideAlong", "Ride-along on a regular mowing route"],
  ["agreement", "Provider agreement signed"]
];

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
var cents2 = (dollars) => Math.round(dollars * 100);
var specOf = (b) => ({ acres: b.yard.acres, zip: b.zip, terrain: b.yard.terrain, coverage: b.yard.coverage, plan: b.plan, fert: b.addons.fert, aerate: b.addons.aerate, leaves: b.addons.leaves, shrubs: b.addons.shrubs, custom: b.custom });
var firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";
async function loadBooking(id2) {
  const { data } = await db().from("bookings").select("*").eq("id", id2).maybeSingle();
  if (!data) throw new UserError("Booking not found.");
  return data;
}
async function loadVendor(id2) {
  if (!id2) return null;
  const { data } = await db().from("vendors").select("*").eq("id", id2).maybeSingle();
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
    const prepayCents = cents2(b.quote.prepay ?? Math.round(b.quote.annual * (1 - discount)));
    const billedCents = billed.reduce((t, l) => t + cents2(l.amount), 0);
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
        ...billed.map((l) => ({ kind: l.kind, amount_cents: cents2(l.amount) })),
        ...covered.map((l) => ({ kind: l.kind, amount_cents: cents2(l.amount), covered: true })),
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
        items: billed.map((l) => ({ kind: l.kind, amount_cents: cents2(l.amount) }))
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
async function unusedPrepayCents(b) {
  if (!b.prepay_payment_id || !b.prepaid_through || b.prepaid_through <= todayCT()) return 0;
  const { data: pp } = await db().from("payments").select("*").eq("id", b.prepay_payment_id).maybeSingle();
  if (!pp || pp.status !== "succeeded") return 0;
  const portion = (pp.items ?? []).find((i) => i.kind === "prepay")?.amount_cents ?? 0;
  const { data: used } = await db().from("payments").select("amount_cents").eq("booking_id", b.id).eq("kind", "prepaid_visit").gte("created_at", pp.created_at);
  const consumed = (used ?? []).reduce((t, r) => t + r.amount_cents, 0);
  return Math.max(0, Math.min(portion - consumed, pp.amount_cents - pp.refunded_cents));
}
async function refundPayment(paymentId, amountCents, reason) {
  const { data } = await db().from("payments").select("*").eq("id", paymentId).maybeSingle();
  const p = data;
  if (!p || p.status !== "succeeded" || !p.stripe_payment_intent_id) throw new UserError("Only successful card charges can be refunded.");
  if (p.kind === "prepaid_visit") throw new UserError("This is a provider payout from a prepay. Refund the prepay charge instead.");
  const max = p.amount_cents - p.refunded_cents;
  const amt = Math.round(amountCents);
  if (!(amt >= 50 && amt <= max)) throw new UserError(`Refund between $0.50 and ${usd(max / 100, 2)}.`);
  const b = await loadBooking(p.booking_id);
  const params = { payment_intent: p.stripe_payment_intent_id, amount: amt, reason: "requested_by_customer", metadata: { payment_id: p.id, note: reason.slice(0, 200) } };
  if (p.kind !== "prepay") Object.assign(params, { reverse_transfer: true, refund_application_fee: true });
  await stripe().refunds.create(params, { idempotencyKey: `refund-${p.id}-${p.refunded_cents}-${amt}` });
  await db().from("payments").update({ refunded_cents: p.refunded_cents + amt }).eq("id", p.id);
  await logEvent(b.id, p.vendor_id, "refund", `${usd(amt / 100, 2)} on ${p.label}${reason ? ": " + reason : ""}`);
  await sendEmail("payment.refund", b.customer_email, `Refund: ${usd(amt / 100, 2)} — ${b.ref}`, `Hi ${firstName(b.customer_name)},

We refunded ${usd(amt / 100, 2)} for ${p.label.toLowerCase()} to your card. It usually appears within 5–10 business days.

Your account: ${bookingLink(b.ref, b.access_token)}`);
  return { refunded: amt / 100 };
}
async function cancelBooking(bookingId, by, reason) {
  const b = await loadBooking(bookingId);
  if (["cancelled", "completed"].includes(b.status)) throw new UserError("This booking is already closed.");
  const refund = await unusedPrepayCents(b);
  await db().from("bookings").update({ status: "cancelled", cancelled_at: (/* @__PURE__ */ new Date()).toISOString(), cancel_reason: reason.slice(0, 300), cancelled_by: by, respond_by: null }).eq("id", b.id);
  let refunded = 0;
  if (refund >= 50 && b.prepay_payment_id) {
    try {
      refunded = (await refundPayment(b.prepay_payment_id, refund, "Unused season prepay")).refunded;
    } catch (e) {
      await notifyAdmin("refund.failed", `Prepay refund failed on ${b.ref}`, e.message);
    }
  }
  await logEvent(b.id, b.vendor_id, "cancelled", `${by}${reason ? ": " + reason : ""}`);
  await sendEmail("booking.cancelled", b.customer_email, `Booking cancelled — ${b.ref}`, `Hi ${firstName(b.customer_name)},

Your MowBrokers service (${b.ref}) is cancelled. You won't be charged for future visits.${refunded ? ` We refunded ${usd(refunded, 2)} of unused prepay to your card.` : ""}

Changed your mind? Reply to this email and we'll set you back up.`);
  const v = await loadVendor(b.vendor_id);
  if (v) await sendEmail("booking.cancelled", v.email, `Customer cancelled — ${b.ref}`, `${b.customer_name} (${b.ref}) cancelled${by === "customer" ? " from their account" : ""}. Don't schedule further visits.${reason ? `
Reason given: ${reason}` : ""}`);
  await notifyAdmin("booking.cancelled", `Cancelled: ${b.ref}`, `${b.customer_name}${v ? " with " + v.business : ""} · by ${by}${reason ? " · " + reason : ""}${refunded ? ` · refunded ${usd(refunded, 2)}` : ""}`);
  return { refunded };
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

// admin/index.ts
var guard = (fn) => async (b, req) => {
  const u = await callerUser(req);
  if (!u || !await isAdmin(u.id)) throw new UserError("Not authorized.");
  return fn(b);
};
var id = (v) => str(v, 60);
var loadBooking2 = async (bid) => {
  const { data } = await db().from("bookings").select("*").eq("id", id(bid)).maybeSingle();
  if (!data) throw new UserError("Booking not found.");
  return data;
};
serveActions({
  setChecklist: guard(async (b) => {
    const key = String(b.key);
    if (!CHECKS.some(([k]) => k === key)) throw new UserError("Unknown check.");
    const { data } = await db().from("vendors").select("checklist,status").eq("id", id(b.vendorId)).single();
    await db().from("vendors").update({ checklist: { ...data?.checklist ?? {}, [key]: b.value === true }, status: data?.status === "applied" ? "vetting" : data?.status }).eq("id", id(b.vendorId));
    return { ok: true };
  }),
  setVendorStatus: guard(async (b) => {
    const status = String(b.status);
    if (!["applied", "vetting", "approved", "suspended", "rejected"].includes(status)) throw new UserError("Unknown status.");
    const { data } = await db().from("vendors").select("*").eq("id", id(b.vendorId)).single();
    const v = data;
    if (status === "approved") {
      const treats = (v.categories || []).some((c) => c !== "MOW");
      const missing = CHECKS.filter(([k]) => !v.checklist?.[k] && (k !== "license" || treats));
      if (missing.length) throw new UserError(`Finish vetting first: ${missing.map(([, l]) => l.toLowerCase()).join("; ")}.`);
    }
    await db().from("vendors").update({ status, approved_at: status === "approved" ? (/* @__PURE__ */ new Date()).toISOString() : v.approved_at }).eq("id", v.id);
    if (status === "approved") {
      await sendEmail("vendor.approved", v.email, "You're live on MowBrokers", `Hi ${v.contact},

${v.business} passed vetting.${v.stripe_charges_enabled ? " Your profile is now live, and homeowners in your ZIPs can book you." : " One last step: set up payouts with Stripe in your portal. Your profile goes live as soon as Stripe is connected."}

How it works: when a customer books you, call them within one business day and tap “I called them” in your portal. After each visit, tap “Visit done”, note what you did (add a photo if you like) and the customer is charged automatically.

Portal: ${env.siteUrl()}/portal.html`);
      await sendSms("vendor.approved", v.phone, `${v.business} is approved on MowBrokers. ${v.stripe_charges_enabled ? "You're live." : "Set up Stripe payouts in your portal to go live."}`);
    }
    if (status === "suspended") await sendEmail("vendor.suspended", v.email, "Your MowBrokers profile is paused", `Hi ${v.contact},

We've paused ${v.business} on MowBrokers, so new customers can't book you. Existing customers are unaffected. Reply to this email to resolve it.`);
    return { ok: true };
  }),
  updateVendor: guard(async (b) => {
    const s2 = await getSettings();
    const row = {};
    if (b.rate_card !== void 0) {
      if (!validRateCard(b.rate_card, s2.lots.length)) throw new UserError("Check the prices.");
      row.rate_card = b.rate_card;
    }
    if (b.about !== void 0) row.about = str(b.about, 1200);
    if (b.notes !== void 0) row.notes = str(b.notes, 4e3);
    if (b.insurance_expires !== void 0) {
      if (!isDate(b.insurance_expires)) throw new UserError("Enter a valid date.");
      row.insurance_expires = b.insurance_expires;
    }
    await db().from("vendors").update(row).eq("id", id(b.vendorId));
    return { ok: true };
  }),
  coiUrl: guard(async (b) => {
    const { data } = await db().from("vendors").select("coi_path").eq("id", id(b.vendorId)).single();
    if (!data?.coi_path) throw new UserError("No certificate uploaded.");
    const { data: u } = await db().storage.from("coi").createSignedUrl(data.coi_path, 300);
    if (!u) throw new UserError("Couldn't open the file.");
    return { url: u.signedUrl };
  }),
  assign: guard(async (b) => {
    const [booking, { data: vd }, s2] = await Promise.all([loadBooking2(b.bookingId), db().from("vendors").select("*").eq("id", id(b.vendorId)).single(), getSettings()]);
    const v = vd;
    if (!["new", "pending_card", "matched"].includes(booking.status)) throw new UserError("Only unscheduled bookings can be reassigned.");
    const why = eligibility(v, specOf(booking));
    if (why) throw new UserError(`That provider doesn't qualify (${why}).`);
    const x = quote(s2, v.rate_card, specOf(booking));
    const status = booking.stripe_payment_method_id ? "matched" : "pending_card";
    const { data: up } = await db().from("bookings").update({ vendor_id: v.id, quote: { ...x, takeRate: s2.takeRate }, status, chosen_by_customer: false, matched_at: (/* @__PURE__ */ new Date()).toISOString(), contacted_at: null, nudged_at: null }).eq("id", booking.id).select("*").single();
    await logEvent(booking.id, v.id, "assigned", "by operator");
    const link = bookingLink(booking.ref, booking.access_token);
    if (status === "pending_card") {
      await sendEmail("booking.offer", booking.customer_email, `Your pro and price — ${booking.ref}`, `Hi ${firstName(booking.customer_name)},

We matched you with ${v.business}. Your season price is ${usd(x.annual)} (${booking.plan}${x.perVisit ? `, ${usd(x.perVisit)} per cut` : ""}).

Save a card to confirm. You're charged only after each visit: ${link}&card=1`);
      if (booking.sms_consent) await sendSms("booking.offer", booking.customer_phone, `We matched you with ${v.business}. Confirm your price and save a card: ${link}&card=1`);
    } else {
      await startResponseClock(up, v.id);
      await announceBooking(up);
    }
    return { ok: true };
  }),
  schedule: guard(async (b) => {
    if (!isDate(b.date)) throw new UserError("Choose a date.");
    const bk = await loadBooking2(b.bookingId);
    if (!["matched", "scheduled", "active"].includes(bk.status)) throw new UserError("This booking can't be scheduled now.");
    const first = bk.status === "matched";
    await db().from("bookings").update({ status: first ? "scheduled" : bk.status, ...first ? { first_visit: b.date, scheduled_at: (/* @__PURE__ */ new Date()).toISOString() } : { next_visit_due: b.date }, contacted_at: bk.contacted_at ?? (/* @__PURE__ */ new Date()).toISOString(), respond_by: null }).eq("id", bk.id);
    await logEvent(bk.id, bk.vendor_id, "scheduled", `${b.date} (operator)`);
    await sendEmail("booking.scheduled", bk.customer_email, `${first ? "First" : "Next"} visit set for ${fmtDate(String(b.date))} — ${bk.ref}`, `Hi ${firstName(bk.customer_name)},

Your ${first ? "first" : "next"} visit is scheduled for ${fmtDate(String(b.date))}.

${bookingLink(bk.ref, bk.access_token)}`);
    return { ok: true };
  }),
  markContacted: guard(async (b) => {
    const bk = await loadBooking2(b.bookingId);
    await db().from("bookings").update({ contacted_at: (/* @__PURE__ */ new Date()).toISOString(), respond_by: null }).eq("id", bk.id);
    await logEvent(bk.id, bk.vendor_id, "contacted", "logged by operator");
    return { ok: true };
  }),
  visitOptions: guard(async (b) => ({ options: await visitOptions(await loadBooking2(b.bookingId), isDate(b.date) ? String(b.date) : void 0) })),
  completeVisit: guard(async (b) => completeVisit(id(b.bookingId), { date: b.date, items: b.items, notes: b.notes, photoPath: b.photoPath }, "operator")),
  visitPhotoUploadUrl: guard(async (b) => {
    const bk = await loadBooking2(b.bookingId);
    if (!bk.vendor_id) throw new UserError("Assign a provider first.");
    const ext = str(b.fileName, 200).split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    if (!["jpg", "jpeg", "png", "webp", "heic"].includes(ext)) throw new UserError("Upload a JPG, PNG, WEBP or HEIC photo.");
    const path = `${bk.vendor_id}/${bk.id}/${Date.now()}.${ext}`;
    const { data, error } = await db().storage.from("visit-photos").createSignedUploadUrl(path);
    if (error || !data) throw new UserError("Photo upload isn't available right now.");
    return { path, token: data.token };
  }),
  visitPhotoUrl: guard(async (b) => {
    const { data } = await db().from("visits").select("photo_path").eq("id", id(b.visitId)).maybeSingle();
    if (!data?.photo_path) throw new UserError("No photo for this visit.");
    const { data: u } = await db().storage.from("visit-photos").createSignedUrl(data.photo_path, 600);
    if (!u) throw new UserError("Couldn't open the photo.");
    return { url: u.signedUrl };
  }),
  retryPayment: guard(async (b) => retryPayment(id(b.paymentId))),
  refund: guard(async (b) => refundPayment(id(b.paymentId), Math.round(Number(b.amount) * 100), str(b.reason, 200))),
  addCredit: guard(async (b) => {
    const bk = await loadBooking2(b.bookingId);
    const amt = Math.round(Number(b.amount) * 100);
    if (!(amt >= 100 && amt <= 5e4)) throw new UserError("Credit between $1 and $500.");
    await db().from("bookings").update({ credit_cents: bk.credit_cents + amt }).eq("id", bk.id);
    await logEvent(bk.id, bk.vendor_id, "credit", `${usd(amt / 100, 2)}${b.reason ? ": " + str(b.reason, 200) : ""}`);
    if (b.notify === true) await sendEmail("credit.added", bk.customer_email, `${usd(amt / 100, 2)} credit added`, `Hi ${firstName(bk.customer_name)},

We added a ${usd(amt / 100, 2)} credit to your account. It comes off your next charges automatically.

${bookingLink(bk.ref, bk.access_token)}`);
    return { ok: true };
  }),
  release: guard(async (b) => {
    const bk = await loadBooking2(b.bookingId);
    await db().from("bookings").update({ vendor_id: null, status: "new", matched_at: null, respond_by: null, contacted_at: null, chosen_by_customer: false }).eq("id", bk.id).in("status", ["matched", "scheduled", "pending_card"]);
    await logEvent(bk.id, bk.vendor_id, "released", "by operator");
    return { ok: true };
  }),
  cancelPreview: guard(async (b) => ({ refund: await unusedPrepayCents(await loadBooking2(b.bookingId)) / 100 })),
  cancel: guard(async (b) => cancelBooking(id(b.bookingId), "operator", str(b.reason, 300))),
  logClaim: guard(async (b) => {
    const bk = await loadBooking2(b.bookingId);
    await db().from("claims").insert({ booking_id: bk.id, vendor_id: bk.vendor_id, description: str(b.description, 1e3) || "Logged by operator after a customer call" });
    await logEvent(bk.id, bk.vendor_id, "claim", "logged by operator");
    return { ok: true };
  }),
  claimStatus: guard(async (b) => {
    const status = String(b.status);
    if (!["open", "vendor_notified", "resolved"].includes(status)) throw new UserError("Unknown status.");
    await db().from("claims").update({ status, resolved_at: status === "resolved" ? (/* @__PURE__ */ new Date()).toISOString() : null }).eq("id", id(b.claimId));
    return { ok: true };
  }),
  hideReview: guard(async (b) => {
    await db().from("reviews").update({ hidden: b.hidden === true }).eq("id", id(b.reviewId));
    return { ok: true };
  }),
  saveSettings: guard(async (b) => {
    const s2 = await getSettings();
    const take = Number(b.takeRate), goal = Math.round(Number(b.goalPairs));
    const factors = (arr, base) => {
      if (!Array.isArray(arr) || arr.length !== base.length) throw new UserError("Check the factors.");
      return base.map((t, k) => {
        const m = Number(arr[k].mult);
        if (!(m >= 0.3 && m <= 3)) throw new UserError("Factors must be between 0.3 and 3.");
        return { label: t.label, mult: m };
      });
    };
    if (!(take >= 0 && take <= 0.5)) throw new UserError("Take rate must be between 0% and 50%.");
    if (!(goal >= 1)) throw new UserError("Enter a goal.");
    if (!validRateCard(b.suggested, s2.lots.length)) throw new UserError("Check the suggested prices.");
    const weeks = Math.round(Number(b.seasonWeeks ?? s2.season.weeks)), fertApps = Math.round(Number(b.fertApps ?? s2.fertApps));
    if (!(weeks >= 4 && weeks <= 52)) throw new UserError("Mowing season must be 4 to 52 weeks.");
    if (!(fertApps >= 1 && fertApps <= 12)) throw new UserError("Fertilizer program must be 1 to 12 applications.");
    const scales = Array.isArray(b.lotScales) && b.lotScales.length === s2.lots.length ? s2.lots.map((l, k) => {
      const m = Number(b.lotScales[k]);
      if (!(m >= 0.3 && m <= 20)) throw new UserError("Lot add-on scales must be between 0.3 and 20.");
      return { ...l, scale: m };
    }) : s2.lots;
    const e = b.extras ?? {};
    const extras = {
      referralCreditCents: Math.round(Number(e.referralCredit ?? s2.extras.referralCreditCents / 100) * 100),
      prepayDiscount: Number(e.prepayDiscount ?? s2.extras.prepayDiscount),
      respondHours: Math.round(Number(e.respondHours ?? s2.extras.respondHours)),
      reviewAfterVisits: Math.round(Number(e.reviewAfterVisits ?? s2.extras.reviewAfterVisits))
    };
    if (!(extras.referralCreditCents >= 0 && extras.referralCreditCents <= 1e4)) throw new UserError("Referral credit must be $0 to $100.");
    if (!(extras.prepayDiscount >= 0 && extras.prepayDiscount <= 0.2)) throw new UserError("Prepay discount must be 0% to 20%.");
    if (!(extras.respondHours >= 4 && extras.respondHours <= 72)) throw new UserError("Response window must be 4 to 72 business hours.");
    if (!(extras.reviewAfterVisits >= 1 && extras.reviewAfterVisits <= 6)) throw new UserError("Ask for reviews after 1 to 6 visits.");
    await db().from("settings").update({ take_rate: take, goal_pairs: goal, terrains: factors(b.terrains, s2.terrains), coverages: factors(b.coverages, s2.coverages), lots: scales, season: { ...s2.season, weeks }, fert_apps: fertApps, suggested: b.suggested, extras, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", 1);
    return { ok: true };
  })
});
