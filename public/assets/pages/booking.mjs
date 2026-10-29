import { $, $$, sb, esc, usd, usdAuto, usdCents, quoteLines, call, chip, fmtDate, prettyPhone, config, getSettings, stars, toast, today } from "../core.mjs";
import { JOB_CATEGORY, headline, itemLabel, quote } from "../pricing.mjs";

const root = $("#booking-root");
const qs = new URLSearchParams(location.search);
const ref = qs.get("ref") || "", tok = qs.get("t") || "";
const WINDOW = { morning: "Mornings", afternoon: "Afternoons", any: "Any time" };

async function load() {
  if (!sb) return null;
  const { data } = await sb.rpc("get_booking", { p_ref: ref, p_token: tok });
  return data;
}
// Returning from a card redirect (rare): confirm the setup.
if (qs.get("setup_intent")) await call("public", "confirmCard", { ref, token: tok, setupIntentId: qs.get("setup_intent") });

const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const act = async (action, payload, okMsg) => {
  const r = await call("public", action, { ref, token: tok, ...payload });
  if (!r.ok) { toast(r.error); return null; }
  await render(okMsg || r.data?.note || "Saved.");
  return r;
};

async function render(flash = "") {
  const d = await load();
  if (!d) { root.innerHTML = `<div class="stack" style="max-width:560px"><h1>Booking not found</h1><p class="muted">Use the full link from your booking email. It includes a private code. Lost it? <a href="account.html">Email me my booking links</a>.</p><div><a class="btn" href="index.html">Compare pros</a></div></div>`; return; }
  const b = d.booking, v = d.vendor;
  const live = ["scheduled", "active"].includes(b.status), open = !["cancelled", "completed"].includes(b.status);
  const needsCard = !!b.vendor_id && !!b.quote && !b.has_card && b.status !== "cancelled";
  const showCard = needsCard || qs.get("card") === "1" && b.status !== "cancelled";
  const steps = [["Booked", ["matched", "scheduled", "active", "completed"]], ["Visit scheduled", ["scheduled", "active", "completed"]], ["Service active", ["active", "completed"]]];
  const title = b.status === "cancelled" ? "This booking was cancelled" : needsCard ? "Save a card to confirm" : v ? `Your lawn care with ${esc(v.business)}` : "We're finding your pro";
  const hl = b.quote ? headline({ plan: b.plan }, b.quote) : null;
  const prepaidActive = b.prepaid_through && b.prepaid_through > today();
  const canReview = !!v && d.visits.length > 0;
  let pv = null, s = null;
  if (v && live && b.quote) { [s, pv] = await Promise.all([getSettings(), sb.from("public_vendors").select("*").eq("slug", v.slug).maybeSingle().then((r) => r.data)]); }
  const spec = { acres: b.yard.acres, zip: b.zip, terrain: b.yard.terrain, coverage: b.yard.coverage, plan: b.plan, fert: true, aerate: true, leaves: true, shrubs: 1, custom: [] };
  const px = pv ? quote(s, pv.rate_card, spec) : null;
  const offers = pv ? [
    ["fert", "Fertilizer and weed control", `${usd(px.fertPerApp)} per application, ${s.fertApps} a year`, !!pv.rate_card.fertTiers && pv.categories.includes("OTPS") && !b.addons.fert],
    ["aerate", "Core aeration", `${usd(px.aeration)} once a year`, pv.rate_card.addons.aeration != null && !b.addons.aerate],
    ["leaves", "Fall leaf cleanup", `${usd(px.leaves)} once`, pv.rate_card.addons.leafCleanup != null && !b.addons.leaves],
    ["shrubs", "Shrub trimming", `${usd(px.shrubVisit)} per visit`, pv.rate_card.addons.shrubTrim != null && !b.addons.shrubs]
  ].filter((o) => o[3]) : [];
  const shareUrl = `${location.origin}/?r=${encodeURIComponent(b.referral_code || "")}`;
  const settings = s || await getSettings();
  const credit = (settings.extras?.referralCreditCents ?? 2500) / 100;

  root.innerHTML = `<div class="grid2"><div class="stack-lg">
    <div><p class="eyebrow">Booking ${esc(b.ref)}</p><h1 style="margin-top:4px">${title}</h1><div style="margin-top:8px" class="btns">${chip(b.status)}${b.paused_until ? `<span class="chip c-new">Paused until ${fmtDate(b.paused_until)}</span>` : ""}${prepaidActive ? `<span class="chip c-approved">Prepaid through ${fmtDate(b.prepaid_through)}</span>` : ""}</div></div>
    ${flash ? `<div class="banner ok" role="status">${esc(flash)}</div>` : ""}
    ${showCard ? `<section class="card"><h2>${needsCard ? "Save your card" : "Update your card"}</h2><p class="muted small">${needsCard ? "Your booking is held, but your pro isn't notified until a card is on file." : "We'll use this card for future visits."}</p>
      <form id="card-form" novalidate style="gap:14px"><div id="payment-element"><p class="muted small">Loading secure card form…</p></div><p class="err" id="card-err" role="alert" hidden></p>
      <div><button class="btn" type="submit" id="card-btn" disabled>${needsCard ? "Save card and confirm booking" : "Save card"}</button></div><p class="hint">Secured by Stripe. MowBrokers never sees your full card number. You're charged after each visit, not today.</p></form></section>` : ""}
    ${!["cancelled", "pending_card", "new"].includes(b.status) ? `<ol class="timeline">${steps.map(([l, ok]) => `<li class="${ok.includes(b.status) ? "done" : ""}">${ok.includes(b.status) ? "✓ " : ""}${l}</li>`).join("")}</ol>` : ""}
    ${b.status === "new" ? `<p class="panel small">We're matching your request with a vetted pro near ${esc(b.zip)}. We'll email you their price, and you'll confirm with a card before anything is booked.</p>` : ""}

    ${live && !b.paused_until ? `<section class="panel"><h2>${b.status === "scheduled" ? `First visit ${fmtDate(b.first_visit)}` : b.next_visit_due ? `Next visit due around ${fmtDate(b.next_visit_due)}` : "Your plan is active"}</h2><p class="muted small">${v ? `${esc(v.business)} will call to set each visit. ` : ""}You're charged after each visit${prepaidActive ? ", except what your season prepay covers" : ""}.</p></section>` : ""}

    ${d.visits.length ? `<section class="stack"><h2>Visits and service reports</h2><div class="visits">${d.visits.map((x) => `<article class="visit"><div class="sechead"><b>${fmtDate(x.visit_date)}</b><span class="muted small">${esc(x.items.map((k) => itemLabel(k, b.plan)).join(" + "))}</span></div>${x.notes ? `<p class="small">${esc(x.notes)}</p>` : ""}${x.has_photo ? `<button class="linkbtn small" data-photo="${x.id}">View photo</button>` : ""}</article>`).join("")}</div></section>` : ""}

    ${canReview ? `<section class="card" id="review"><h2>${d.review ? "Your review" : `How is ${esc(v.business)} doing?`}</h2>
      <form id="review-form" novalidate style="gap:12px"><div class="starpick" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="rating" value="${n}" ${d.review?.rating === n ? "checked" : ""}><span aria-hidden="true">★</span><span class="hp">${n} star${n > 1 ? "s" : ""}</span></label>`).join("")}</div>
      <label for="r-comment">A few words for your neighbors (optional)<textarea id="r-comment" maxlength="1000" placeholder="Shows up the same day every week, clean edges, always closes the gate.">${esc(d.review?.comment ?? "")}</textarea></label>
      <div><button class="btn alt sm" type="submit">${d.review ? "Update review" : "Post review"}</button></div><p class="hint">Shown on ${esc(v.business)}'s profile with your first name and last initial.</p></form></section>` : ""}

    <section class="stack"><h2>Details</h2><dl class="kv">
      ${v ? `<dt>Your pro</dt><dd><a href="pro.html?slug=${encodeURIComponent(v.slug)}">${esc(v.business)}</a> · ${prettyPhone(v.phone)}</dd>` : ""}
      <dt>Address</dt><dd>${esc(b.street)}, ${esc(b.zip)}</dd>
      <dt>Yard</dt><dd>${esc(b.yard.acres)} acres · ${esc(b.yard.terrain)} · ${esc(b.yard.coverage)}</dd>
      <dt>Plan</dt><dd>${esc(b.plan)}${b.prepay ? (prepaidActive ? " · season prepay" : " · season prepay at next visit") : ""}</dd>
      ${b.first_visit ? `<dt>First visit</dt><dd>${fmtDate(b.first_visit)}</dd>` : b.preferred_start ? `<dt>You asked for</dt><dd>${fmtDate(b.preferred_start)}${b.preferred_alt ? ` or ${fmtDate(b.preferred_alt)}` : ""} · ${WINDOW[b.visit_window] ?? "Any time"}</dd>` : ""}
      ${b.credit_cents ? `<dt>Credit</dt><dd>${usdCents(b.credit_cents)}, applied to your next charges</dd>` : ""}
      ${b.custom.length ? `<dt>To inspect</dt><dd>${esc(b.custom.join(", "))}</dd>` : ""}</dl></section>

    ${d.payments.length ? `<section class="stack"><h2>Payments</h2><div class="tablewrap"><table><thead><tr><th>Date</th><th>Item</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>${d.payments.map((p) => `<tr><td class="num">${fmtDate(p.created_at)}</td><td>${esc(p.label)}${p.discount_cents ? `<div class="hint">${usdCents(p.discount_cents)} credit applied</div>` : ""}${p.refunded_cents ? `<div class="hint">${usdCents(p.refunded_cents)} refunded</div>` : ""}</td><td class="r num">${usdCents(p.amount_cents)}</td><td>${chip(p.status)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}

    ${["scheduled", "active", "completed"].includes(b.status) ? `<section class="panel"><h2>Missed spot or weeds back?</h2><p class="muted small">If a cut is missed or done poorly, or weeds come back between treatment visits, your pro comes back within two business days, free, under the MowBrokers re-service guarantee.</p>
      ${d.claims.map((c) => `<p class="small">${chip(c.status)} ${fmtDate(c.created_at)}: ${esc(c.description)}</p>`).join("")}
      <form id="claim-form" novalidate style="gap:12px"><label for="c-desc">What was missed, or what's back?<textarea id="c-desc" name="description" maxlength="1000" placeholder="Back fence line wasn't trimmed on the last cut"></textarea></label><p class="err" id="claim-err" role="alert" hidden></p><div><button class="btn alt" type="submit">Request a free re-service</button></div></form></section>` : ""}

    ${open && b.quote && b.plan !== "One-time cut" && v ? `<section class="stack" id="addons"><h2>Manage your plan</h2>
      ${offers.length ? `<div class="card"><h3>Add a service</h3><p class="muted small">${esc(v.business)}'s posted price for your yard, billed after each visit.</p>${offers.map(([k, l, p]) => `<div class="qi"><div class="t"><b>${l}</b><span class="muted small">${p}</span></div>${k === "shrubs" ? `<select id="shrubs-n" aria-label="Visits per year" style="min-height:34px"><option value="1">1×/yr</option><option value="2">2×/yr</option><option value="3">3×/yr</option></select>` : ""}<button class="btn ghost sm" data-addon="${k}">Add</button></div>`).join("")}
        ${pv ? (pv.custom_jobs || []).filter((j) => !(JOB_CATEGORY[j]) || pv.categories.includes(JOB_CATEGORY[j])).map((j) => `<div class="qi"><div class="t"><b>${esc(j)}</b><span class="muted small">${esc(v.business)} looks at the yard and quotes.</span></div><button class="btn ghost sm" data-inspect="${esc(j)}">Request</button></div>`).join("") : ""}</div>` : ""}
      ${live || b.status === "matched" ? `<div class="card"><h3>Season prepay</h3>${prepaidActive ? `<p class="small">Your season is prepaid through ${fmtDate(b.prepaid_through)}. ${b.prepay ? "Next season's prepay is charged at your first visit after that." : "After that you'll pay per visit."}</p><div><button class="btn ghost sm" data-prepay="${b.prepay ? "off" : "on"}">${b.prepay ? "Pay per visit after this season" : "Prepay next season too"}</button></div>`
        : `<p class="small">Pay for the season at your ${b.visits_charged ? "next" : "first"} visit and save ${Math.round((b.quote.prepayDiscount ?? 0.05) * 100)}%: <b class="num">${usd(b.quote.prepay ?? Math.round(b.quote.annual * 0.95))}</b> instead of ${usd(b.quote.annual)}. Unused visits are refunded if you cancel.</p><div><button class="btn ghost sm" data-prepay="${b.prepay ? "off" : "on"}">${b.prepay ? "Switch back to pay per visit" : "Prepay the season"}</button></div>`}</div>` : ""}
      ${live ? `<div class="card"><h3>${b.paused_until ? "Paused" : "Pause service"}</h3>${b.paused_until ? `<p class="small">Paused until ${fmtDate(b.paused_until)}. Nothing is charged while paused.</p><div><button class="btn ghost sm" data-resume>Resume now</button></div>` : `<p class="muted small">Away for a while, or skipping a visit? Nothing is charged while paused.</p><div class="btns" style="align-items:end"><label for="pause-until">Pause until<input type="date" id="pause-until" min="${addDays(7)}" max="${addDays(120)}" value="${addDays(30)}"></label><button class="btn ghost sm" data-pause>Pause</button></div>`}</div>` : ""}
      <details class="card"><summary>Cancel service</summary><form id="cancel-form" novalidate style="gap:12px;margin-top:12px"><label for="cancel-why">Why are you cancelling?<select id="cancel-why"><option value="">Choose one</option><option>Doing it myself now</option><option>Too expensive</option><option>Unhappy with the service</option><option>Moving</option><option>Switching to another company</option><option>Other</option></select></label><p class="small" id="cancel-refund"></p><p class="hint">Only away for a while? Pausing keeps your price.</p><div><button class="btn danger sm" type="submit">Cancel my service</button></div></form></details>
    </section>` : ""}

    ${b.referral_code && ["scheduled", "active", "completed", "matched"].includes(b.status) ? `<section class="card"><h2>Give ${usd(credit)}, get ${usd(credit)}</h2><p class="small">Share your link. Your neighbor gets ${usd(credit)} off, and you get ${usd(credit)} once they've had their first visit.${d.referrals?.earned ? ` You've earned ${d.referrals.earned} so far.` : ""}</p>
      <div class="btns"><input type="text" readonly value="${esc(shareUrl)}" id="share-url" style="min-height:36px;flex:1;min-width:0" aria-label="Your referral link"><button class="btn ghost sm" data-copy>Copy link</button></div><p class="hint">Or tell them your code: <b class="num">${esc(b.referral_code)}</b></p></section>` : ""}

    <section class="stack small" id="prefs"><label class="check"><input type="checkbox" id="offers" ${b.marketing_opt_out ? "" : "checked"}> Email me seasonal add-on offers (fertilizer and weed control, aeration, leaf cleanup)</label></section>
    <p class="hint">Bookmark this page. It's your private account page for this booking. Questions? Email ${esc(config.supportEmail || "us")}.</p>
  </div>
  ${b.quote ? `<aside class="chosen sticky"><p class="eyebrow">Your locked price</p><p><span class="bigprice">${usdAuto(hl.amount)}</span> ${hl.per}</p>${quoteLines(b.plan, b.quote)}<p class="small">Charged after each visit to the card on file.</p>${b.has_card && open && b.status !== "pending_card" ? `<a class="small" href="booking.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(tok)}&card=1">Update card</a>` : ""}</aside>` : ""}</div>`;

  if (showCard) mountCard(needsCard);
  wire(b);
  if (location.hash && !flash) document.querySelector(location.hash)?.scrollIntoView();
}

function wire(b) {
  $("#claim-form")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const err = $("#claim-err"); err.hidden = true;
    const r = await call("public", "claimByToken", { ref, token: tok, description: $("#c-desc").value });
    if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
    render("Re-service requested. Your pro will come back within two business days, free of charge.");
  });
  $("#review-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rating = Number(new FormData(e.currentTarget).get("rating"));
    if (!rating) { toast("Choose 1 to 5 stars."); return; }
    await act("submitReview", { rating, comment: $("#r-comment").value }, "Thanks! Your review helps your neighbors pick a pro.");
  });
  $$("[data-photo]").forEach((x) => (x.onclick = async () => {
    const w = window.open("", "_blank");
    const r = await call("public", "visitPhotoUrl", { ref, token: tok, visitId: x.dataset.photo });
    if (r.ok && w) w.location = r.data.url; else { w?.close(); toast(r.error || "Couldn't open the photo."); }
  }));
  $$("[data-addon]").forEach((x) => (x.onclick = async () => {
    if (!x.dataset.armed) { x.dataset.armed = "1"; x.textContent = "Confirm"; return; }
    x.disabled = true;
    await act("addAddon", { addon: x.dataset.addon, count: Number($("#shrubs-n")?.value || 1) }, "Added. Your pro has been told.");
  }));
  $$("[data-inspect]").forEach((x) => (x.onclick = async () => { x.disabled = true; await act("requestInspection", { job: x.dataset.inspect }, "Requested. Your pro will call to set up the inspection."); }));
  $$("[data-prepay]").forEach((x) => (x.onclick = async () => { x.disabled = true; await act("setPrepay", { on: x.dataset.prepay === "on" }, x.dataset.prepay === "on" ? "Season prepay is on. It's charged at your next visit." : "Switched to paying per visit."); }));
  $("[data-pause]")?.addEventListener("click", async (e) => { e.currentTarget.disabled = true; await act("pause", { until: $("#pause-until").value }, "Paused. Your pro has been told."); });
  $("[data-resume]")?.addEventListener("click", async (e) => { e.currentTarget.disabled = true; await act("resume", {}, "Resumed. Your pro will call to schedule."); });
  const cf = $("#cancel-form");
  if (cf) {
    cf.closest("details").addEventListener("toggle", async (e) => {
      if (!e.target.open) return;
      const r = await call("public", "cancelPreview", { ref, token: tok });
      if (r.ok && r.data.refund) $("#cancel-refund").textContent = `We'll refund ${usd(r.data.refund, 2)} of unused prepay to your card.`;
    });
    cf.addEventListener("submit", async (e) => {
      e.preventDefault();
      const why = $("#cancel-why").value;
      if (!why) { toast("Choose a reason."); return; }
      const btn = cf.querySelector("button");
      if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "Yes, cancel my service"; return; }
      btn.disabled = true;
      await act("cancel", { reason: why }, "Cancelled. You won't be charged for future visits.");
    });
  }
  $("[data-copy]")?.addEventListener("click", async () => {
    const u = $("#share-url").value;
    try { await navigator.clipboard.writeText(u); toast("Link copied."); } catch { $("#share-url").select(); toast("Press Ctrl+C to copy."); }
  });
  $("#offers")?.addEventListener("change", async (e) => {
    const r = await call("public", "unsubscribe", { ref, token: tok, on: !e.target.checked });
    toast(r.ok ? (e.target.checked ? "You'll get seasonal offers." : "Seasonal offers turned off.") : r.error);
  });
  void b;
}

async function mountCard(needsCard) {
  const err = $("#card-err"), btn = $("#card-btn");
  const pk = config.stripePublishableKey;
  if (!window.Stripe || !pk || pk.includes("YOUR-")) { err.textContent = "Payments aren't configured yet."; err.hidden = false; return; }
  const r = await call("public", "setupIntent", { ref, token: tok });
  if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
  const stripe = window.Stripe(pk);
  const elements = stripe.elements({ clientSecret: r.data.clientSecret, appearance: { theme: "stripe", variables: { colorPrimary: "#13283D", fontFamily: "Archivo, system-ui, sans-serif", borderRadius: "6px" } }, fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;600&display=swap" }] });
  const pe = elements.create("payment", { layout: "tabs" });
  $("#payment-element").innerHTML = ""; pe.mount("#payment-element");
  pe.on("ready", () => (btn.disabled = false));
  const label = btn.textContent;
  $("#card-form").addEventListener("submit", async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true; btn.textContent = "Saving card…";
    const { error, setupIntent } = await stripe.confirmSetup({ elements, redirect: "if_required", confirmParams: { return_url: location.href.split("&setup_intent")[0] } });
    if (error) { err.textContent = error.message || "Your card couldn't be saved."; err.hidden = false; btn.disabled = false; btn.textContent = label; return; }
    const c = await call("public", "confirmCard", { ref, token: tok, setupIntentId: setupIntent.id });
    if (!c.ok) { err.textContent = c.error; err.hidden = false; btn.disabled = false; btn.textContent = label; return; }
    history.replaceState(null, "", `booking.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(tok)}`);
    qs.delete("card");
    render(needsCard ? "Card saved. Your pro has been notified and will call within one business day to set your first visit." : "Card updated.");
  });
}

render(qs.get("new") && !qs.get("card") ? "Request received. We'll email you as soon as we've matched a pro." : "");
if (qs.get("refx")) toast("Your booking is saved, but the referral code couldn't be applied: referral credit is for a different household than the one who shared it.");
