import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SETTINGS as S, quote, eligibility, matchVendors, splitFee, headline, validRateCard, parseSpec, specQuery, tierIndex, needsService,
  itemAmount, itemLimits, applyCredit, prepaidPayout, bestMatchKey, addBusinessHours, withAddons, visitIntervalDays, extrasOf
} from "../supabase/functions/_shared/pricing.mjs";

const spec = { acres: 0.3, zip: "35758", terrain: "Flat and open", coverage: "Front and back", plan: "Every two weeks", fert: true, aerate: true, leaves: false, shrubs: 2, custom: [] };
const vendor = (o = {}) => ({ id: "v", status: "approved", categories: ["MOW", "OTPS"], zips: ["35758"], insurance_expires: "2099-01-01", rate_card: S.suggested, custom_jobs: [], stripe_charges_enabled: true, ...o });
const bare = { ...spec, fert: false, aerate: false, leaves: false, shrubs: 0 };

test("browser copy matches the shared engine", () => {
  assert.equal(readFileSync(new URL("../public/assets/pricing.mjs", import.meta.url), "utf8"), readFileSync(new URL("../supabase/functions/_shared/pricing.mjs", import.meta.url), "utf8"));
});
test("lot tiers by acres", () => {
  assert.deepEqual([0.1, 0.25, 0.3, 0.5, 0.99, 1, 1.5, 2, 5].map((a) => tierIndex(S, a)), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
});
test("reference case: 0.3 acre, every two weeks, fert + aeration + 2 shrub visits", () => {
  const x = quote(S, S.suggested, spec);
  assert.deepEqual(
    { q: x.q, perVisit: x.perVisit, visits: x.visits, mowing: x.mowing, fertPerApp: x.fertPerApp, fert: x.fert, bundle: x.bundle, aeration: x.aeration, leaves: x.leaves, shrubs: x.shrubs, annual: x.annual },
    { q: 55, perVisit: 65, visits: 15, mowing: 975, fertPerApp: 70, fert: 420, bundle: -42, aeration: 150, leaves: 0, shrubs: 170, annual: 1673 });
  assert.deepEqual(headline(spec, x), { amount: 65, per: "per cut" });
  assert.equal(x.tier, "¼–½ acre"); assert.equal(x.guideOnly, false);
});
test("weekly plan", () => {
  const x = quote(S, S.suggested, { ...bare, plan: "Weekly" });
  assert.deepEqual([x.q, x.perVisit, x.visits, x.mowing, x.annual], [55, 55, 30, 1650, 1650]);
  assert.deepEqual(headline({ plan: "Weekly" }, x), { amount: 55, per: "per cut" });
});
test("weekly base grid across lot tiers and factors", () => {
  const w = { ...bare, plan: "Weekly" };
  assert.deepEqual([0.1, 0.3, 0.7, 1.5, 3].map((acres) => quote(S, S.suggested, { ...w, acres }).q), [45, 55, 70, 95, 130]);
  assert.equal(quote(S, S.suggested, { ...w, terrain: "Some slopes or obstacles" }).q, 65); // 55 × 1.15 = 63.25
  assert.equal(quote(S, S.suggested, { ...w, terrain: "Steep or heavily landscaped" }).q, 70); // 71.5
  assert.equal(quote(S, S.suggested, { ...w, coverage: "Front yard only" }).q, 35); // 33
  assert.equal(quote(S, S.suggested, { ...w, coverage: "Back yard only" }).q, 30); // 30.25
});
test("every two weeks: premium per cut, half the cuts", () => {
  const x = quote(S, S.suggested, bare);
  assert.deepEqual([x.perVisit, x.visits, x.mowing], [65, 15, 975]);
  const odd = quote({ ...S, season: { weeks: 31, label: "x" } }, S.suggested, bare);
  assert.equal(odd.visits, 16);
});
test("one-time cut: multiplier, no bundle, no prepay", () => {
  const x = quote(S, S.suggested, { ...spec, plan: "One-time cut" });
  assert.deepEqual([x.perVisit, x.visits, x.mowing, x.bundle, x.prepay], [85, 1, 85, 0, 0]); // 55 × 1.5 = 82.5 → 85
  assert.equal(x.annual, 85 + 420 + 150 + 170);
  assert.deepEqual(headline({ plan: "One-time cut" }, x), { amount: 85, per: "one cut" });
});
test("no mowing: treatments only, no bundle, headline per application", () => {
  const x = quote(S, S.suggested, { ...spec, plan: "No mowing" });
  assert.deepEqual([x.mowing, x.visits, x.perVisit, x.bundle, x.fert, x.annual], [0, 0, 0, 0, 420, 740]);
  assert.deepEqual(headline({ plan: "No mowing" }, x), { amount: 70, per: "per application" });
  const aOnly = quote(S, S.suggested, { ...bare, plan: "No mowing", aerate: true });
  assert.deepEqual(headline({ plan: "No mowing" }, aOnly), { amount: 150, per: "for the season" });
});
test("fert bundle discount only with recurring mowing", () => {
  assert.equal(quote(S, S.suggested, { ...bare, fert: true, plan: "Weekly" }).bundle, -42);
  assert.equal(quote(S, S.suggested, { ...bare, fert: true, plan: "Every two weeks" }).bundle, -42);
  assert.equal(quote(S, S.suggested, { ...bare, fert: true, plan: "One-time cut" }).bundle, 0);
  assert.equal(quote(S, S.suggested, { ...bare, fert: true, plan: "No mowing" }).bundle, 0);
  assert.equal(quote(S, { ...S.suggested, bundleDiscount: 0 }, { ...bare, fert: true }).bundle, 0);
  // fert is scaled by coverage, not terrain
  const f = quote(S, S.suggested, { ...bare, fert: true, coverage: "Front yard only", terrain: "Steep or heavily landscaped" });
  assert.equal(f.fertPerApp, 40); // 70 × 0.6 = 42 → 40
});
test("add-ons scale by lot; shrub trimming is flat", () => {
  const a = (acres) => quote(S, S.suggested, { ...bare, acres, aerate: true, leaves: true, shrubs: 3 });
  assert.deepEqual([0.1, 0.3, 0.7, 1.5, 3].map((ac) => a(ac).aeration), [95, 150, 245, 380, 570]); // 95 × 1, 1.6, 2.6, 4, 6
  assert.deepEqual([0.1, 0.3, 0.7, 1.5, 3].map((ac) => a(ac).leaves), [175, 280, 455, 700, 1050]);
  assert.deepEqual([0.1, 3].map((ac) => a(ac).shrubs), [255, 255]);
});
test("last tier is a guide price", () => {
  assert.equal(quote(S, S.suggested, { ...bare, acres: 2 }).guideOnly, true);
  assert.equal(quote(S, S.suggested, { ...bare, acres: 1.99 }).guideOnly, false);
});
test("eligibility rules", () => {
  assert.equal(eligibility(vendor(), spec), "");
  assert.equal(eligibility(vendor({ status: "vetting" }), spec), "not approved");
  assert.equal(eligibility(vendor({ zips: ["35801"] }), spec), "zip");
  assert.equal(eligibility(vendor({ insurance_expires: "2020-01-01" }), spec), "insurance expired");
  assert.equal(eligibility(vendor({ stripe_charges_enabled: false }), spec), "payments not set up");
  assert.equal(eligibility(vendor({ categories: ["OTPS"] }), spec), "mowing");
  assert.equal(eligibility(vendor({ categories: ["OTPS"] }), { ...spec, plan: "No mowing" }), "");
  assert.equal(eligibility(vendor({ categories: ["MOW"] }), spec), "fertilization");
  assert.equal(eligibility(vendor({ rate_card: { ...S.suggested, fertTiers: null } }), spec), "fertilization");
  assert.equal(eligibility(vendor({ categories: ["MOW"] }), bare), "");
  assert.equal(eligibility(vendor({ rate_card: { ...S.suggested, addons: { ...S.suggested.addons, aeration: null } } }), spec), "aeration");
  assert.equal(eligibility(vendor({ rate_card: { ...S.suggested, addons: { ...S.suggested.addons, leafCleanup: null } } }), { ...bare, leaves: true }), "leaf cleanup");
  assert.equal(eligibility(vendor({ rate_card: { ...S.suggested, addons: { ...S.suggested.addons, shrubTrim: null } } }), spec), "shrub trimming");
  assert.equal(eligibility(vendor(), { ...bare, custom: ["Sod installation"] }), "Sod installation");
  assert.equal(eligibility(vendor({ custom_jobs: ["Sod installation"] }), { ...bare, custom: ["Sod installation"] }), "");
  assert.equal(eligibility(vendor({ custom_jobs: ["Tree and stump removal"] }), { ...bare, custom: ["Tree and stump removal"] }), "Tree and stump removal");
  assert.equal(eligibility(vendor({ categories: ["MOW", "TS"], custom_jobs: ["Tree and stump removal"] }), { ...bare, custom: ["Tree and stump removal"] }), "");
  assert.equal(eligibility(vendor({ custom_jobs: ["Landscape bed install"] }), { ...bare, custom: ["Landscape bed install"] }), "Landscape bed install");
  assert.equal(eligibility(vendor({ categories: ["MOW", "SLP"], custom_jobs: ["Landscape bed install"] }), { ...bare, custom: ["Landscape bed install"] }), "");
});
test("matching sorts by season price", () => {
  const r = matchVendors(S, [
    vendor({ id: "pricey", rate_card: { ...S.suggested, mowTiers: [55, 65, 80, 105, 140] } }),
    vendor({ id: "mowonly", categories: ["MOW"] }),
    vendor({ id: "cheap", rate_card: { ...S.suggested, mowTiers: [40, 50, 65, 90, 120] } })
  ], spec);
  assert.deepEqual(r.matches.map((m) => m.v.id), ["cheap", "pricey"]); assert.equal(r.skipped, 1); assert.equal(r.inZip, 3);
});
test("money and validation", () => {
  assert.deepEqual(splitFee(65, 0.12), { amount_cents: 6500, fee_cents: 780, net_cents: 5720 });
  assert.equal(validRateCard(S.suggested, 5), true);
  assert.equal(validRateCard({ ...S.suggested, fertTiers: null }, 5), true);
  assert.equal(validRateCard({ ...S.suggested, bundleDiscount: 0.9 }, 5), false);
  assert.equal(validRateCard({ ...S.suggested, mowTiers: [45, 55] }, 5), false);
  assert.equal(validRateCard({ ...S.suggested, addons: { ...S.suggested.addons, aeration: -1 } }, 5), false);
});
test("spec round-trips through the URL and validates", () => {
  const s2 = parseSpec(Object.fromEntries(new URLSearchParams(specQuery({ ...spec, custom: ["Sod installation"] }))));
  assert.deepEqual(s2, { ...spec, custom: ["Sod installation"] });
  assert.equal(parseSpec({ acres: "0.01", zip: "35758", plan: "Weekly", terrain: "x", coverage: "y" }), null);
  assert.equal(parseSpec({ acres: "0.3", zip: "35758", plan: "Quarterly", terrain: "x", coverage: "y" }), null);
  assert.equal(parseSpec({ acres: "0.3", zip: "35758", plan: "No mowing", terrain: "x", coverage: "y" }), null, "No mowing needs a service");
  assert.ok(parseSpec({ acres: "0.3", zip: "35758", plan: "No mowing", terrain: "x", coverage: "y", shrubs: "1" }));
  assert.equal(needsService({ plan: "No mowing", shrubs: 0 }), true);
  assert.equal(needsService({ plan: "Weekly" }), false);
});
test("itemized amounts and limits", () => {
  const x = quote(S, S.suggested, spec);
  assert.equal(itemAmount(x, "visit"), 65);
  assert.equal(itemAmount(x, "fert"), 63); // (420 − 42) / 6, bundle spread across applications
  assert.equal(itemAmount(x, "aeration"), 150);
  assert.equal(itemAmount(x, "shrubs"), 85);
  assert.deepEqual(itemLimits(spec.plan, x, spec), { visit: 15, fert: 6, aeration: 1, leaves: 0, shrubs: 2 });
  const full = 15 * 65 + 6 * 63 + 150 + 2 * 85;
  assert.equal(full, x.annual, "billing every item in the season adds up to the season price");
  assert.equal(visitIntervalDays("Weekly"), 7); assert.equal(visitIntervalDays("Every two weeks"), 14); assert.equal(visitIntervalDays("One-time cut"), null);
});
test("season prepay price and payouts", () => {
  const x = quote(S, S.suggested, spec);
  assert.equal(x.prepay, Math.round(1673 * 0.95));
  assert.deepEqual(prepaidPayout(65, 0.05, 0.12), { amount_cents: 6175, fee_cents: 741, net_cents: 5434 });
  assert.equal(extrasOf({}).prepayDiscount, 0.05);
});
test("credits come out of the platform fee only", () => {
  assert.deepEqual(applyCredit(11000, 1320, 2500), { charge_cents: 9680, fee_cents: 0, discount_cents: 1320 });
  assert.deepEqual(applyCredit(11000, 1320, 500), { charge_cents: 10500, fee_cents: 820, discount_cents: 500 });
});
test("best match ranking prefers higher scores at similar prices", () => {
  assert.ok(bestMatchKey(1600, 95) < bestMatchKey(1550, 50));
  assert.ok(bestMatchKey(1000, 60) < bestMatchKey(1800, 100));
});
test("response deadline skips weekends", () => {
  assert.equal(addBusinessHours(new Date("2026-10-30T20:00:00Z")).toISOString(), "2026-11-02T20:00:00.000Z");
  assert.equal(addBusinessHours(new Date("2026-10-27T15:00:00Z")).toISOString(), "2026-10-28T15:00:00.000Z");
});
test("adding an add-on keeps the locked mowing price", () => {
  const locked = quote(S, S.suggested, bare);
  const m = withAddons(S, { ...S.suggested, mowTiers: [200, 200, 200, 200, 200] }, locked, bare, { fert: true });
  assert.equal(m.mowing, locked.mowing); assert.equal(m.perVisit, locked.perVisit);
  assert.equal(m.fert, 420); assert.equal(m.bundle, -42); assert.equal(m.annual, locked.annual + 378);
  const a = withAddons(S, S.suggested, locked, bare, { aerate: true, shrubs: 1 });
  assert.equal(a.aeration, 150); assert.equal(a.shrubs, 85); assert.equal(a.annual, 975 + 235);
});
