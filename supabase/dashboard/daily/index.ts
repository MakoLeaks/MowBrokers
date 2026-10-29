// @ts-nocheck
// MowBrokers Edge Function "daily" — single-file build of supabase/functions/daily + _shared for the Supabase dashboard editor.
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
var extrasOf = (s) => ({ ...DEFAULT_EXTRAS, ...s?.extras || {} });
var seasonOf = (s) => ({ ...DEFAULT_SETTINGS.season, ...s?.season || {} });
var fertAppsOf = (s) => +s?.fertApps || DEFAULT_SETTINGS.fertApps;
var roundTo = (x, r) => Math.round(x / r) * r;
var cents = (x) => Math.round(x * 100) / 100;
function tierIndex(s, acres) {
  let k = 0;
  s.lots.forEach((t, i) => {
    if ((+acres || 0) >= t.min) k = i;
  });
  return k;
}
function quote(s, rc, i) {
  const r = s.roundTo || 5;
  const ti = tierIndex(s, i.acres);
  const lot = s.lots[ti];
  const T = (s.terrains.find((t) => t.label === i.terrain) ?? s.terrains[0]).mult;
  const C = (s.coverages.find((t) => t.label === i.coverage) ?? s.coverages[0]).mult;
  const pick = (arr) => +arr?.[ti] || +arr?.[arr.length - 1] || 0;
  const q = roundTo(pick(rc.mowTiers) * T * C, r);
  const season = seasonOf(s), apps = fertAppsOf(s);
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
  const prepayDiscount = extrasOf(s).prepayDiscount;
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
    guideOnly: ti === s.lots.length - 1,
    takeRate: s.takeRate,
    prepay,
    prepayDiscount
  };
}
var bestMatchKey = (annual, score) => annual * (1.3 - 0.5 * ((score ?? 75) / 100));
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
function matchVendors(s, vendors, i, today = /* @__PURE__ */ new Date()) {
  const inZip = vendors.filter((v) => v.status === "approved" && (!(v.zips || []).length || v.zips.includes(i.zip)));
  const matches = [];
  let skipped = 0;
  for (const v of inZip) {
    if (!eligibility(v, i, today)) matches.push({ v, x: quote(
      s,
      /** @type {RateCard} */
      v.rate_card,
      i
    ) });
    else skipped++;
  }
  matches.sort((a, b) => a.x.annual - b.x.annual);
  return { matches, skipped, inZip: inZip.length };
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
var daysUntil = (d) => d ? Math.ceil(((/* @__PURE__ */ new Date(d + "T12:00:00")).getTime() - Date.now()) / 864e5) : 9999;

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
import Stripe from "npm:stripe@16.12.0";
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

// _shared/services.ts
var todayCT = () => (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
var addDays = (iso, n) => {
  const d = /* @__PURE__ */ new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
var specOf = (b) => ({ acres: b.yard.acres, zip: b.zip, terrain: b.yard.terrain, coverage: b.yard.coverage, plan: b.plan, fert: b.addons.fert, aerate: b.addons.aerate, leaves: b.addons.leaves, shrubs: b.addons.shrubs, custom: b.custom });
var firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";
async function loadVendor(id) {
  if (!id) return null;
  const { data } = await db().from("vendors").select("*").eq("id", id).maybeSingle();
  return data ?? null;
}
async function startResponseClock(b, vendorId) {
  const s = await getSettings();
  const by = addBusinessHours(/* @__PURE__ */ new Date(), extrasOf(s).respondHours).toISOString();
  await db().from("bookings").update({ respond_by: by, contacted_at: null }).eq("id", b.id);
  await logEvent(b.id, vendorId, "matched", `respond by ${by}`);
  return by;
}
async function rankedMatches(b, exclude = []) {
  const [s, { data: vendors }, { data: scores }] = await Promise.all([getSettings(), db().from("public_vendors").select("*"), db().rpc("vendor_scores")]);
  const scoreOf = Object.fromEntries((scores ?? []).map((r) => [r.vendor_id, r.score]));
  const { matches } = matchVendors(s, (vendors ?? []).filter((v) => !exclude.includes(v.id)), specOf(b));
  return matches.map((m) => ({ ...m, score: scoreOf[m.v.id] ?? null, key: bestMatchKey(m.x.annual, scoreOf[m.v.id]) })).sort((a, c) => a.key - c.key);
}
async function enforceResponseDeadlines() {
  const out = [];
  const { data } = await db().from("bookings").select("*").eq("status", "matched").is("contacted_at", null).not("respond_by", "is", null).lt("respond_by", (/* @__PURE__ */ new Date()).toISOString()).limit(50);
  for (const b of data ?? []) {
    const old = await loadVendor(b.vendor_id);
    await logEvent(b.id, b.vendor_id, "sla_miss", `no call logged by ${b.respond_by}`);
    const { data: misses } = await db().from("booking_events").select("vendor_id").eq("booking_id", b.id).eq("type", "sla_miss");
    const exclude = [...new Set((misses ?? []).map((m) => m.vendor_id).filter(Boolean))];
    const oldAnnual = b.quote?.annual ?? Infinity;
    const best = (await rankedMatches(b, exclude)).find((m) => m.x.annual <= oldAnnual + 0.5);
    if (old) await sendEmail("sla.released", old.email, `Booking reassigned — ${b.ref}`, `${b.customer_name} (${b.ref}) was waiting more than one business day for a call, so we've passed the booking to another pro. Logging a call (“I called them”) in your portal stops the clock next time.`);
    const bestV = best ? await loadVendor(best.v.id) : null;
    if (best && bestV) {
      const s = await getSettings();
      const nq = { ...best.x, takeRate: s.takeRate };
      const { data: up } = await db().from("bookings").update({ vendor_id: best.v.id, quote: nq, matched_at: (/* @__PURE__ */ new Date()).toISOString(), chosen_by_customer: false, nudged_at: null }).eq("id", b.id).select("*").single();
      await startResponseClock(up, best.v.id);
      await logEvent(b.id, best.v.id, "reassigned", `from ${old?.business ?? "—"}`);
      await sendEmail(
        "sla.reassigned",
        b.customer_email,
        `A faster pro for your yard — ${b.ref}`,
        `Hi ${firstName(b.customer_name)},

${old?.business ?? "Your pro"} didn't reach you within one business day, so we've matched you with ${best.v.business}, another vetted pro. Your season price is ${usd(nq.annual)}${nq.annual < oldAnnual ? ` (down from ${usd(oldAnnual)})` : ", the same as before"}. Nothing has been charged.

${best.v.business} will call ${b.customer_phone} to set your first visit. Rather choose someone else? Reply to this email.

Your account: ${bookingLink(b.ref, b.access_token)}`
      );
      await notifyNewJob(up, bestV, true);
      await notifyAdmin("sla.reassigned", `${b.ref} moved to ${best.v.business}`, `${old?.business ?? "Provider"} missed the one-business-day call window. Auto-reassigned at ${usd(nq.annual)} for the season.`);
      out.push(`reassigned ${b.ref} → ${best.v.business}`);
    } else {
      await db().from("bookings").update({ vendor_id: null, status: "new", respond_by: null, matched_at: null, chosen_by_customer: false }).eq("id", b.id);
      await logEvent(b.id, null, "released", `from ${old?.business ?? "—"}`);
      await sendEmail("sla.released", b.customer_email, `We're lining up another pro — ${b.ref}`, `Hi ${firstName(b.customer_name)},

${old?.business ?? "Your pro"} didn't reach you within one business day, so we're lining up another vetted pro. We'll confirm their price with you before anything changes. Nothing has been charged.

Your account: ${bookingLink(b.ref, b.access_token)}`);
      await notifyAdmin("sla.released", `${b.ref} needs a new pro`, `${old?.business ?? "Provider"} missed the call window and no other pro qualifies at the same price. Assign one in the console.`, `${b.ref} needs a new pro: ${old?.business ?? "provider"} missed the call window.`);
      out.push(`released ${b.ref}`);
    }
  }
  return out;
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

// daily/index.ts
var DAY = 864e5;
async function once(b, type, fn) {
  const { count } = await db().from("booking_events").select("id", { count: "exact", head: true }).eq("booking_id", b.id).eq("type", type);
  if (count) return false;
  await fn();
  await logEvent(b.id, b.vendor_id, type);
  return true;
}
var CAMPAIGNS = [
  { key: "fert", start: "02-15", addon: "fert", rate: null },
  { key: "aeration", start: "08-15", addon: "aerate", rate: "aeration" },
  { key: "leaves", start: "10-01", addon: "leaves", rate: "leafCleanup" }
];
Deno.serve(async (req) => {
  const given = req.headers.get("x-cron-secret") ?? "";
  const fromEnv = env.cronSecret() && given === env.cronSecret();
  const fromDb = given.length >= 32 && (await db().rpc("check_cron_secret", { p_secret: given })).data === true;
  if (!fromEnv && !fromDb) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  let task = "daily";
  try {
    task = (await req.json())?.task ?? "daily";
  } catch {
  }
  const out = [];
  out.push(...await enforceResponseDeadlines());
  if (task === "hourly") return new Response(JSON.stringify({ ok: true, task, actions: out }), { headers: { "Content-Type": "application/json" } });
  const now = Date.now(), today = todayCT();
  const { data: stale } = await db().from("bookings").select("*").eq("status", "matched").not("contacted_at", "is", null).lt("contacted_at", new Date(now - 2 * DAY).toISOString());
  for (const b of stale ?? []) {
    if (b.nudged_at && now - new Date(b.nudged_at).getTime() < DAY) continue;
    const { data: v } = await db().from("vendors").select("business,email,phone").eq("id", b.vendor_id).single();
    if (!v) continue;
    await sendSms("nudge.schedule", v.phone, `Reminder: ${b.customer_name} (${b.ref}) still needs a first visit date. Mark it scheduled in your portal.`);
    await sendEmail("nudge.schedule", v.email, `Reminder: schedule ${b.customer_name} (${b.ref})`, `You called ${b.customer_name} but haven't set a first visit yet: ${b.customer_phone}. Once you have a date, mark it scheduled in your portal: ${env.siteUrl()}/portal.html`);
    await db().from("bookings").update({ nudged_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", b.id);
    out.push(`schedule nudge ${b.ref}`);
  }
  const { data: unfinished } = await db().from("bookings").select("*").eq("status", "pending_card").is("nudged_at", null).lt("created_at", new Date(now - DAY).toISOString()).gt("created_at", new Date(now - 7 * DAY).toISOString());
  for (const b of unfinished ?? []) {
    await sendEmail("nudge.card", b.customer_email, `Finish booking your lawn pro — ${b.ref}`, `Hi ${firstName(b.customer_name)},

Your price is held, but your pro isn't notified until you save a card. You're charged only after each visit.

Finish here: ${bookingLink(b.ref, b.access_token)}&card=1`);
    await db().from("bookings").update({ nudged_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", b.id);
    out.push(`card reminder ${b.ref}`);
  }
  const { data: vendors } = await db().from("vendors").select("*").in("status", ["approved", "vetting", "applied"]);
  const vById = {};
  for (const v of vendors ?? []) {
    vById[v.id] = v;
    if (v.stripe_account_id && !v.stripe_charges_enabled) {
      try {
        if (await syncProviderStatus(v.stripe_account_id)) {
          v.stripe_charges_enabled = true;
          out.push(`payouts live ${v.business}`);
        }
      } catch (e) {
        console.error("sync", v.id, e);
      }
    }
    if (v.status !== "approved") continue;
    const d = daysUntil(v.insurance_expires);
    if (![30, 14, 3, 0].includes(d)) continue;
    await sendEmail("insurance.expiring", v.email, d > 0 ? `Your insurance expires ${fmtDate(v.insurance_expires)}` : "Your insurance expired today", `Hi ${v.contact},

${d > 0 ? `Your general liability policy on file expires in ${d} days.` : "Your policy on file has expired, so customers can't see you on MowBrokers."} Upload your renewed certificate and new expiration date in your portal: ${env.siteUrl()}/profile.html`);
    out.push(`insurance ${v.business} ${d}d`);
  }
  const { data: act } = await db().from("bookings").select("*").in("status", ["scheduled", "active"]).limit(5e3);
  const active = act ?? [];
  const s = await getSettings();
  const mmdd = today.slice(5), year = today.slice(0, 4);
  let offers = 0, overdue = 0;
  for (const b of active) {
    const v = b.vendor_id ? vById[b.vendor_id] : null;
    if (b.paused_until && b.paused_until < today) {
      await db().from("bookings").update({ paused_until: null }).eq("id", b.id);
      await logEvent(b.id, b.vendor_id, "resumed", "pause ended");
      if (v) await sendEmail("booking.resumed", v.email, `Service resumes — ${b.ref}`, `${b.customer_name}'s pause ended. Call ${b.customer_phone} to schedule the next visit.`);
      b.paused_until = null;
      out.push(`resumed ${b.ref}`);
    }
    if (b.paused_until || !v || b.plan === "One-time cut") continue;
    const due = b.next_visit_due;
    if (due === addDays(today, 7)) await once(b, `due_provider:${due}`, () => sendEmail("visit.due", v.email, `Visit due ${fmtDate(due)}: ${b.customer_name} (${b.ref})`, `${b.customer_name}'s next ${b.plan.toLowerCase()} visit is due around ${fmtDate(due)}. Call ${b.customer_phone} to schedule${b.visit_window !== "any" ? ` (prefers ${b.visit_window}s)` : ""}, then mark it in your portal: ${env.siteUrl()}/portal.html`));
    if (due === addDays(today, 5)) await once(b, `due_customer:${due}`, () => sendEmail("visit.due", b.customer_email, `Your next visit is coming up`, `Hi ${firstName(b.customer_name)},

Your next lawn care visit with ${v.business} is due around ${fmtDate(due)}. They'll reach out to schedule. Need to skip a visit? Pause from your account: ${bookingLink(b.ref, b.access_token)}`));
    if (due && due < addDays(today, -14)) {
      overdue++;
      await once(b, `overdue:${due}:${Math.floor(now / (7 * DAY))}`, () => sendEmail("visit.overdue", v.email, `Overdue visit: ${b.customer_name} (${b.ref})`, `${b.customer_name}'s visit was due ${fmtDate(due)} and hasn't been logged. Schedule it, or log it with “Visit done” in your portal if it already happened: ${env.siteUrl()}/portal.html`));
    }
    if (b.prepay && b.prepaid_through === addDays(today, 30)) await once(b, `prepay_renew:${b.prepaid_through}`, () => sendEmail("prepay.renewal", b.customer_email, "Your prepaid season ends in 30 days", `Hi ${firstName(b.customer_name)},

Your prepaid lawn care with ${v.business} runs through ${fmtDate(b.prepaid_through)}. Next season's prepay (${usd(b.quote?.prepay ?? 0)}, ${Math.round((b.quote?.prepayDiscount ?? 0.05) * 100)}% off) is charged at your first visit after that. Prefer to pay per visit? Switch anytime: ${bookingLink(b.ref, b.access_token)}`));
    if (b.marketing_opt_out || !b.customer_email || offers >= 150) continue;
    for (const c of CAMPAIGNS) {
      const end = /* @__PURE__ */ new Date(`${year}-${c.start}T12:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 21);
      if (mmdd < c.start || today > end.toISOString().slice(0, 10)) continue;
      if (b.addons[c.addon]) continue;
      if (c.rate ? v.rate_card?.addons?.[c.rate] == null : !v.rate_card?.fertTiers || !v.categories.includes("OTPS")) continue;
      const x = quote(s, v.rate_card, { ...specOf(b), fert: true, aerate: true, leaves: true });
      const link = bookingLink(b.ref, b.access_token);
      const off = `

Don't want seasonal offers? Turn them off: ${link}#prefs`;
      const msg = {
        fert: ["Add fertilizer and weed control this year", `${v.business} offers a ${s.fertApps}-application fertilizer and weed control program for your yard at ${usd(x.fertPerApp)} per application, billed after each application like your cuts.

Add it: ${link}#addons`],
        aeration: ["Core aeration for your lawn", `${v.business} offers core aeration for your yard for ${usd(x.aeration)}, once a year, billed after it's done.

Add it: ${link}#addons`],
        leaves: ["Fall leaf cleanup", `${v.business} offers a one-time fall leaf cleanup for your yard for ${usd(x.leaves)}, billed after it's done.

Add it: ${link}#addons`]
      }[c.key];
      const sent = await once(b, `offer:${c.key}:${year}`, () => sendEmail(`offer.${c.key}`, b.customer_email, msg[0], `Hi ${firstName(b.customer_name)},

${msg[1]}${off}`));
      if (sent) {
        offers++;
        break;
      }
    }
  }
  if (offers) out.push(`seasonal offers ${offers}`);
  const [{ count: unmatched }, { count: open }, { count: applicants }, { count: misses }] = await Promise.all([
    db().from("bookings").select("id", { count: "exact", head: true }).eq("status", "new"),
    db().from("claims").select("id", { count: "exact", head: true }).eq("status", "open"),
    db().from("vendors").select("id", { count: "exact", head: true }).in("status", ["applied", "vetting"]),
    db().from("booking_events").select("id", { count: "exact", head: true }).eq("type", "sla_miss").gte("created_at", new Date(now - DAY).toISOString())
  ]);
  if ((unmatched ?? 0) + (open ?? 0) + (applicants ?? 0) + overdue + out.length > 0)
    await notifyAdmin("digest", "Morning digest", `Needs manual match: ${unmatched ?? 0}
Open re-service requests: ${open ?? 0}
Providers in vetting: ${applicants ?? 0}
Visits overdue 2+ weeks: ${overdue}
Missed call deadlines (24h): ${misses ?? 0}

Automated today:
${out.join("\n") || "nothing"}

${env.siteUrl()}/admin.html`);
  return new Response(JSON.stringify({ ok: true, task, actions: out }), { headers: { "Content-Type": "application/json" } });
});
