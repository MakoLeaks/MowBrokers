import { $, sb, esc, usd, usdAuto, quoteLines, getSettings, call, shortName, referralCode, forgetReferral, today } from "../core.mjs";
import { eligibility, headline, parseSpec, quote, specQuery, specSummary } from "../pricing.mjs";

const root = $("#book-root");
const qs = new URLSearchParams(location.search);
const spec = parseSpec((k) => qs.get(k));
if (!spec) location.replace("index.html");
const q = specQuery(spec);
const isRequest = qs.get("request") === "1";
let v = null, x = null;
if (!isRequest) {
  const [s, res] = await Promise.all([getSettings(), sb ? sb.from("public_vendors").select("*").eq("slug", qs.get("slug") || "").maybeSingle() : Promise.resolve({ data: null })]);
  v = res.data;
  if (!v || eligibility(v, spec)) location.replace(`results.html?${q}`);
  x = quote(s, v.rate_card, spec);
}
const h = x ? headline(spec, x) : null;
root.innerHTML = `<div class="grid2"><div>
  <ol class="steps" aria-label="Booking steps"><li>1. Your yard ✓</li><li>2. Compare pros ✓</li><li aria-current="step">3. Book</li></ol>
  <h1 style="margin-bottom:6px">${v ? `Book ${esc(v.business)}` : "Send us your request"}</h1>
  <p class="muted" style="margin-bottom:22px">${v ? `${esc(v.business)} will call to set your first visit. Your price is locked when you book.` : "No pro matched automatically. We'll find a vetted lawn pro for your yard and send you their price before anything is booked."}</p>
  <form id="book-form" novalidate>
    <fieldset><legend>Contact</legend>
      <div class="row"><label for="name">Full name<input type="text" id="name" name="name" autocomplete="name" required></label><label for="phone">Mobile phone<input type="tel" id="phone" name="phone" autocomplete="tel" required></label></div>
      <label for="email">Email (for receipts)<input type="email" id="email" name="email" autocomplete="email" required></label>
      <label class="check small"><input type="checkbox" name="sms" id="sms"> Text me booking updates. Message and data rates may apply. Reply STOP to opt out.</label>
    </fieldset>
    <fieldset><legend>Service address</legend>
      <label for="street">Street address<input type="text" id="street" name="street" autocomplete="street-address" required></label>
      <label for="notes">Anything your pro should know? (optional)<textarea id="notes" name="notes" maxlength="1000" placeholder="Gate code 1234, dog in the back yard, please bag clippings…"></textarea></label>
      <div class="hp" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
    </fieldset>
    <fieldset><legend>First visit</legend>
      <div class="row"><label for="start">Preferred date<input type="date" id="start" name="start" min="${today()}"></label><label for="alt">Backup date<input type="date" id="alt" name="alt" min="${today()}"></label></div>
      <div class="seg" role="radiogroup" aria-label="Time of day"><label><input type="radio" name="window" value="any" checked> Any time</label><label><input type="radio" name="window" value="morning"> Morning (8–12)</label><label><input type="radio" name="window" value="afternoon"> Afternoon (12–5)</label></div>
      <p class="hint">${v ? `${esc(v.business)} confirms the exact time when they call, within one business day.` : "Your pro confirms the exact time when they call."}</p>
    </fieldset>
    ${x && spec.plan !== "One-time cut" ? `<fieldset><legend>Payment</legend>
      <label class="check"><input type="checkbox" name="prepay" id="prepay"> Prepay the season at my first visit and save ${Math.round((x.prepayDiscount ?? 0.05) * 100)}%: <b class="num">${usd(x.prepay)}</b> instead of ${usd(x.annual)}. Unused visits are refunded if I cancel.</label>
      <p class="hint">Covers your cuts and add-ons for this service year. Either way, nothing is charged until your first visit.</p></fieldset>` : ""}
    <fieldset><legend>Referral code (optional)</legend><div class="row"><label for="refcode">Code from a friend<input type="text" id="refcode" name="refcode" maxlength="12" autocapitalize="characters" value="${esc(referralCode())}"></label></div><p class="hint" id="ref-msg"></p></fieldset>
    <p class="err" id="book-err" role="alert" hidden></p>
    <div class="btns"><button class="btn" type="submit" id="book-submit">${v ? "Continue to save card" : "Send request"}</button>${v ? `<a class="btn ghost" href="results.html?${q}">Back to pros</a>` : ""}</div>
    <p class="hint">By booking you agree to the <a href="terms.html">Terms</a>. ${v ? "Next you'll save a card. You're charged only after each visit." : "We'll send your pro's price before anything is booked."}</p>
  </form>
</div>
<aside class="sticky">${v ? `<div class="chosen"><p class="eyebrow">Your pro</p><h2>${esc(v.business)}</h2><p><span class="bigprice">${usdAuto(h.amount)}</span> ${h.per}</p>${quoteLines(spec.plan, x)}<p class="small">${esc(specSummary(spec).join(" · "))}</p>
  <div class="btns"><a class="btn ghost sm" href="pro.html?slug=${encodeURIComponent(v.slug)}&${q}">View profile</a><a class="small" href="results.html?${q}">Choose a different pro</a></div></div>`
  : `<div class="panel"><h3>Your yard</h3><p class="small">${esc(specSummary(spec).join(" · "))}</p></div>`}</aside></div>`;
if (v) document.title = `Book ${shortName(v.business)} · MowBrokers`;

$("#book-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget), err = $("#book-err"), btn = $("#book-submit");
  err.hidden = true; btn.disabled = true; const label = btn.textContent; btn.textContent = "Saving…";
  const r = await call("public", "createBooking", { spec, vendorSlug: v?.slug ?? null, name: f.get("name"), phone: f.get("phone"), email: f.get("email"), street: f.get("street"), preferredStart: f.get("start") || "", preferredAlt: f.get("alt") || "", visitWindow: f.get("window") || "any", prepay: f.get("prepay") === "on", referralCode: f.get("refcode") || "", notes: f.get("notes") || "", smsConsent: f.get("sms") === "on", website: f.get("website") || "" });
  if (!r.ok) { err.textContent = r.error; err.hidden = false; btn.disabled = false; btn.textContent = label; return; }
  if (r.data.credit) forgetReferral();
  const refSkipped = String(f.get("refcode") || "").trim() && !r.data.credit;
  location.href = `booking.html?ref=${encodeURIComponent(r.data.ref)}&t=${encodeURIComponent(r.data.token)}${r.data.needsCard ? "&card=1" : ""}&new=1${refSkipped ? "&refx=1" : ""}`;
});

async function checkRef() {
  const el = $("#refcode"), msg = $("#ref-msg");
  const code = el.value.trim();
  if (!code) { msg.textContent = ""; return; }
  const r = await call("public", "checkReferral", { code });
  msg.textContent = r.ok && r.data.valid ? `Code from ${r.data.from}: ${usd(r.data.credit)} off your first visits.` : "We don't recognize that code. Check it, or leave it blank.";
}
$("#refcode").addEventListener("change", checkRef);
if ($("#refcode").value) checkRef();
