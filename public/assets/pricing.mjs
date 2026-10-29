// MowBrokers pricing and matching engine.
// ONE source of truth: this file. scripts/sync-pricing.sh copies it to public/assets/pricing.mjs for the browser.
// Pure functions, no imports. Unit-tested in tests/pricing.test.mjs.
// A provider's posted rate card (price per weekly cut by lot size, treatment and add-on prices)
// × MowBrokers' standard terrain and coverage factors = the customer's price.

/** @typedef {"Weekly"|"Every two weeks"|"One-time cut"|"No mowing"} Plan */
/** @typedef {{label:string,min:number,scale:number}} Lot */
/** @typedef {{label:string,mult:number}} Factor */
/** @typedef {{aeration:number|null,leafCleanup:number|null,shrubTrim:number|null}} Addons */
/** @typedef {{mowTiers:number[],biweeklyPremium:number,oneTimeMult:number,fertTiers:number[]|null,bundleDiscount:number,addons:Addons}} RateCard */
/** @typedef {{referralCreditCents:number,prepayDiscount:number,respondHours:number,reviewAfterVisits:number}} Extras */
/** @typedef {{weeks:number,label:string}} Season */
/** @typedef {{takeRate:number,roundTo:number,goalPairs:number,season:Season,fertApps:number,lots:Lot[],terrains:Factor[],coverages:Factor[],suggested:RateCard,extras?:Extras}} Settings */
/** @typedef {{acres:number,zip:string,terrain:string,coverage:string,plan:Plan,fert:boolean,aerate:boolean,leaves:boolean,shrubs:number,custom:string[]}} Spec */
/** @typedef {{tier:string,q:number,perVisit:number,visits:number,mowing:number,fertPerApp:number,fertApps:number,fert:number,bundle:number,fertVisit:number,aeration:number,leaves:number,shrubs:number,shrubVisit:number,annual:number,monthly:number,guideOnly:boolean,takeRate:number,prepay?:number,prepayDiscount?:number}} Quote */
/** @typedef {{id:string,status:string,categories:string[],zips:string[],insurance_expires:string|null,rate_card:RateCard|null,custom_jobs:string[],stripe_charges_enabled?:boolean}} MatchableVendor */

export const ADDONS = [
  { key: "aeration", label: "Core aeration", unit: "once a year", scaled: true },
  { key: "leafCleanup", label: "Fall leaf cleanup", unit: "once", scaled: true },
  { key: "shrubTrim", label: "Shrub trimming", unit: "per visit", scaled: false }
];
export const CUSTOM_JOBS = ["Sod installation", "Irrigation repair", "Tree and stump removal", "Drainage and grading", "Landscape bed install", "Overgrown yard cleanup"];
/** Inspection jobs that need an ADAI horticulture category. */
export const JOB_CATEGORY = { "Tree and stump removal": "TS", "Landscape bed install": "SLP" };
export const PLANS = ["Weekly", "Every two weeks", "One-time cut", "No mowing"];
export const RECURRING_MOW = ["Weekly", "Every two weeks"];

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  takeRate: 0.12, roundTo: 5, goalPairs: 500,
  season: { weeks: 30, label: "April–October" },
  fertApps: 6,
  lots: [
    { label: "Under ¼ acre", min: 0, scale: 1.0 }, { label: "¼–½ acre", min: 0.25, scale: 1.6 }, { label: "½–1 acre", min: 0.5, scale: 2.6 },
    { label: "1–2 acres", min: 1, scale: 4.0 }, { label: "Over 2 acres", min: 2, scale: 6.0 }
  ],
  terrains: [{ label: "Flat and open", mult: 1.0 }, { label: "Some slopes or obstacles", mult: 1.15 }, { label: "Steep or heavily landscaped", mult: 1.3 }],
  coverages: [{ label: "Front and back", mult: 1.0 }, { label: "Front yard only", mult: 0.6 }, { label: "Back yard only", mult: 0.55 }],
  suggested: { mowTiers: [45, 55, 70, 95, 130], biweeklyPremium: 0.15, oneTimeMult: 1.5, fertTiers: [55, 70, 95, 135, 190], bundleDiscount: 0.1, addons: { aeration: 95, leafCleanup: 175, shrubTrim: 85 } },
  extras: { referralCreditCents: 2500, prepayDiscount: 0.05, respondHours: 24, reviewAfterVisits: 2 }
};
export const DEFAULT_EXTRAS = DEFAULT_SETTINGS.extras;
/** @param {{extras?:Partial<Extras>}|null|undefined} s @returns {Extras} */
export const extrasOf = (s) => ({ ...DEFAULT_EXTRAS, ...(s?.extras || {}) });
const seasonOf = (s) => ({ ...DEFAULT_SETTINGS.season, ...(s?.season || {}) });
const fertAppsOf = (s) => +s?.fertApps || DEFAULT_SETTINGS.fertApps;

const roundTo = (x, r) => Math.round(x / r) * r;
const cents = (x) => Math.round(x * 100) / 100;

/** @param {Settings} s @param {number} acres */
export function tierIndex(s, acres) {
  let k = 0;
  s.lots.forEach((t, i) => { if ((+acres || 0) >= t.min) k = i; });
  return k;
}

/** @param {Settings} s @param {RateCard} rc @param {Spec} i @returns {Quote} */
export function quote(s, rc, i) {
  const r = s.roundTo || 5;
  const ti = tierIndex(s, i.acres);
  const lot = s.lots[ti];
  const T = (s.terrains.find((t) => t.label === i.terrain) ?? s.terrains[0]).mult;
  const C = (s.coverages.find((t) => t.label === i.coverage) ?? s.coverages[0]).mult;
  const pick = (arr) => +arr?.[ti] || +arr?.[arr.length - 1] || 0;
  const q = roundTo(pick(rc.mowTiers) * T * C, r);
  const season = seasonOf(s), apps = fertAppsOf(s);
  let perVisit = 0, visits = 0;
  if (i.plan === "Weekly") { perVisit = q; visits = season.weeks; }
  else if (i.plan === "Every two weeks") { perVisit = roundTo(q * (1 + (+rc.biweeklyPremium || 0)), r); visits = Math.round(season.weeks / 2); }
  else if (i.plan === "One-time cut") { perVisit = roundTo(q * (+rc.oneTimeMult || 1.5), r); visits = 1; }
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
  return { tier: lot.label, q, perVisit, visits, mowing, fertPerApp, fertApps: i.fert ? apps : 0, fert, bundle, fertVisit: i.fert ? cents((fert + bundle) / apps) : 0,
    aeration, leaves, shrubs, shrubVisit, annual, monthly: annual / 12, guideOnly: ti === s.lots.length - 1, takeRate: s.takeRate, prepay, prepayDiscount };
}

// ---------- itemized billing: what a provider can mark done on a visit ----------
export const ITEMS = [
  { key: "visit", label: "Mowing visit" },
  { key: "fert", label: "Fertilizer and weed control application" },
  { key: "aeration", label: "Core aeration" },
  { key: "leaves", label: "Fall leaf cleanup" },
  { key: "shrubs", label: "Shrub trimming" }
];
export const itemLabel = (k, plan) => k === "visit" ? (plan === "Weekly" ? "Weekly cut" : plan === "Every two weeks" ? "Every-two-weeks cut" : plan === "One-time cut" ? "One-time cut" : "Mowing visit") : (ITEMS.find((i) => i.key === k)?.label ?? k);

/** Price of one item at the booking's locked price. @param {Quote} x */
export function itemAmount(x, kind) {
  if (kind === "visit") return x.perVisit;
  if (kind === "fert") return x.fertVisit ?? x.fertPerApp;
  if (kind === "aeration") return x.aeration;
  if (kind === "leaves") return x.leaves;
  if (kind === "shrubs") return x.shrubVisit;
  return 0;
}

/** How many of each item a service year (season) includes. */
export function itemLimits(plan, x, addons = {}) {
  return { visit: x.visits || 0, fert: addons.fert ? (x.fertApps || DEFAULT_SETTINGS.fertApps) : 0, aeration: addons.aerate ? 1 : 0, leaves: addons.leaves ? 1 : 0, shrubs: +addons.shrubs || 0 };
}

/** Days until the next regular visit is due after one is done. */
export const visitIntervalDays = (plan) => plan === "Weekly" ? 7 : plan === "Every two weeks" ? 14 : plan === "No mowing" ? 35 : null;

/** Referral and goodwill credits come out of MowBrokers' fee, so the provider's share never changes. */
export function applyCredit(amount_cents, fee_cents, credit_cents) {
  const discount_cents = Math.max(0, Math.min(credit_cents || 0, fee_cents, amount_cents - 50));
  return { charge_cents: amount_cents - discount_cents, fee_cents: fee_cents - discount_cents, discount_cents };
}

/** Provider's payout for an item covered by a season prepay (discount shared proportionally). */
export function prepaidPayout(amountDollars, prepayDiscount, takeRate) {
  const gross = Math.round(amountDollars * (1 - prepayDiscount) * 100);
  const fee = Math.round(gross * takeRate);
  return { amount_cents: gross, fee_cents: fee, net_cents: gross - fee };
}

/** Lower is better: price nudged by the provider's 0–100 score (rating, response, reliability, re-service). */
export const bestMatchKey = (annual, score) => annual * (1.3 - 0.5 * ((score ?? 75) / 100));

/** One business day later (weekends skipped, America/Chicago calendar). */
export function addBusinessHours(from, hours = 24) {
  const d = new Date(from instanceof Date ? from.getTime() : from);
  d.setTime(d.getTime() + hours * 3600000);
  const dow = () => new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" })).getDay();
  while (dow() === 0 || dow() === 6) d.setTime(d.getTime() + 86400000);
  return d;
}

/** Re-price a booking after adding add-ons: the locked mowing price stays, add-ons use the pro's current rate card. */
export function withAddons(s, rc, locked, spec, addons) {
  const next = { ...spec, fert: !!addons.fert, aerate: !!addons.aerate, leaves: !!addons.leaves, shrubs: +addons.shrubs || 0 };
  const q2 = quote(s, rc, next);
  const m = { ...locked, fertPerApp: q2.fertPerApp, fertApps: q2.fertApps, fert: q2.fert, bundle: q2.bundle, fertVisit: q2.fertVisit, aeration: q2.aeration, leaves: q2.leaves, shrubs: q2.shrubs, shrubVisit: q2.shrubVisit };
  m.annual = m.mowing + m.fert + m.bundle + m.aeration + m.leaves + m.shrubs;
  m.monthly = m.annual / 12;
  m.prepayDiscount = locked.prepayDiscount ?? extrasOf(s).prepayDiscount;
  m.prepay = spec.plan === "One-time cut" ? 0 : Math.round(m.annual * (1 - m.prepayDiscount));
  return m;
}

/** @param {{plan:Plan}} i @param {Quote} x */
export function headline(i, x) {
  if (RECURRING_MOW.includes(i.plan)) return { amount: x.perVisit, per: "per cut" };
  if (i.plan === "One-time cut") return { amount: x.perVisit, per: "one cut" };
  if (x.fertPerApp) return { amount: x.fertPerApp, per: "per application" };
  return { amount: x.annual, per: "for the season" };
}

/** Empty string = eligible; otherwise a short reason. @param {MatchableVendor} v @param {Spec} i */
export function eligibility(v, i, today = new Date()) {
  if (v.status !== "approved") return "not approved";
  const cats = v.categories || [];
  if (i.plan !== "No mowing" && !cats.includes("MOW")) return "mowing";
  const zips = v.zips || [];
  if (zips.length && !zips.includes(i.zip)) return "zip";
  if (v.insurance_expires && new Date(v.insurance_expires + "T23:59:59") < today) return "insurance expired";
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

/** @template {MatchableVendor} V @param {Settings} s @param {V[]} vendors @param {Spec} i */
export function matchVendors(s, vendors, i, today = new Date()) {
  const inZip = vendors.filter((v) => v.status === "approved" && (!(v.zips || []).length || v.zips.includes(i.zip)));
  const matches = []; let skipped = 0;
  for (const v of inZip) {
    if (!eligibility(v, i, today)) matches.push({ v, x: quote(s, /** @type {RateCard} */ (v.rate_card), i) });
    else skipped++;
  }
  matches.sort((a, b) => a.x.annual - b.x.annual);
  return { matches, skipped, inZip: inZip.length };
}

export function splitFee(amountDollars, takeRate) {
  const amount_cents = Math.round(amountDollars * 100);
  const fee_cents = Math.round(amount_cents * takeRate);
  return { amount_cents, fee_cents, net_cents: amount_cents - fee_cents };
}

export function validRateCard(rc, tierCount) {
  const x = rc;
  const num = (n, lo, hi) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
  const tiers = (a) => Array.isArray(a) && a.length === tierCount && a.every((n) => num(n, 1, 9999));
  return !!x && tiers(x.mowTiers) && (x.fertTiers === null || tiers(x.fertTiers))
    && num(x.biweeklyPremium, 0, 1) && num(x.oneTimeMult, 0.5, 5) && num(x.bundleDiscount, 0, 0.5)
    && !!x.addons && ADDONS.every((a) => x.addons[a.key] === null || num(x.addons[a.key], 0, 9999));
}

/** Parse a yard description from URLSearchParams-like input. Returns null if invalid. */
export function parseSpec(get) {
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

/** Why a spec is invalid for the "No mowing" plan (for form messages). */
export const needsService = (s) => s.plan === "No mowing" && !s.fert && !s.aerate && !s.leaves && !(+s.shrubs > 0);

export function specQuery(s) {
  const p = new URLSearchParams({ acres: String(s.acres), zip: s.zip, terrain: s.terrain, coverage: s.coverage, plan: s.plan, fert: s.fert ? "1" : "0", aerate: s.aerate ? "1" : "0", leaves: s.leaves ? "1" : "0", shrubs: String(s.shrubs) });
  if (s.custom.length) p.set("custom", s.custom.join(","));
  return p.toString();
}

export function specSummary(s) {
  const bits = [`${s.acres} acre${s.acres === 1 ? "" : "s"}`, s.terrain, s.coverage, `ZIP ${s.zip}`, s.plan];
  if (s.fert) bits.push("Fertilizer and weed control");
  if (s.aerate) bits.push("Core aeration");
  if (s.leaves) bits.push("Leaf cleanup");
  if (s.shrubs) bits.push(`Shrub trimming ×${s.shrubs}`);
  s.custom.forEach((c) => bits.push(`${c} (inspect)`));
  return bits;
}
