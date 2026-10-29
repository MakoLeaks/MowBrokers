import { $, $$, sb, esc, usd, usdAuto, usdCents, call, chip, fmtDate, prettyPhone, daysUntil, today, checksFor, requireSession, myRole, signOut, toast, stars, ratingLine, respText } from "../core.mjs";
import { mountVisitForm } from "../visitform.mjs";

const root = $("#portal-root");
const s = await requireSession();
const uid = s.user.id;
const admin = (await myRole(uid)) === "admin";
const qs = new URLSearchParams(location.search);
const WINDOW = { morning: "mornings", afternoon: "afternoons" };
const addonList = (b) => [b.addons.fert && "fert & weed", b.addons.aerate && "aeration", b.addons.leaves && "leaf cleanup", b.addons.shrubs && `shrub trim ×${b.addons.shrubs}`].filter(Boolean);

async function load() {
  const { data: vendor } = await sb.from("vendors").select("*").eq("owner_id", uid).maybeSingle();
  if (!vendor) { location.replace(admin ? "admin.html" : "profile.html"); return null; }
  const [bk, cl, py, rv, st] = await Promise.all([
    sb.from("bookings").select("*").eq("vendor_id", vendor.id).not("status", "in", "(pending_card,cancelled)").order("created_at", { ascending: false }).limit(300),
    sb.from("claims").select("*").eq("vendor_id", vendor.id).neq("status", "resolved").order("created_at"),
    sb.from("payments").select("*").eq("vendor_id", vendor.id).order("created_at", { ascending: false }).limit(200),
    sb.from("reviews").select("*").eq("vendor_id", vendor.id).eq("hidden", false).order("created_at", { ascending: false }).limit(10),
    sb.rpc("vendor_stats", { p_ids: [vendor.id] })
  ]);
  return { vendor, bookings: bk.data ?? [], claims: cl.data ?? [], payments: py.data ?? [], reviews: rv.data ?? [], stats: (st.data ?? [])[0] };
}

function clock(b) {
  if (b.contacted_at) return `<span class="chip c-scheduled">Called ${fmtDate(b.contacted_at)}</span>`;
  if (!b.respond_by) return "";
  const ms = new Date(b.respond_by).getTime() - Date.now();
  const h = Math.max(0, Math.round(ms / 3600000));
  return `<span class="chip ${h <= 4 ? "c-failed" : "c-new"}">${ms <= 0 ? "Call deadline passed" : `Call within ${h < 1 ? "the hour" : h + " h"}`}</span>`;
}

let first = true;
async function render() {
  if (first && (qs.get("stripe") === "return")) await call("portal", "refreshStripe");
  let d = await load(); if (!d) return;
  if (first && d.vendor.stripe_account_id && !d.vendor.stripe_charges_enabled && qs.get("stripe") !== "return") { await call("portal", "refreshStripe"); d = await load(); }
  first = false;
  const { vendor: v, bookings, claims, payments, reviews, stats } = d;
  const toCall = bookings.filter((b) => b.status === "matched");
  const live = bookings.filter((b) => ["scheduled", "active"].includes(b.status));
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const paidMonth = payments.filter((p) => p.status === "succeeded" && new Date(p.created_at) >= monthStart).reduce((t, p) => t + p.net_cents, 0);
  const failed = payments.filter((p) => p.status === "failed");
  const CHECKS = checksFor(v.categories);
  const done = CHECKS.filter(([k]) => v.checklist?.[k]).length;
  const ins = daysUntil(v.insurance_expires);
  const byId = Object.fromEntries(bookings.map((b) => [b.id, b]));
  const dueSoon = (b) => b.next_visit_due && daysUntil(b.next_visit_due) <= 7;
  live.sort((a, b) => (a.next_visit_due || "9999").localeCompare(b.next_visit_due || "9999"));

  root.innerHTML = `<div class="stack-lg">
    <div class="sechead"><div><p class="eyebrow">Provider portal</p><h1 style="margin-top:4px">${esc(v.business)}</h1><div style="margin-top:8px" class="btns">${chip(v.status)} ${ratingLine(stats)}</div></div>
      <div class="btns"><a class="btn ghost sm" href="profile.html">Profile and prices</a>${v.status === "approved" ? `<a class="btn ghost sm" href="pro.html?slug=${encodeURIComponent(v.slug)}">Public profile</a>` : ""}${admin ? '<a class="btn ghost sm" href="admin.html">Operator console</a>' : ""}<button class="btn ghost sm" id="signout">Sign out</button></div></div>
    ${qs.get("applied") ? '<div class="banner ok">Application received. We\'ll call within two business days to start vetting.</div>' : ""}
    ${v.status !== "approved" ? `<section class="panel"><h2>${v.status === "suspended" ? "Your profile is paused" : v.status === "rejected" ? "Application not approved" : `Vetting: ${done} of ${CHECKS.length} steps done`}</h2>
      ${["applied", "vetting"].includes(v.status) ? `<ul style="margin:0;padding-left:0;list-style:none;display:grid;gap:4px" class="small">${CHECKS.map(([k, l]) => `<li>${v.checklist?.[k] ? "✓" : "○"} ${l}</li>`).join("")}</ul>` : ""}
      ${!v.coi_path ? '<p class="small">Upload your certificate of insurance on <a href="profile.html">Profile and prices</a> to speed this up.</p>' : ""}</section>` : ""}
    ${!v.stripe_charges_enabled ? `<section class="card" style="border-color:var(--accent)"><h2>Set up payouts</h2><p class="muted small">Customers can't book you until Stripe can pay you. It takes about five minutes: business details, bank account and identity check.</p><div><button class="btn" data-stripe="onboard">Set up payouts with Stripe</button></div></section>` : ""}
    ${v.status === "approved" && ins <= 30 ? `<div class="banner bad">${ins < 0 ? "Your insurance has expired, so customers can't see you." : `Your insurance expires ${fmtDate(v.insurance_expires)}.`} Upload a new certificate and update the date on <a href="profile.html">Profile and prices</a>.</div>` : ""}
    <div class="kpis">${[["New customers to call", toCall.length], ["Active customers", live.length], ["Visits due this week", live.filter(dueSoon).length], ["Paid to you this month", usdCents(paidMonth)], ["Score", stats?.score ?? "—", respText(stats?.resp_hours) || "Rating, response time, reliability"]].map(([l, n, sub]) => `<div class="kpi"><span class="l">${l}</span><span class="v">${n}</span>${sub ? `<span class="hint">${esc(sub)}</span>` : ""}</div>`).join("")}</div>

    ${failed.length ? `<section class="stack"><h2>Payments needing attention</h2>${failed.map((p) => `<div class="qi"><div class="t"><b>${esc(byId[p.booking_id]?.customer_name ?? "Customer")} · ${esc(p.label)} · ${usdCents(p.amount_cents)}</b><span class="muted small">${esc(p.failure_message ?? "")} · ${fmtDate(p.created_at)}. We emailed the customer to update their card.</span></div><button class="btn ghost sm" data-retry="${p.id}">Retry</button></div>`).join("")}</section>` : ""}

    <section class="stack"><h2>Call and schedule</h2>
      <p class="muted small">Call new customers within one business day and tap “I called them”. If the deadline passes, the booking moves to another pro.</p>
      ${toCall.length ? toCall.map((b) => `<article class="card" style="grid-template-columns:minmax(0,1fr) auto">
        <div class="small" style="display:grid;gap:4px"><p style="font-size:16px;font-weight:700">${esc(b.customer_name)} <span class="muted" style="font-weight:400">· ${esc(b.ref)}</span> ${clock(b)}</p>
          <p><a href="tel:${esc(b.customer_phone)}"><b>${prettyPhone(b.customer_phone)}</b></a> · ${esc(b.street)}, ${esc(b.zip)}</p>
          <p>${esc(b.yard.acres)} acres · ${esc(b.yard.terrain.toLowerCase())} · ${esc(b.yard.coverage.toLowerCase())} · ${esc(b.plan)}${b.prepay ? " · prepaying the season" : ""}</p>
          ${b.preferred_start || b.visit_window !== "any" ? `<p>Wants ${b.preferred_start ? fmtDate(b.preferred_start) : "soon"}${b.preferred_alt ? ` or ${fmtDate(b.preferred_alt)}` : ""}${WINDOW[b.visit_window] ? `, ${WINDOW[b.visit_window]}` : ""}</p>` : ""}
          ${b.custom.length ? `<p style="background:var(--tint);color:var(--tint-fg);padding:4px 8px;border-radius:6px">Look and quote: ${esc(b.custom.join(", "))}</p>` : ""}
          ${b.notes ? `<p class="muted">“${esc(b.notes)}”</p>` : ""}
          ${b.quote ? `<p class="num">Locked price: ${b.quote.perVisit ? `${usdAuto(b.quote.perVisit)} per cut · ` : ""}${usd(b.quote.annual)} ${b.plan === "One-time cut" ? "total" : "for the season"}</p>` : ""}</div>
        <div class="stack">${!b.contacted_at ? `<button class="btn alt sm" data-contacted="${b.id}">I called them</button>` : ""}<label for="d-${b.id}">First visit<input type="date" id="d-${b.id}" value="${esc(b.preferred_start || today())}"></label><button class="btn sm" data-schedule="${b.id}">Mark scheduled</button></div></article>`).join("")
        : '<div class="empty">No new customers waiting. When a homeowner chooses you, they appear here and we text and email you.</div>'}
    </section>

    <section class="stack"><h2>Active customers</h2>
      ${live.length ? `<div class="tablewrap"><table class="wide"><thead><tr><th>Customer</th><th>Plan</th><th>Next visit</th><th></th></tr></thead><tbody>${live.map((b) => `
        <tr><td><b>${esc(b.customer_name)}</b><div class="hint">${esc(b.ref)} · ${prettyPhone(b.customer_phone)} · ${esc(b.street)}</div></td>
          <td>${esc(b.plan)}${b.prepaid_through && b.prepaid_through >= today() ? `<div class="hint">Prepaid through ${fmtDate(b.prepaid_through)}</div>` : b.prepay ? '<div class="hint">Prepays at next visit</div>' : ""}${addonList(b).length ? `<div class="hint">+ ${addonList(b).join(", ")}</div>` : ""}</td>
          <td>${b.paused_until ? `<span class="chip c-new">Paused until ${fmtDate(b.paused_until)}</span>` : b.status === "scheduled" ? `First visit ${fmtDate(b.first_visit)}` : b.next_visit_due ? `<span class="${daysUntil(b.next_visit_due) < 0 ? "err" : dueSoon(b) ? "" : "muted"}">${daysUntil(b.next_visit_due) < 0 ? "Overdue since " : "Due "}${fmtDate(b.next_visit_due)}</span>` : "—"}
            ${!b.paused_until ? `<div class="btns" style="margin-top:4px"><input type="date" id="n-${b.id}" value="${esc(b.next_visit_due && b.next_visit_due > today() ? b.next_visit_due : today())}" style="min-height:32px;max-width:150px" aria-label="Next visit date"><button class="btn ghost sm" data-schedule="${b.id}" data-next="1">Set date</button></div>` : ""}</td>
          <td>${b.stripe_payment_method_id ? `<button class="btn sm" data-visit="${b.id}" data-prepaid="${b.prepaid_through && b.prepaid_through >= today() ? 1 : 0}" ${b.paused_until ? "disabled" : ""}>Visit done</button>` : '<span class="err small">No card on file yet.</span>'}</td></tr>
        <tr class="vfrow" id="vf-${b.id}" hidden><td colspan="4"><div class="vfwrap"></div></td></tr>`).join("")}</tbody></table></div>`
        : '<div class="empty">Customers move here once their first visit is scheduled. After each visit, tap “Visit done”: the customer gets your service note and their card is charged.</div>'}
    </section>

    ${claims.length ? `<section class="stack"><h2>Free re-service requested</h2>${claims.map((c) => { const b = byId[c.booking_id]; return `<article class="card small"><p><b>${esc(b?.customer_name ?? "Customer")}</b> · ${esc(b?.ref ?? "")} · ${b ? prettyPhone(b.customer_phone) : ""} · opened ${fmtDate(c.created_at)} ${chip(c.status)}</p><p>“${esc(c.description)}”</p>
      <div class="btns">${c.status === "open" ? `<button class="btn ghost sm" data-claim="${c.id}" data-status="vendor_notified">I called them</button>` : ""}<button class="btn sm" data-claim="${c.id}" data-status="resolved">Re-serviced</button></div></article>`; }).join("")}</section>` : ""}

    ${reviews.length ? `<section class="stack"><h2>Recent reviews</h2><div class="reviews">${reviews.map((r) => `<div class="review">${stars(r.rating)} <span class="muted small">${esc(r.customer_label)} · ${fmtDate(r.created_at)}</span>${r.comment ? `<p>${esc(r.comment)}</p>` : ""}</div>`).join("")}</div></section>` : ""}

    <section class="stack"><div class="sechead"><h2>Payments</h2>${v.stripe_charges_enabled ? '<button class="btn ghost sm" data-stripe="dashboard">Open Stripe payouts dashboard</button>' : ""}</div>
      ${payments.length ? `<div class="tablewrap"><table class="wide"><thead><tr><th>Date</th><th>Customer</th><th>Item</th><th class="r">Value</th><th class="r">MowBrokers fee</th><th class="r">To you</th><th>Status</th></tr></thead><tbody>${payments.map((p) => `<tr><td class="num">${fmtDate(p.created_at)}</td><td>${esc(byId[p.booking_id]?.customer_name ?? "—")}</td><td>${esc(p.label)}${p.refunded_cents ? `<div class="hint">Refunded ${usdCents(p.refunded_cents)}</div>` : ""}</td><td class="r num">${usdCents(p.kind === "prepay" ? p.net_cents + p.fee_cents : p.amount_cents + p.discount_cents)}</td><td class="r num">${usdCents(p.kind === "prepay" ? p.fee_cents : p.fee_cents + p.discount_cents)}</td><td class="r num">${usdCents(p.net_cents)}</td><td>${chip(p.status)}</td></tr>`).join("")}</tbody></table></div>`
        : '<div class="empty">No payments yet. Stripe deposits your share every Friday.</div>'}
    </section></div>`;
  wire();
}

function wire() {
  $("#signout").onclick = signOut;
  $$("[data-stripe]").forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = "Opening Stripe…";
    const r = await call("portal", b.dataset.stripe === "onboard" ? "stripeOnboarding" : "stripeDashboard");
    if (r.ok) location.href = r.data.url; else { toast(r.error); b.disabled = false; b.textContent = "Try again"; }
  }));
  $$("[data-contacted]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const r = await call("portal", "markContacted", { bookingId: b.dataset.contacted });
    toast(r.ok ? "Logged. Set the first visit date once you've agreed on one." : r.error); render();
  }));
  $$("[data-schedule]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const input = b.dataset.next ? $(`#n-${b.dataset.schedule}`) : $(`#d-${b.dataset.schedule}`);
    const r = await call("portal", "schedule", { bookingId: b.dataset.schedule, date: input.value });
    toast(r.ok ? "Scheduled. The customer was notified." : r.error); render();
  }));
  $$("[data-visit]").forEach((b) => (b.onclick = () => {
    const row = $(`#vf-${b.dataset.visit}`);
    row.hidden = !row.hidden;
    if (!row.hidden) mountVisitForm(row.querySelector(".vfwrap"), { fn: "portal", bookingId: b.dataset.visit, prepaid: b.dataset.prepaid === "1", onDone: render });
  }));
  $$("[data-retry]").forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = "Retrying…";
    const r = await call("portal", "retryPayment", { paymentId: b.dataset.retry });
    toast(r.ok ? "Charged." : r.error); render();
  }));
  $$("[data-claim]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const r = await call("portal", "claim", { claimId: b.dataset.claim, status: b.dataset.status });
    toast(r.ok ? "Updated." : r.error); render();
  }));
}
render();
