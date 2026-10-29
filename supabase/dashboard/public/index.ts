// @ts-nocheck
// MowBrokers Edge Function "public" — single-file build of supabase/functions/public + _shared for the Supabase dashboard editor.
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
var CUSTOM_JOBS = ["Sod installation", "Irrigation repair", "Tree and stump removal", "Drainage and grading", "Landscape bed install", "Overgrown yard cleanup"];
var JOB_CATEGORY = { "Tree and stump removal": "TS", "Landscape bed install": "SLP" };
var PLANS = ["Weekly", "Every two weeks", "One-time cut", "No mowing"];
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
function addBusinessHours(from, hours = 24) {
  const d = new Date(from instanceof Date ? from.getTime() : from);
  d.setTime(d.getTime() + hours * 36e5);
  const dow = () => new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" })).getDay();
  while (dow() === 0 || dow() === 6) d.setTime(d.getTime() + 864e5);
  return d;
}
function withAddons(s2, rc, locked, spec, addons) {
  const next = { ...spec, fert: !!addons.fert, aerate: !!addons.aerate, leaves: !!addons.leaves, shrubs: +addons.shrubs || 0 };
  const q2 = quote(s2, rc, next);
  const m = { ...locked, fertPerApp: q2.fertPerApp, fertApps: q2.fertApps, fert: q2.fert, bundle: q2.bundle, fertVisit: q2.fertVisit, aeration: q2.aeration, leaves: q2.leaves, shrubs: q2.shrubs, shrubVisit: q2.shrubVisit };
  m.annual = m.mowing + m.fert + m.bundle + m.aeration + m.leaves + m.shrubs;
  m.monthly = m.annual / 12;
  m.prepayDiscount = locked.prepayDiscount ?? extrasOf(s2).prepayDiscount;
  m.prepay = spec.plan === "One-time cut" ? 0 : Math.round(m.annual * (1 - m.prepayDiscount));
  return m;
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
function parseSpec(get) {
  const g = (k) => (typeof get === "function" ? get(k) : get[k]) ?? "";
  const acres = Math.round(Number(g("acres")) * 100) / 100;
  const zip = String(g("zip")).trim();
  const plan = String(g("plan"));
  const shrubs = Number(g("shrubs") || 0);
  const custom = String(g("custom") || "").split(",").map((c) => c.trim()).filter(Boolean);
  if (!(acres >= 0.05 && acres <= 100) || !/^\d{5}$/.test(zip) || !PLANS.includes(plan) || !(shrubs >= 0 && shrubs <= 3 && Number.isInteger(shrubs))) return null;
  if (custom.some((c) => !CUSTOM_JOBS.includes(c))) return null;
  const terrain = String(g("terrain")).slice(0, 60), coverage = String(g("coverage")).slice(0, 60);
  if (!terrain || !coverage) return null;
  const b = (k) => g(k) === "1" || g(k) === true;
  const spec = { acres, zip, terrain, coverage, plan, fert: b("fert"), aerate: b("aerate"), leaves: b("leaves"), shrubs, custom };
  if (plan === "No mowing" && !spec.fert && !spec.aerate && !spec.leaves && !spec.shrubs) return null;
  return spec;
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
var ALPHA = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
var rand = (n) => crypto.getRandomValues(new Uint8Array(n));
var refCode = () => "MB-" + Array.from(rand(6)).map((x) => ALPHA[x % ALPHA.length]).join("");
var token = () => btoa(String.fromCharCode(...rand(24))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
async function ensureCustomer(b) {
  if (b.stripe_customer_id) return b.stripe_customer_id;
  const c = await stripe().customers.create({ name: b.customer_name, phone: b.customer_phone, email: b.customer_email || void 0, metadata: { booking_id: b.id, ref: b.ref } });
  await db().from("bookings").update({ stripe_customer_id: c.id }).eq("id", b.id);
  return c.id;
}

// _shared/services.ts
var todayCT = () => (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
var addDays = (iso, n) => {
  const d = /* @__PURE__ */ new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
var specOf = (b) => ({ acres: b.yard.acres, zip: b.zip, terrain: b.yard.terrain, coverage: b.yard.coverage, plan: b.plan, fert: b.addons.fert, aerate: b.addons.aerate, leaves: b.addons.leaves, shrubs: b.addons.shrubs, custom: b.custom });
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

// public/index.ts
var PUBLIC_COLS = "id,slug,status,business,years,techs,categories,zips,insurance_expires,rate_card,custom_jobs,stripe_charges_enabled";
async function bookingByToken(ref, tok) {
  const { data } = await db().from("bookings").select("*").eq("ref", str(ref, 20).toUpperCase()).maybeSingle();
  const t = String(tok ?? "");
  if (!data || typeof data.access_token !== "string" || data.access_token.length !== t.length) throw new UserError("Booking not found.");
  let diff = 0;
  for (let i = 0; i < t.length; i++) diff |= t.charCodeAt(i) ^ data.access_token.charCodeAt(i);
  if (diff) throw new UserError("Booking not found.");
  return data;
}
var vendorOf = async (b) => b.vendor_id ? (await db().from("vendors").select("*").eq("id", b.vendor_id).maybeSingle()).data : null;
var referralCode = (name) => (String(name).replace(/[^A-Za-z]/g, "").toUpperCase() + "LAWNS").slice(0, 5) + Array.from(crypto.getRandomValues(new Uint8Array(4))).map((x) => "23456789ABCDEFGHJKMNPQRSTUVWXYZ"[x % 31]).join("");
var norm = (s2) => String(s2 ?? "").trim().toLowerCase();
async function openClaim(b, description) {
  if (description.length < 5) throw new UserError("Tell us what was missed or what's back.");
  if (!b.vendor_id || !["scheduled", "active", "completed"].includes(b.status)) throw new UserError("Re-service opens once your first visit is scheduled.");
  const { count } = await db().from("claims").select("id", { count: "exact", head: true }).eq("booking_id", b.id).neq("status", "resolved");
  if ((count ?? 0) > 0) throw new UserError("You already have an open re-service request. Your pro will call you.");
  await db().from("claims").insert({ booking_id: b.id, vendor_id: b.vendor_id, description });
  const { data: v } = await db().from("vendors").select("business,email,phone").eq("id", b.vendor_id).single();
  if (v) {
    await sendEmail("claim.created", v.email, `Free re-service requested: ${b.ref}`, `${b.customer_name} (${b.customer_phone}, ${b.street} ${b.zip}) reports: "${description}"

Under the MowBrokers re-service guarantee, coming back for a missed or poor cut, or for weeds that return between treatment visits, is free. Go back within two business days.`);
    await sendSms("claim.created", v.phone, `Re-service requested by ${b.customer_name} (${b.ref}). Go back within 2 business days.`);
  }
  await logEvent(b.id, b.vendor_id, "claim", description);
  await notifyAdmin("claim.created", `Re-service on ${b.ref}`, description);
  return { ok: true };
}
serveActions({
  async createBooking(body) {
    if (str(body.website, 100)) throw new UserError("Check the form and try again.");
    const spec = parseSpec(body.spec ?? {});
    if (!spec) throw new UserError("Your yard details are incomplete. Go back and check them.");
    const name = str(body.name, 120), email = str(body.email, 200), street = str(body.street, 200), phone = toE164(body.phone);
    if (name.length < 2) throw new UserError("Enter your full name.");
    if (!phone) throw new UserError("Enter a 10-digit US mobile number.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("Enter a valid email so we can send your receipt.");
    if (street.length < 4) throw new UserError("Enter your street address.");
    const preferred = isDate(body.preferredStart) && String(body.preferredStart) >= todayCT() ? String(body.preferredStart) : null;
    const alt = isDate(body.preferredAlt) && String(body.preferredAlt) >= todayCT() ? String(body.preferredAlt) : null;
    const window = ["morning", "afternoon"].includes(String(body.visitWindow)) ? String(body.visitWindow) : "any";
    const s2 = await getSettings();
    let vendorId = null, q = null;
    if (body.vendorSlug) {
      const { data: v } = await db().from("vendors").select(PUBLIC_COLS).eq("slug", str(body.vendorSlug, 80)).maybeSingle();
      if (!v) throw new UserError("That pro isn't available. Go back and choose another.");
      if (eligibility(v, spec)) throw new UserError("That pro can no longer take this request. Go back and choose another.");
      q = { ...quote(s2, v.rate_card, spec), takeRate: s2.takeRate };
      vendorId = v.id;
    }
    let referredBy = null, credit = 0, referrer = null;
    const code = str(body.referralCode, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code) {
      const { data: rb } = await db().from("bookings").select("*").eq("referral_code", code).maybeSingle();
      const r = rb;
      if (r && norm(r.customer_email) !== norm(email) && toE164(r.customer_phone) !== phone && norm(r.street) !== norm(street) && r.status !== "pending_card") {
        referredBy = code;
        credit = extrasOf(s2).referralCreditCents;
        referrer = r;
      }
    }
    const row = {
      ref: refCode(),
      access_token: token(),
      status: vendorId ? "pending_card" : "new",
      chosen_by_customer: !!vendorId,
      customer_name: name,
      customer_phone: phone,
      customer_email: email,
      sms_consent: body.smsConsent === true,
      street,
      zip: spec.zip,
      yard: { acres: spec.acres, terrain: spec.terrain, coverage: spec.coverage },
      plan: spec.plan,
      addons: { fert: spec.fert, aerate: spec.aerate, leaves: spec.leaves, shrubs: spec.shrubs },
      custom: spec.custom,
      notes: str(body.notes, 1e3),
      preferred_start: preferred,
      preferred_alt: alt,
      visit_window: window,
      vendor_id: vendorId,
      quote: q,
      prepay: body.prepay === true && spec.plan !== "One-time cut",
      credit_cents: credit,
      referred_by: referredBy,
      referral_code: referralCode(name)
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, error } = await db().from("bookings").insert(row).select("*").single();
      if (!error) {
        if (referrer) await db().from("referrals").insert({ code: referredBy, referrer_booking_id: referrer.id, referee_booking_id: data.id });
        await logEvent(data.id, vendorId, "created", vendorId ? "customer chose provider" : "request");
        if (!vendorId) await announceBooking(data);
        return { ref: data.ref, token: data.access_token, needsCard: !!vendorId, credit: credit / 100 };
      }
      if (error.code === "23505") {
        row.ref = refCode();
        row.referral_code = referralCode(name);
        continue;
      }
      throw error;
    }
    throw new Error("Could not create booking");
  },
  async checkReferral(body) {
    const code = str(body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) return { valid: false };
    const { data } = await db().from("bookings").select("customer_name,status").eq("referral_code", code).maybeSingle();
    const s2 = await getSettings();
    return data && data.status !== "pending_card" ? { valid: true, from: firstName(data.customer_name), credit: extrasOf(s2).referralCreditCents / 100 } : { valid: false };
  },
  async setupIntent(body) {
    const b = await bookingByToken(body.ref, body.token);
    if (["cancelled", "completed"].includes(b.status)) throw new UserError("This booking is closed.");
    const customer = await ensureCustomer(b);
    const si = await stripe().setupIntents.create({ customer, usage: "off_session", automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { booking_id: b.id, ref: b.ref } });
    return { clientSecret: si.client_secret };
  },
  async confirmCard(body) {
    const b = await bookingByToken(body.ref, body.token);
    const si = await stripe().setupIntents.retrieve(str(body.setupIntentId, 100));
    if (si.metadata?.booking_id !== b.id) throw new UserError("That card setup doesn't belong to this booking.");
    const up = await attachCardFromSetupIntent(si);
    if (!up) throw new UserError("Your card wasn't confirmed. Try again.");
    return { status: up.status };
  },
  async claimByToken(body) {
    return openClaim(await bookingByToken(body.ref, body.token), str(body.description, 1e3));
  },
  async claimByPhone(body) {
    if (str(body.website, 100)) throw new UserError("Check the form and try again.");
    const ref = str(body.ref, 20).toUpperCase();
    if (!/^MB-[A-Z0-9]{4,8}$/.test(ref)) throw new UserError("Enter your reference code, like MB-7K2Q9X.");
    const { data } = await db().from("bookings").select("*").eq("ref", ref).maybeSingle();
    const want = String(data?.customer_phone ?? "").replace(/\D/g, "").slice(-10), got = String(body.phone ?? "").replace(/\D/g, "").slice(-10);
    if (!data || want.length !== 10 || want !== got) throw new UserError("We couldn't find a booking with that code and phone number.");
    return openClaim(data, str(body.description, 1e3));
  },
  // ---------- customer account (booking page) ----------
  async sendBookingLinks(body) {
    if (str(body.website, 100)) return { ok: true };
    const email = norm(str(body.email, 200));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("Enter the email you booked with.");
    const since = new Date(Date.now() - 10 * 6e4).toISOString();
    const { count } = await db().from("notifications").select("id", { count: "exact", head: true }).eq("event", "account.links").eq("recipient", email).gte("created_at", since);
    if (count) return { ok: true };
    const { data } = await db().from("bookings").select("*").ilike("customer_email", email).neq("status", "pending_card").order("created_at", { ascending: false }).limit(20);
    const rows = data ?? [];
    if (!rows.length) return { ok: true };
    const vendors = Object.fromEntries(((await db().from("vendors").select("id,business").in("id", rows.map((r) => r.vendor_id).filter(Boolean))).data ?? []).map((v) => [v.id, v.business]));
    await sendEmail("account.links", email, "Your MowBrokers bookings", `Hi ${firstName(rows[0].customer_name)},

Here are the private links to your bookings. Each one shows visit reports, receipts and lets you request a free re-service, pause or cancel.

${rows.map((r) => `${r.ref} · ${r.street} · ${r.plan} · ${r.vendor_id ? vendors[r.vendor_id] ?? "" : "matching"} · ${r.status}
${bookingLink(r.ref, r.access_token)}`).join("\n\n")}

Didn't ask for this? You can ignore it.`);
    return { ok: true };
  },
  async visitPhotoUrl(body) {
    const b = await bookingByToken(body.ref, body.token);
    const { data } = await db().from("visits").select("photo_path").eq("id", str(body.visitId, 60)).eq("booking_id", b.id).maybeSingle();
    if (!data?.photo_path) throw new UserError("No photo for this visit.");
    const { data: u } = await db().storage.from("visit-photos").createSignedUrl(data.photo_path, 3600);
    if (!u) throw new UserError("Couldn't open the photo.");
    return { url: u.signedUrl };
  },
  async submitReview(body) {
    const b = await bookingByToken(body.ref, body.token);
    if (!b.vendor_id) throw new UserError("There's no pro to review yet.");
    const { count } = await db().from("visits").select("id", { count: "exact", head: true }).eq("booking_id", b.id);
    if (!count) throw new UserError("You can review your pro after your first visit.");
    const rating = Math.round(Number(body.rating));
    if (!(rating >= 1 && rating <= 5)) throw new UserError("Choose 1 to 5 stars.");
    const comment = str(body.comment, 1e3);
    const parts = b.customer_name.trim().split(/\s+/);
    const label = `${parts[0]}${parts.length > 1 ? " " + parts[parts.length - 1][0].toUpperCase() + "." : ""}`;
    const { data: prev } = await db().from("reviews").select("id,created_at").eq("booking_id", b.id).maybeSingle();
    if (prev && Date.now() - new Date(prev.created_at).getTime() > 90 * 864e5) throw new UserError("Reviews can be edited for 90 days.");
    await db().from("reviews").upsert({ booking_id: b.id, vendor_id: b.vendor_id, rating, comment, customer_label: label, updated_at: (/* @__PURE__ */ new Date()).toISOString() }, { onConflict: "booking_id" });
    await logEvent(b.id, b.vendor_id, "review", `${rating}★`);
    if (rating <= 2) await notifyAdmin("review.low", `${rating}-star review on ${b.ref}`, `${b.customer_name}: "${comment}"
Call the customer and the provider.`, `${rating}-star review on ${b.ref}. Check the console.`);
    return { ok: true, edited: !!prev };
  },
  async pause(body) {
    const b = await bookingByToken(body.ref, body.token);
    if (!["scheduled", "active"].includes(b.status) || b.plan === "One-time cut") throw new UserError("Only active plans can be paused.");
    const until = String(body.until ?? "");
    if (!isDate(until) || until < addDays(todayCT(), 7) || until > addDays(todayCT(), 120)) throw new UserError("Choose a date between 1 week and 4 months from today.");
    await db().from("bookings").update({ paused_until: until }).eq("id", b.id);
    await logEvent(b.id, b.vendor_id, "paused", `until ${until}`);
    const v = await vendorOf(b);
    if (v) await sendEmail("booking.paused", v.email, `Paused until ${fmtDate(until)} — ${b.ref}`, `${b.customer_name} (${b.ref}) paused service until ${fmtDate(until)}. Don't schedule visits before then; we'll remind you when it resumes.`);
    await sendEmail("booking.paused", b.customer_email, `Service paused until ${fmtDate(until)}`, `Hi ${firstName(b.customer_name)},

Your service is paused until ${fmtDate(until)}. Nothing is charged while paused. Resume anytime: ${bookingLink(b.ref, b.access_token)}`);
    return { ok: true };
  },
  async resume(body) {
    const b = await bookingByToken(body.ref, body.token);
    if (!b.paused_until) return { ok: true };
    await db().from("bookings").update({ paused_until: null }).eq("id", b.id);
    await logEvent(b.id, b.vendor_id, "resumed");
    const v = await vendorOf(b);
    if (v) await sendEmail("booking.resumed", v.email, `Service resumed — ${b.ref}`, `${b.customer_name} (${b.ref}) resumed service. Call ${b.customer_phone} to schedule the next visit.`);
    return { ok: true };
  },
  async cancel(body) {
    const b = await bookingByToken(body.ref, body.token);
    const reason = str(body.reason, 300);
    if (!reason) throw new UserError("Tell us why you're cancelling. It helps us improve.");
    return cancelBooking(b.id, "customer", reason);
  },
  async cancelPreview(body) {
    const b = await bookingByToken(body.ref, body.token);
    return { refund: await unusedPrepayCents(b) / 100 };
  },
  async setPrepay(body) {
    const b = await bookingByToken(body.ref, body.token);
    if (b.plan === "One-time cut") throw new UserError("Season prepay is for recurring plans.");
    if (["cancelled", "completed"].includes(b.status)) throw new UserError("This booking is closed.");
    const on = body.on === true;
    if (!on && b.prepay_payment_id && b.prepaid_through && b.prepaid_through > todayCT()) {
      await db().from("bookings").update({ prepay: false }).eq("id", b.id);
      return { ok: true, note: `Your current prepaid year runs through ${fmtDate(b.prepaid_through)}. After that you'll pay per visit.` };
    }
    await db().from("bookings").update({ prepay: on }).eq("id", b.id);
    await logEvent(b.id, b.vendor_id, on ? "prepay_on" : "prepay_off");
    return { ok: true };
  },
  async addAddon(body) {
    const b = await bookingByToken(body.ref, body.token);
    if (!["matched", "scheduled", "active"].includes(b.status) || !b.quote) throw new UserError("Add-ons can be added to active bookings.");
    const key = String(body.addon);
    if (!["fert", "aerate", "leaves", "shrubs"].includes(key)) throw new UserError("Unknown add-on.");
    const v = await vendorOf(b);
    if (!v) throw new UserError("Your pro isn't available right now.");
    if (key === "fert") {
      if (!v.rate_card?.fertTiers || !v.categories.includes("OTPS")) throw new UserError(`${v.business} doesn't offer fertilizer and weed control.`);
    } else {
      const map = { aerate: "aeration", leaves: "leafCleanup", shrubs: "shrubTrim" };
      if (v.rate_card?.addons?.[map[key]] == null) throw new UserError(`${v.business} doesn't offer that service.`);
    }
    const addons = { ...b.addons };
    if (key === "shrubs") addons.shrubs = Math.min(3, Math.max(1, Math.round(Number(body.count) || 1)));
    else addons[key] = true;
    const s2 = await getSettings();
    const nq = { ...withAddons(s2, v.rate_card, b.quote, specOf(b), addons), takeRate: b.quote.takeRate };
    await db().from("bookings").update({ addons, quote: nq }).eq("id", b.id);
    const label = { fert: `Fertilizer and weed control (${s2.fertApps} applications)`, aerate: "Core aeration", leaves: "Fall leaf cleanup", shrubs: `Shrub trimming ×${addons.shrubs}` }[key];
    await logEvent(b.id, v.id, "addon", label);
    await sendEmail("booking.addon", v.email, `Add-on: ${label} — ${b.ref}`, `${b.customer_name} (${b.ref}) added ${label} at your posted price. It now shows in the visit form in your portal.`);
    await sendEmail("booking.addon", b.customer_email, `${label} added`, `Hi ${firstName(b.customer_name)},

You added ${label} with ${v.business}. Your plan is now ${usd(nq.annual)} a year${b.prepay_payment_id ? " (the add-on is billed per visit this season, outside your prepay)" : ""}, charged after each service.

Your account: ${bookingLink(b.ref, b.access_token)}`);
    return { ok: true, quote: nq };
  },
  async requestInspection(body) {
    const b = await bookingByToken(body.ref, body.token);
    const job = str(body.job, 60);
    if (!CUSTOM_JOBS.includes(job)) throw new UserError("Choose a service.");
    const v = await vendorOf(b);
    if (!v) throw new UserError("Your pro isn't available right now.");
    const need2 = JOB_CATEGORY[job];
    if (!(v.custom_jobs || []).includes(job) || need2 && !v.categories.includes(need2)) throw new UserError(`${v.business} doesn't take that job.`);
    const note = str(body.note, 500);
    await logEvent(b.id, v.id, "inspection_request", job);
    await sendEmail("inspection.request", v.email, `Inspection request: ${job} — ${b.ref}`, `${b.customer_name} (${b.customer_phone}, ${b.street} ${b.zip}) asked for a ${job.toLowerCase()} inspection and quote.${note ? `

They say: ${note}` : ""}

Call them to set it up.`);
    await notifyAdmin("inspection.request", `${job} inspection on ${b.ref}`, `${b.customer_name} → ${v.business}`);
    return { ok: true };
  },
  async unsubscribe(body) {
    const b = await bookingByToken(body.ref, body.token);
    await db().from("bookings").update({ marketing_opt_out: body.on !== false }).eq("id", b.id);
    return { ok: true };
  }
});
