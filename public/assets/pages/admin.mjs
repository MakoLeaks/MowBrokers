import { $, $$, sb, esc, usd, usdAuto, usdCents, call, chip, fmtDate, prettyPhone, daysSince, daysUntil, today, checksFor, CATEGORY_LABEL, requireSession, myRole, signOut, toast, getSettings, rateCardFields, readRateCard, stars, config } from "../core.mjs";
import { bestMatchKey, itemLabel, matchVendors } from "../pricing.mjs";
import { mountVisitForm } from "../visitform.mjs";

const root = $("#admin-root");
const sess = await requireSession();
if ((await myRole(sess.user.id)) !== "admin") { root.innerHTML = `<div class="empty">The operator console is for the MowBrokers team. <a class="btn ghost sm" href="portal.html">Go to your portal</a></div>`; throw new Error("not admin"); }

const TABS = [["overview", "Overview"], ["bookings", "Bookings"], ["providers", "Providers"], ["scorecards", "Scorecards"], ["metrics", "Metrics"], ["payments", "Payments"], ["claims", "Re-service"], ["reviews", "Reviews"], ["settings", "Settings"]];
const st = { bf: "open", pf: "pipeline", q: "", month: today().slice(0, 7) };
const SPEC = (b) => ({ acres: b.yard.acres, zip: b.zip, terrain: b.yard.terrain, coverage: b.yard.coverage, plan: b.plan, fert: b.addons.fert, aerate: b.addons.aerate, leaves: b.addons.leaves, shrubs: b.addons.shrubs, custom: b.custom });
const link = (b) => `${location.href.replace(/[^/]*$/, "")}booking.html?ref=${encodeURIComponent(b.ref)}&t=${encodeURIComponent(b.access_token)}`;
const act = async (action, payload, okMsg) => { const r = await call("admin", action, payload); toast(r.ok ? okMsg || "Done." : r.error); if (r.ok) route(); return r; };
const scoreChip = (n) => n == null ? '<span class="score">—</span>' : `<span class="score ${n >= 80 ? "hi" : n >= 60 ? "mid" : "lo"}">${n}</span>`;
const WINDOW = { morning: "mornings", afternoon: "afternoons", any: "any time" };
let scoreCache = null;
async function scores() { if (!scoreCache) { const { data } = await sb.rpc("vendor_scorecards"); scoreCache = Object.fromEntries((data ?? []).map((r) => [r.vendor_id, r])); } return scoreCache; }

function shell(tab, inner) {
  const top = tab.startsWith("booking-") ? "bookings" : tab.startsWith("provider-") ? "providers" : tab;
  root.innerHTML = `<div class="sechead"><div><p class="eyebrow">Operator console</p><h1 style="margin-top:4px">MowBrokers operations</h1></div><div class="btns"><a class="btn ghost sm" href="index.html">View site</a><button class="btn ghost sm" id="signout">Sign out</button></div></div>
    <nav class="subnav" aria-label="Console">${TABS.map(([k, l]) => `<a href="#${k}" ${k === top ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav><div id="tab">${inner}</div>`;
  $("#signout").onclick = signOut;
}

function businessNumbers(bookings, payments, s) {
  const active = bookings.filter((b) => ["active", "scheduled"].includes(b.status) && b.plan !== "One-time cut");
  const recurring = active.reduce((t, b) => t + (b.quote?.annual ?? 0), 0);
  const cancelled30 = bookings.filter((b) => b.status === "cancelled" && b.vendor_id && daysSince(b.cancelled_at) <= 30).length;
  const churn = active.length + cancelled30 ? cancelled30 / (active.length + cancelled30) : 0;
  const fees12 = payments.filter((p) => p.status === "succeeded" && daysSince(p.created_at) <= 365).reduce((t, p) => t + p.fee_cents, 0);
  return { active, recurring, mrr: recurring / 12, churn, arpu: active.length ? recurring / active.length : 0, feeRun: recurring * s.takeRate, fees12 };
}

async function overview() {
  const [s, bk, vd, cl, py, rv] = await Promise.all([getSettings(), sb.from("bookings").select("*").order("created_at", { ascending: false }).limit(2000), sb.from("vendors").select("*"), sb.from("claims").select("*").neq("status", "resolved"), sb.from("payments").select("*").order("created_at", { ascending: false }).limit(3000), sb.from("reviews").select("*").order("created_at", { ascending: false }).limit(200)]);
  const bookings = bk.data ?? [], vendors = vd.data ?? [], claims = cl.data ?? [], payments = py.data ?? [], reviews = rv.data ?? [];
  const vName = (id) => vendors.find((v) => v.id === id)?.business ?? "provider";
  const n = businessNumbers(bookings.filter((b) => b.status !== "pending_card"), payments, s);
  const ok = payments.filter((p) => p.status === "succeeded");
  const live = vendors.filter((v) => v.status === "approved" && v.stripe_charges_enabled);
  const avgRating = reviews.filter((r) => !r.hidden).length ? reviews.filter((r) => !r.hidden).reduce((t, r) => t + r.rating, 0) / reviews.filter((r) => !r.hidden).length : null;
  const q = [];
  bookings.filter((b) => b.status === "new").forEach((b) => q.push([0, `No pro matched ${b.customer_name} (${b.ref})`, `${b.plan} · ${b.yard.acres} acres · ZIP ${b.zip} · waiting ${daysSince(b.created_at)}d`, `#booking-${b.id}`]));
  bookings.filter((b) => b.status === "matched" && !b.contacted_at && b.respond_by && new Date(b.respond_by) - Date.now() < 4 * 3600000).forEach((b) => q.push([0, `${vName(b.vendor_id)} hasn't called ${b.customer_name} (${b.ref})`, `Deadline ${new Date(b.respond_by).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}. Auto-reassigns after that.`, `#booking-${b.id}`]));
  claims.filter((c) => c.status === "open").forEach((c) => q.push([0, "Re-service request", c.description, "#claims"]));
  payments.filter((p) => p.status === "failed" && daysSince(p.created_at) <= 21).forEach((p) => q.push([0, `${p.kind === "prepaid_visit" ? "Payout" : "Card"} failed: ${p.label} ${usdCents(p.amount_cents)}`, p.failure_message ?? "", `#booking-${p.booking_id}`]));
  reviews.filter((r) => r.rating <= 2 && daysSince(r.created_at) <= 14).forEach((r) => q.push([0, `${r.rating}-star review for ${vName(r.vendor_id)}`, r.comment || "(no comment)", `#booking-${r.booking_id}`]));
  bookings.filter((b) => ["active"].includes(b.status) && !b.paused_until && b.next_visit_due && daysUntil(b.next_visit_due) < -14).forEach((b) => q.push([1, `Overdue visit: ${b.customer_name} (${b.ref})`, `Due ${fmtDate(b.next_visit_due)} with ${vName(b.vendor_id)}`, `#booking-${b.id}`]));
  bookings.filter((b) => b.status === "matched" && b.contacted_at && daysSince(b.contacted_at) >= 3).forEach((b) => q.push([1, `${b.ref} with ${vName(b.vendor_id)} not scheduled`, `Called ${daysSince(b.contacted_at)} days ago, no first visit yet.`, `#booking-${b.id}`]));
  bookings.filter((b) => b.status === "pending_card" && daysSince(b.created_at) >= 1 && daysSince(b.created_at) <= 14).forEach((b) => q.push([2, `${b.customer_name} didn't finish booking (${b.ref})`, `Chose ${vName(b.vendor_id)} but never saved a card. Worth a call: ${prettyPhone(b.customer_phone)}`, `#booking-${b.id}`]));
  vendors.filter((v) => ["applied", "vetting"].includes(v.status)).forEach((v) => q.push([1, `Vet ${v.business}`, `${checksFor(v.categories).filter(([k]) => v.checklist?.[k]).length} of ${checksFor(v.categories).length} checks · applied ${fmtDate(v.created_at)}${v.coi_path ? " · certificate uploaded" : ""}`, `#provider-${v.id}`]));
  vendors.filter((v) => v.status === "approved" && !v.stripe_charges_enabled).forEach((v) => q.push([1, `${v.business} approved but not live`, "Stripe payouts aren't active yet, so customers can't see them.", `#provider-${v.id}`]));
  vendors.filter((v) => v.status === "approved" && daysUntil(v.insurance_expires) <= 30).forEach((v) => q.push([1, `${v.business} insurance ${daysUntil(v.insurance_expires) < 0 ? "expired (hidden from customers)" : "expires " + fmtDate(v.insurance_expires)}`, "Get a new certificate.", `#provider-${v.id}`]));
  q.sort((a, b) => a[0] - b[0]);
  return `<div class="stack-lg">
    <div class="kpis">${[["Active recurring customers", n.active.length, `Goal ${s.goalPairs}`], ["Monthly recurring revenue", usd(n.mrr), `${usd(n.feeRun / 12)} / mo to MowBrokers`], ["Churn, last 30 days", `${(n.churn * 100).toFixed(1)}%`, "Cancellations ÷ customers"], ["Revenue per customer", usd(n.arpu), "Per season"], ["Live providers", live.length, `${vendors.filter((v) => ["applied", "vetting"].includes(v.status)).length} in vetting · target 10–15`], ["Average rating", avgRating ? avgRating.toFixed(2) : "—", `${reviews.length} reviews`], ["Fees collected", usdCents(ok.reduce((t, p) => t + p.fee_cents, 0)), `${ok.length} payments`]].map(([l, v, sub]) => `<div class="kpi"><span class="l">${l}</span><span class="v">${v}</span><span class="hint">${sub}</span></div>`).join("")}</div>
    <div class="bar" aria-hidden="true"><i style="width:${Math.min(100, (n.active.length / s.goalPairs) * 100)}%"></i></div>
    <section class="stack"><div class="sechead"><h2>Needs you</h2><span class="muted small">${q.length} item${q.length === 1 ? "" : "s"}</span></div>
      ${q.length ? `<div class="queue">${q.map(([, t, d, h]) => `<div class="qi"><div class="t"><b>${esc(t)}</b><span class="muted small">${esc(d)}</span></div><a class="btn ghost sm" href="${h}">Open</a></div>`).join("")}</div>` : '<div class="empty">You\'re caught up. Unmatched bookings, missed call deadlines, failed cards, low ratings, applications and re-service requests land here.</div>'}</section></div>`;
}

const BF = [["open", "Open", ["new", "matched", "scheduled"]], ["new", "Needs manual match", ["new"]], ["pending_card", "Unfinished", ["pending_card"]], ["matched", "Awaiting call", ["matched"]], ["active", "Active", ["active"]], ["completed", "Completed", ["completed"]], ["cancelled", "Cancelled", ["cancelled"]], ["all", "All", null]];
async function bookingsTab() {
  const f = BF.find((x) => x[0] === st.bf) ?? BF[0];
  let query = sb.from("bookings").select("*, vendors(business)").order("created_at", { ascending: false }).limit(300);
  if (f[2]) query = query.in("status", f[2]);
  const term = st.q.replace(/[%,()*]/g, "").trim();
  if (term) query = query.or(`ref.ilike.%${term}%,customer_name.ilike.%${term}%,zip.eq.${term.replace(/\D/g, "").slice(0, 5) || "00000"}`);
  const { data } = await query;
  const rows = data ?? [];
  return `<div class="stack"><div class="sechead"><div class="filters" role="group" aria-label="Filter bookings">${BF.map(([k, l]) => `<button type="button" data-bf="${k}" aria-pressed="${f[0] === k}">${l}</button>`).join("")}</div>
    <form id="bsearch" class="btns" style="gap:8px"><label for="bq" class="hp">Search</label><input type="text" id="bq" value="${esc(st.q)}" placeholder="Ref, name or ZIP" style="min-height:36px;width:220px"><button class="btn ghost sm">Search</button></form></div>
    ${rows.length ? `<div class="tablewrap"><table class="wide"><thead><tr><th>Ref</th><th>Customer</th><th>ZIP</th><th>Plan</th><th class="r">Season</th><th>Status</th><th>Provider</th><th>Next / created</th></tr></thead><tbody>
      ${rows.map((b) => `<tr><td class="num"><a href="#booking-${b.id}"><b>${esc(b.ref)}</b></a></td><td>${esc(b.customer_name)}</td><td class="num">${esc(b.zip)}</td><td>${esc(b.plan)}${b.prepay ? " · prepay" : ""} · ${esc(b.yard.acres)} ac${b.custom.length ? " · +quote" : ""}</td><td class="r num">${b.quote ? usd(b.quote.annual) : "—"}</td><td>${chip(b.status)}${b.paused_until ? ' <span class="chip c-new">paused</span>' : ""}</td><td>${esc(b.vendors?.business ?? "—")}${b.chosen_by_customer ? '<div class="hint">Customer\'s pick</div>' : ""}</td><td class="num">${b.next_visit_due ? `<span class="${daysUntil(b.next_visit_due) < 0 ? "err" : ""}">due ${fmtDate(b.next_visit_due)}</span>` : fmtDate(b.created_at)}</td></tr>`).join("")}
    </tbody></table></div>` : '<div class="empty">No bookings in this view.</div>'}</div>`;
}

async function bookingDetail(id) {
  const { data: b } = await sb.from("bookings").select("*").eq("id", id).maybeSingle();
  if (!b) return '<div class="empty">Booking not found. <a href="#bookings">Back to bookings</a></div>';
  const [vd, py, cl, vs, ev, rv] = await Promise.all([b.vendor_id ? sb.from("vendors").select("id,business,phone,email,stripe_charges_enabled").eq("id", b.vendor_id).maybeSingle() : Promise.resolve({ data: null }),
    sb.from("payments").select("*").eq("booking_id", b.id).order("created_at", { ascending: false }), sb.from("claims").select("*").eq("booking_id", b.id).order("created_at", { ascending: false }),
    sb.from("visits").select("*").eq("booking_id", b.id).order("visit_date", { ascending: false }), sb.from("booking_events").select("*, vendors(business)").eq("booking_id", b.id).order("created_at", { ascending: false }).limit(60),
    sb.from("reviews").select("*").eq("booking_id", b.id).maybeSingle()]);
  const v = vd.data, x = b.quote, events = ev.data ?? [];
  const canAssign = ["new", "pending_card", "matched"].includes(b.status);
  let cands = [];
  if (canAssign) {
    const missed = new Set(events.filter((e) => e.type === "sla_miss").map((e) => e.vendor_id));
    const [s, pv, sc] = await Promise.all([getSettings(), sb.from("public_vendors").select("*"), scores()]);
    cands = matchVendors(s, (pv.data ?? []).filter((c) => !missed.has(c.id)), SPEC(b)).matches.map((m) => ({ ...m, sc: sc[m.v.id], key: bestMatchKey(m.x.annual, sc[m.v.id]?.score) })).sort((a, c) => a.key - c.key);
  }
  const visitable = ["matched", "scheduled", "active"].includes(b.status) && x && b.stripe_payment_method_id && v?.stripe_charges_enabled;
  const btn = (action, label, cls = "btn sm", extra = "", confirm = "") => `<button class="${cls}" data-act="${action}" ${extra} ${confirm ? `data-confirm="${esc(confirm)}"` : ""}>${label}</button>`;
  const prepaidActive = b.prepaid_through && b.prepaid_through > today();
  return `<div class="grid2"><div class="stack-lg">
    <div class="btns"><a class="btn ghost sm" href="#bookings">← Bookings</a><h2>${esc(b.ref)} · ${esc(b.customer_name)}</h2>${chip(b.status)}${b.paused_until ? `<span class="chip c-new">Paused until ${fmtDate(b.paused_until)}</span>` : ""}</div>
    <dl class="kv">
      <dt>Phone</dt><dd>${prettyPhone(b.customer_phone)} ${b.sms_consent ? "· texts OK" : "· no texts"}</dd><dt>Email</dt><dd>${esc(b.customer_email ?? "—")}${b.marketing_opt_out ? " · no offers" : ""}</dd>
      <dt>Address</dt><dd>${esc(b.street)}, ${esc(b.zip)}</dd><dt>Yard</dt><dd>${esc(b.yard.acres)} acres · ${esc(b.yard.terrain)} · ${esc(b.yard.coverage)}</dd>
      <dt>Plan</dt><dd>${esc(b.plan)}${b.prepay ? (prepaidActive ? ` · prepaid through ${fmtDate(b.prepaid_through)}` : " · prepay at next visit") : ""}</dd>
      <dt>Visits</dt><dd>${b.preferred_start ? `wants ${fmtDate(b.preferred_start)}${b.preferred_alt ? " or " + fmtDate(b.preferred_alt) : ""}, ${WINDOW[b.visit_window]}` : WINDOW[b.visit_window]}${b.first_visit ? ` · first ${fmtDate(b.first_visit)}` : ""}${b.next_visit_due ? ` · next due ${fmtDate(b.next_visit_due)}` : ""}</dd>
      ${b.status === "matched" ? `<dt>Call deadline</dt><dd>${b.contacted_at ? `Called ${fmtDate(b.contacted_at)}` : b.respond_by ? new Date(b.respond_by).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</dd>` : ""}
      <dt>Add-ons</dt><dd>${[b.addons.fert && "Fertilizer and weed control", b.addons.aerate && "Core aeration", b.addons.leaves && "Leaf cleanup", b.addons.shrubs && `Shrub trimming ×${b.addons.shrubs}`].filter(Boolean).join(", ") || "None"}</dd>
      ${b.custom.length ? `<dt>Quote on site</dt><dd>${esc(b.custom.join(", "))}</dd>` : ""}
      <dt>Card</dt><dd>${b.stripe_payment_method_id ? "On file" : "Not added"}${b.credit_cents ? ` · ${usdCents(b.credit_cents)} credit` : ""}</dd>
      ${x ? `<dt>Locked price</dt><dd class="num">${x.perVisit ? `${usdAuto(x.perVisit)} per cut · ` : ""}${usd(x.annual)} ${b.plan === "One-time cut" ? "total" : "season"} · ${Math.round((x.takeRate ?? 0) * 100)}% fee${x.prepay ? ` · prepay ${usd(x.prepay)}` : ""}</dd>` : ""}
      <dt>Referral</dt><dd class="num">${esc(b.referral_code ?? "—")}${b.referred_by ? ` · referred by ${esc(b.referred_by)}` : ""}</dd>
      ${rv.data ? `<dt>Review</dt><dd>${stars(rv.data.rating)} ${esc(rv.data.comment)}</dd>` : ""}
      <dt>Customer link</dt><dd class="small">${esc(link(b))}</dd></dl>
    ${b.notes ? `<p class="small"><b>Customer says:</b> ${esc(b.notes)}</p>` : ""}
    ${b.cancel_reason ? `<p class="small"><b>Cancelled by ${esc(b.cancelled_by ?? "")}:</b> ${esc(b.cancel_reason)}</p>` : ""}
    ${v ? `<div class="panel small"><b><a href="#provider-${v.id}">${esc(v.business)}</a></b><span>${prettyPhone(v.phone)} · ${esc(v.email)}</span>${!v.stripe_charges_enabled ? '<span class="err">Stripe payouts not active, so visits can\'t be billed.</span>' : ""}</div>` : ""}
    ${b.status === "matched" ? `<div class="btns" style="align-items:end">${!b.contacted_at ? btn("contacted", "Mark called", "btn ghost sm") : ""}<label for="sdate">First visit<input type="date" id="sdate" value="${esc(b.preferred_start || today())}"></label>${btn("schedule", "Mark scheduled")}</div>` : ""}
    ${["scheduled", "active"].includes(b.status) ? `<div class="btns" style="align-items:end"><label for="sdate">Next visit<input type="date" id="sdate" value="${esc(b.next_visit_due && b.next_visit_due > today() ? b.next_visit_due : today())}"></label>${btn("schedule", "Set date", "btn ghost sm")}</div>` : ""}
    ${visitable ? `<div class="btns"><button class="btn alt sm" id="logvisit">Log a visit</button></div><div id="vfbox" class="card" hidden></div>` : ""}
    <div class="btns">${b.vendor_id && ["matched", "scheduled", "pending_card"].includes(b.status) ? btn("release", "Release provider", "btn ghost sm", "", "Confirm: back to manual match") : ""}</div>
    ${(vs.data ?? []).length ? `<section class="stack"><h3>Visits</h3><div class="visits">${vs.data.map((x2) => `<article class="visit"><div class="sechead"><b>${fmtDate(x2.visit_date)}</b><span class="muted small">${esc(x2.items.map((k) => itemLabel(k, b.plan)).join(" + "))} · ${esc(x2.logged_by)}</span></div><p class="small">${esc(x2.notes)}</p>${x2.photo_path ? `<button class="linkbtn small" data-photo="${x2.id}">View photo</button>` : ""}</article>`).join("")}</div></section>` : ""}
    ${(py.data ?? []).length ? `<section class="stack"><h3>Payments</h3><div class="tablewrap"><table><thead><tr><th>Date</th><th>Item</th><th class="r">Amount</th><th class="r">Fee</th><th>Status</th><th></th></tr></thead><tbody>${py.data.map((p) => `<tr><td class="num">${fmtDate(p.created_at)}</td><td>${esc(p.label)}${p.kind === "prepaid_visit" ? '<div class="hint">Payout from prepay</div>' : ""}${p.discount_cents ? `<div class="hint">${usdCents(p.discount_cents)} credit</div>` : ""}${p.refunded_cents ? `<div class="hint">${usdCents(p.refunded_cents)} refunded</div>` : ""}${p.failure_message ? `<div class="err small">${esc(p.failure_message)}</div>` : ""}</td><td class="r num">${usdCents(p.amount_cents)}</td><td class="r num">${usdCents(p.fee_cents)}</td><td>${chip(p.status)}</td>
      <td>${p.status === "failed" ? `<button class="btn ghost sm" data-retry="${p.id}">Retry</button>` : p.status === "succeeded" && p.kind !== "prepaid_visit" && p.amount_cents - p.refunded_cents >= 50 ? `<form class="btns refund" data-refund="${p.id}" style="gap:4px"><input type="number" step="0.01" min="0.5" max="${((p.amount_cents - p.refunded_cents) / 100).toFixed(2)}" value="${((p.amount_cents - p.refunded_cents) / 100).toFixed(2)}" aria-label="Refund amount" style="min-height:30px;width:90px"><button class="btn ghost sm">Refund</button></form>` : ""}</td></tr>`).join("")}</tbody></table></div><p class="hint">Refunds on visit charges take back the provider's share and your fee proportionally. Refunding a prepay returns unused money from your balance.</p></section>` : ""}
    <section class="stack"><h3>Credit</h3><form id="creditform" class="btns" style="align-items:end"><label for="credamt">Add credit ($)<input type="number" id="credamt" min="1" max="500" step="1" value="25" style="width:110px"></label><label for="credwhy">Reason<input type="text" id="credwhy" maxlength="200" placeholder="Missed appointment"></label><label class="check small"><input type="checkbox" id="crednotify" checked> Email customer</label><button class="btn ghost sm">Add credit</button></form><p class="hint">Credits come off MowBrokers' fee on future charges, so the provider's share never changes.</p></section>
    <section class="stack"><h3>Re-service</h3>${(cl.data ?? []).map((c) => `<p class="small">${chip(c.status)} ${fmtDate(c.created_at)}: ${esc(c.description)}</p>`).join("")}
      ${b.vendor_id ? `<label for="claimtxt">What did the customer report?<textarea id="claimtxt"></textarea></label><div>${btn("logClaim", "Log re-service", "btn ghost sm")}</div>` : ""}</section>
    ${!["cancelled", "completed"].includes(b.status) ? `<details class="card"><summary>Cancel booking</summary><form id="cancelform" style="gap:10px;margin-top:10px"><label for="cancelwhy">Reason<input type="text" id="cancelwhy" maxlength="300" required></label><p class="small" id="cancelrefund"></p><div><button class="btn danger sm">Cancel booking</button></div></form></details>` : ""}
    ${events.length ? `<section class="stack"><h3>Timeline</h3><ul class="small" style="margin:0;padding-left:18px;display:grid;gap:3px">${events.map((e) => `<li><span class="num muted">${new Date(e.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> · <b>${esc(e.type.replace(/_/g, " "))}</b>${e.vendors?.business ? ` · ${esc(e.vendors.business)}` : ""}${e.detail ? ` · ${esc(e.detail)}` : ""}</li>`).join("")}</ul></section>` : ""}
  </div>
  <aside class="stack">${canAssign ? `<div class="card"><h3>${b.vendor_id ? "Reassign to a qualifying pro" : "Suggested pros"}</h3>
    ${cands.length ? cands.slice(0, 6).map(({ v: c, x: cx, sc }, i) => `<div class="qi" style="${i === 0 ? "border-color:var(--accent)" : ""}"><div class="t"><b>${i === 0 ? "★ " : ""}${esc(c.business)}</b><span class="hint num">${usd(cx.annual)} season${cx.perVisit ? ` · ${usdAuto(cx.perVisit)} per cut` : ""}</span><span class="hint">Score ${sc?.score ?? "—"}${sc?.reviews ? ` · ${Number(sc.rating).toFixed(1)}★ (${sc.reviews})` : ""}${sc?.resp_hours != null ? ` · calls in ~${sc.resp_hours}h` : ""}</span></div>${c.id !== b.vendor_id ? `<button class="btn sm" data-act="assign" data-vendor="${c.id}">Assign</button>` : '<span class="hint">Current</span>'}</div>`).join("")
      : `<p class="panel small">No live provider qualifies for ZIP ${esc(b.zip)} with these services. Recruit one or widen a provider's ZIP list.</p>`}
    <p class="hint">Ranked by price and provider score. Pros who missed this customer's call deadline are left out. Assigning locks that pro's price; if no card is on file, the customer gets an email to confirm.</p></div>` : ""}</aside></div>`;
}

const PF = [["pipeline", "In vetting", ["applied", "vetting"]], ["approved", "Approved", ["approved"]], ["suspended", "Suspended", ["suspended"]], ["rejected", "Rejected", ["rejected"]], ["all", "All", null]];
async function providersTab() {
  const f = PF.find((x) => x[0] === st.pf) ?? PF[0];
  let query = sb.from("vendors").select("*").order("created_at", { ascending: false });
  if (f[2]) query = query.in("status", f[2]);
  const [rows, sc] = [(await query).data ?? [], await scores()];
  return `<div class="stack"><div class="filters" role="group" aria-label="Filter providers">${PF.map(([k, l]) => `<button type="button" data-pf="${k}" aria-pressed="${f[0] === k}">${l}</button>`).join("")}</div>
    ${rows.length ? `<div class="tablewrap"><table class="wide"><thead><tr><th>Provider</th><th>Score</th><th>Categories</th><th class="r">¼–½ acre cut</th><th>Vetting</th><th>Stripe</th><th>Insurance</th><th>Status</th></tr></thead><tbody>
      ${rows.map((v) => `<tr><td><a href="#provider-${v.id}"><b>${esc(v.business)}</b></a><div class="hint">${esc(v.contact)} · ${v.zips.length} ZIPs</div></td><td>${scoreChip(sc[v.id]?.score)}</td><td>${esc(v.categories.join(", "))}</td><td class="r num">${usd(v.rate_card?.mowTiers?.[1] ?? 0)}</td><td class="num">${checksFor(v.categories).filter(([k]) => v.checklist?.[k]).length}/${checksFor(v.categories).length}${v.coi_path ? " · COI" : ""}</td><td>${v.stripe_charges_enabled ? chip("approved", "Payouts on") : chip("applied", v.stripe_account_id ? "In progress" : "Not started")}</td><td class="${daysUntil(v.insurance_expires) < 30 ? "err" : ""}">${fmtDate(v.insurance_expires)}</td><td>${chip(v.status)}</td></tr>`).join("")}
    </tbody></table></div>` : '<div class="empty">No providers here yet. Applications from the provider sign-up appear in vetting.</div>'}</div>`;
}

async function providerDetail(id) {
  const { data: v } = await sb.from("vendors").select("*").eq("id", id).maybeSingle();
  if (!v) return '<div class="empty">Provider not found. <a href="#providers">Back to providers</a></div>';
  const [s, stats, sc] = await Promise.all([getSettings(), sb.from("bookings").select("id", { count: "exact", head: true }).eq("vendor_id", v.id).in("status", ["scheduled", "active", "completed"]), scores()]);
  const c = sc[v.id] ?? {};
  const CHECKS = checksFor(v.categories);
  const done = CHECKS.filter(([k]) => v.checklist?.[k]).length;
  return `<div class="grid2" style="grid-template-columns:minmax(0,1fr) minmax(0,1.2fr)"><div class="stack-lg">
    <div class="btns"><a class="btn ghost sm" href="#providers">← Providers</a><h2>${esc(v.business)}</h2>${chip(v.status)} ${scoreChip(c.score)}</div>
    <div class="btns">${v.status === "approved" ? `<a class="btn ghost sm" href="pro.html?slug=${encodeURIComponent(v.slug)}">Public profile</a>` : ""}${v.coi_path ? '<button class="btn ghost sm" data-act="coi">Open insurance certificate</button>' : ""}</div>
    <dl class="kv"><dt>Contact</dt><dd>${esc(v.contact)} · ${prettyPhone(v.phone)} · ${esc(v.email)}</dd>
      <dt>License</dt><dd>${esc(v.license)} <a class="small" href="https://agi.alabama.gov/pesticidemanagement/" target="_blank" rel="noreferrer">ADAI Pesticide Management</a></dd>
      <dt>Certified operator</dt><dd>${esc(v.operator || "—")}</dd><dt>Categories</dt><dd>${esc(v.categories.map((c2) => CATEGORY_LABEL[c2] || c2).join(", "))}</dd>
      <dt>Insurance</dt><dd>${esc(v.insurance_carrier)} · ${usd(v.insurance_coverage)} · expires ${fmtDate(v.insurance_expires)}</dd>
      <dt>Size</dt><dd>${esc(v.years)} yrs · ${esc(v.techs)} crew</dd><dt>ZIPs</dt><dd class="num">${esc(v.zips.join(", "))}</dd>
      <dt>Quoted jobs</dt><dd>${esc(v.custom_jobs.join(", ") || "None")}</dd>
      <dt>Stripe</dt><dd>${v.stripe_charges_enabled ? "Payouts active" : v.stripe_account_id ? "Onboarding started, not finished" : "Not started"}</dd>
      <dt>Scorecard</dt><dd>${c.reviews ? `${Number(c.rating).toFixed(2)}★ from ${c.reviews}` : "No reviews"} · ${c.resp_hours != null ? `calls in ~${c.resp_hours}h` : "no calls logged"} · ${c.sla_misses ?? 0} missed deadline(s) of ${(c.matches ?? 0) + (c.sla_misses ?? 0)} · re-service ${c.reservice_rate != null ? (c.reservice_rate * 100).toFixed(1) + "%" : "—"} · ${c.cancels ?? 0} cancellations</dd>
      <dt>Customers</dt><dd>${stats.count ?? 0}</dd><dt>Applied</dt><dd>${fmtDate(v.created_at)}${v.approved_at ? ` · approved ${fmtDate(v.approved_at)}` : ""}</dd></dl>
    <section class="card"><h3>Vetting checklist · ${done}/${CHECKS.length}</h3>
      ${CHECKS.map(([k, l]) => `<label class="check"><input type="checkbox" data-check="${k}" ${v.checklist?.[k] ? "checked" : ""}> ${l}</label>`).join("")}
      <div class="btns">${!["approved", "rejected"].includes(v.status) ? '<button class="btn sm" data-act="status" data-status="approved" data-confirm="Confirm approval">Approve</button>' : ""}${v.status === "approved" ? '<button class="btn danger sm" data-act="status" data-status="suspended" data-confirm="Confirm suspend">Suspend</button>' : ""}${["suspended", "rejected"].includes(v.status) ? '<button class="btn ghost sm" data-act="status" data-status="vetting">Move back to vetting</button>' : ""}${["applied", "vetting"].includes(v.status) ? '<button class="btn danger sm" data-act="status" data-status="rejected" data-confirm="Confirm reject">Reject</button>' : ""}</div>
      <p class="hint">Approved providers appear to customers once their Stripe payouts are active and their insurance is current.</p></section>
  </div>
  <section class="card"><h3>Prices and profile</h3><form id="vedit" novalidate style="gap:14px">${rateCardFields(s.lots, v.rate_card, "vr")}
    <label for="insexp">Insurance expires (verified)<input type="date" id="insexp" name="insexp" value="${esc(v.insurance_expires)}" style="max-width:220px"></label>
    <label for="about">Public description<textarea id="about" name="about">${esc(v.about)}</textarea></label>
    <label for="notes">Internal notes (never shown to the provider or customers)<textarea id="notes" name="notes">${esc(v.notes)}</textarea></label>
    <div><button class="btn sm">Save provider</button></div></form></section></div>`;
}

async function scorecardsTab() {
  const [{ data: vs }, sc] = await Promise.all([sb.from("vendors").select("id,business,status").in("status", ["approved", "suspended"]), scores()]);
  const rows = (vs ?? []).map((v) => ({ v, c: sc[v.id] ?? {} })).sort((a, b) => (b.c.score ?? 0) - (a.c.score ?? 0));
  return `<div class="stack"><p class="muted small">Score (0–100) = 40% rating (new pros start at 4★) + 25% response time + 15% call deadlines kept + 20% re-service rate. It sets “Best match” order in search results and your suggested matches.</p>
    ${rows.length ? `<div class="tablewrap"><table class="wide"><thead><tr><th>Provider</th><th>Score</th><th>Rating</th><th class="r">Avg. time to call</th><th class="r">Missed deadlines</th><th class="r">Re-service rate</th><th class="r">Cancellations</th><th class="r">Active</th></tr></thead><tbody>
      ${rows.map(({ v, c }) => `<tr><td><a href="#provider-${v.id}"><b>${esc(v.business)}</b></a>${v.status !== "approved" ? ` ${chip(v.status)}` : ""}</td><td>${scoreChip(c.score)}</td><td>${c.reviews ? `${stars(c.rating)} <span class="num small">${Number(c.rating).toFixed(2)} (${c.reviews})</span>` : '<span class="hint">none</span>'}</td><td class="r num">${c.resp_hours != null ? c.resp_hours + " h" : "—"}</td><td class="r num">${c.sla_misses ?? 0} / ${(c.matches ?? 0) + (c.sla_misses ?? 0)}</td><td class="r num">${c.reservice_rate != null ? (c.reservice_rate * 100).toFixed(1) + "%" : "—"}</td><td class="r num">${c.cancels ?? 0}</td><td class="r num">${c.active ?? 0}</td></tr>`).join("")}
    </tbody></table></div>` : '<div class="empty">Scorecards appear once providers are approved.</div>'}</div>`;
}

async function metricsTab() {
  const [s, bk, py, mm, rf] = await Promise.all([getSettings(), sb.from("bookings").select("*").neq("status", "pending_card").limit(5000), sb.from("payments").select("*").limit(10000), sb.rpc("monthly_metrics", { p_months: 12 }), sb.from("referrals").select("status")]);
  const bookings = bk.data ?? [], rows = mm.data ?? [];
  const n = businessNumbers(bookings, py.data ?? [], s);
  const prepay = n.active.filter((b) => b.prepaid_through && b.prepaid_through > today()).length;
  const max = Math.max(1, ...rows.map((r) => r.fee_cents));
  const plans = ["Weekly", "Every two weeks", "One-time cut", "No mowing"].map((p) => [p, bookings.filter((b) => b.plan === p && b.status !== "cancelled").length]);
  const reasons = {}; bookings.filter((b) => b.cancel_reason).forEach((b) => (reasons[b.cancel_reason] = (reasons[b.cancel_reason] ?? 0) + 1));
  return `<div class="stack-lg">
    <div class="kpis">${[["Monthly recurring revenue", usd(n.mrr)], ["Your fee run-rate / yr", usd(n.feeRun)], ["Fees, last 12 months", usdCents(n.fees12)], ["Revenue per customer / yr", usd(n.arpu)], ["Churn, last 30 days", `${(n.churn * 100).toFixed(1)}%`], ["On season prepay", `${prepay} of ${n.active.length}`], ["Referrals earned", (rf.data ?? []).filter((r) => r.status === "earned").length]].map(([l, v]) => `<div class="kpi"><span class="l">${l}</span><span class="v">${v}</span></div>`).join("")}</div>
    <section class="card"><h3>MowBrokers fees by month</h3><div class="mini-bars" role="img" aria-label="Fees by month">${rows.map((r) => `<div class="b"><span class="num">${r.fee_cents ? usd(r.fee_cents / 100) : ""}</span><i style="height:${Math.round((r.fee_cents / max) * 80)}px"></i><span>${new Date(r.month + "T12:00:00").toLocaleDateString("en-US", { month: "short" })}</span></div>`).join("")}</div></section>
    <section class="stack"><h3>By month</h3><div class="tablewrap"><table class="wide"><thead><tr><th>Month</th><th class="r">New customers</th><th class="r">Cancellations</th><th class="r">Collected</th><th class="r">MowBrokers fees</th><th class="r">Paid to providers</th><th class="r">Refunded</th></tr></thead><tbody>
      ${[...rows].reverse().map((r) => `<tr><td>${new Date(r.month + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })}</td><td class="r num">${r.new_customers}</td><td class="r num">${r.cancellations}</td><td class="r num">${usdCents(r.collected_cents)}</td><td class="r num">${usdCents(r.fee_cents)}</td><td class="r num">${usdCents(r.payouts_cents)}</td><td class="r num">${usdCents(r.refunded_cents)}</td></tr>`).join("")}
    </tbody></table></div></section>
    <div class="grid2"><section class="card"><h3>Customers by plan</h3><dl class="kv">${plans.map(([p, c]) => `<dt>${p}</dt><dd class="num">${c}</dd>`).join("")}</dl></section>
      <section class="card"><h3>Why customers cancel</h3>${Object.keys(reasons).length ? `<dl class="kv">${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([r, c]) => `<dt>${esc(r)}</dt><dd class="num">${c}</dd>`).join("")}</dl>` : '<p class="muted small">No cancellations yet.</p>'}</section></div></div>`;
}

async function paymentsTab() {
  const start = new Date(st.month + "-01T00:00:00"), end = new Date(start); end.setMonth(end.getMonth() + 1);
  const { data } = await sb.from("payments").select("*, vendors(business), bookings(id, ref, customer_name)").gte("created_at", start.toISOString()).lt("created_at", end.toISOString()).order("created_at", { ascending: false });
  const rows = data ?? [], ok = rows.filter((p) => p.status === "succeeded"), charged = ok.filter((p) => p.kind !== "prepaid_visit");
  const sum = (arr, k) => arr.reduce((t, p) => t + p[k], 0);
  const byV = {}; ok.forEach((p) => { const k = p.vendors?.business ?? "Unknown"; byV[k] ??= { n: 0, net: 0 }; byV[k].n++; byV[k].net += p.net_cents; });
  return `<div class="stack-lg"><div class="btns" style="align-items:end"><label for="month">Month<input type="month" id="month" value="${esc(st.month)}"></label><a class="btn ghost sm" style="margin-left:auto" href="https://dashboard.stripe.com/connect/accounts/overview" target="_blank" rel="noreferrer">Stripe Connect dashboard</a></div>
    <div class="kpis">${[["Collected from customers", usdCents(sum(charged, "amount_cents"))], ["MowBrokers fees", usdCents(sum(ok, "fee_cents"))], ["Paid to providers", usdCents(sum(ok, "net_cents"))], ["Refunded", usdCents(sum(rows, "refunded_cents"))], ["Failed", rows.filter((p) => p.status === "failed").length]].map(([l, v]) => `<div class="kpi"><span class="l">${l}</span><span class="v">${v}</span></div>`).join("")}</div>
    <p class="muted small">Stripe sends each provider's share to their bank every Friday. Prepaid years sit in your Stripe balance and are paid out to the provider visit by visit.</p>
    ${Object.keys(byV).length ? `<section class="stack"><h2>By provider</h2><div class="tablewrap"><table><thead><tr><th>Provider</th><th class="r">Payments</th><th class="r">Their share</th></tr></thead><tbody>${Object.entries(byV).map(([k, o]) => `<tr><td>${esc(k)}</td><td class="r num">${o.n}</td><td class="r num">${usdCents(o.net)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
    <section class="stack"><h2>Ledger</h2>${rows.length ? `<div class="tablewrap"><table class="wide"><thead><tr><th>Date</th><th>Booking</th><th>Item</th><th>Provider</th><th class="r">Charged</th><th class="r">Fee</th><th class="r">Provider</th><th>Status</th></tr></thead><tbody>${rows.map((p) => `<tr><td class="num">${fmtDate(p.created_at)}</td><td>${p.bookings ? `<a href="#booking-${p.bookings.id}">${esc(p.bookings.ref)}</a> · ${esc(p.bookings.customer_name)}` : ""}</td><td>${esc(p.label)}${p.refunded_cents ? `<div class="hint">${usdCents(p.refunded_cents)} refunded</div>` : ""}${p.failure_message ? `<div class="err small">${esc(p.failure_message)}</div>` : ""}</td><td>${esc(p.vendors?.business ?? "—")}</td><td class="r num">${p.kind === "prepaid_visit" ? "—" : usdCents(p.amount_cents)}</td><td class="r num">${usdCents(p.fee_cents)}</td><td class="r num">${usdCents(p.net_cents)}</td><td>${chip(p.status)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No payments this month.</div>'}</section></div>`;
}

async function claimsTab() {
  const { data } = await sb.from("claims").select("*, bookings(id, ref, customer_name, customer_phone), vendors(business, phone)").order("created_at", { ascending: false }).limit(300);
  const rows = data ?? [];
  return rows.length ? `<div class="stack"><div class="tablewrap"><table class="wide"><thead><tr><th>Opened</th><th>Booking</th><th>Issue</th><th>Provider</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((c) => `<tr><td class="num">${fmtDate(c.created_at)}<div class="hint">${daysSince(c.created_at)}d ago</div></td><td>${c.bookings ? `<a href="#booking-${c.bookings.id}">${esc(c.bookings.ref)}</a><div class="hint">${esc(c.bookings.customer_name)} · ${prettyPhone(c.bookings.customer_phone)}</div>` : ""}</td><td style="max-width:300px">${esc(c.description)}</td><td>${esc(c.vendors?.business ?? "—")}<div class="hint">${c.vendors ? prettyPhone(c.vendors.phone) : ""}</div></td><td>${chip(c.status)}</td>
      <td><div class="btns">${c.status === "open" ? `<button class="btn ghost sm" data-act="claimStatus" data-claim="${c.id}" data-status="vendor_notified">Provider called</button>` : ""}${c.status !== "resolved" ? `<button class="btn sm" data-act="claimStatus" data-claim="${c.id}" data-status="resolved">Resolved</button>` : ""}</div></td></tr>`).join("")}
  </tbody></table></div><p class="hint">Re-service visits are free to the customer and unpaid to the provider.</p></div>` : '<div class="empty">No re-service requests yet.</div>';
}

async function reviewsTab() {
  const { data } = await sb.from("reviews").select("*, vendors(business), bookings(id, ref)").order("created_at", { ascending: false }).limit(300);
  const rows = data ?? [];
  return rows.length ? `<div class="stack"><p class="muted small">Reviews come only from customers who've had a visit. Hide a review only if it breaks the rules (personal information, abuse, not about the service); hidden reviews don't count toward ratings.</p><div class="tablewrap"><table class="wide"><thead><tr><th>Date</th><th>Provider</th><th>Rating</th><th>Review</th><th>Booking</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="num">${fmtDate(r.created_at)}</td><td>${esc(r.vendors?.business ?? "—")}</td><td>${stars(r.rating)}</td><td style="max-width:380px">${esc(r.comment || "—")}<div class="hint">${esc(r.customer_label)}</div></td><td>${r.bookings ? `<a href="#booking-${r.bookings.id}">${esc(r.bookings.ref)}</a>` : ""}</td><td>${r.hidden ? `<button class="btn ghost sm" data-act="hideReview" data-review="${r.id}" data-hidden="0">Show</button>` : `<button class="btn ghost sm" data-act="hideReview" data-review="${r.id}" data-hidden="1" data-confirm="Confirm hide">Hide</button>`}</td></tr>`).join("")}
  </tbody></table></div></div>` : '<div class="empty">No reviews yet. Customers are asked after their second visit.</div>';
}

async function settingsTab() {
  const [s, pv] = await Promise.all([getSettings(), sb.from("public_vendors").select("rate_card")]);
  const vendors = pv.data ?? [], e = s.extras;
  return `<div class="grid2"><form id="sform" novalidate>
    <fieldset><legend>Platform</legend><div class="row"><label for="take">Take rate (%)<input type="number" id="take" step="0.5" min="0" max="50" value="${Math.round(s.takeRate * 1000) / 10}"></label><label for="goal">Recurring customer goal<input type="number" id="goal" min="1" value="${s.goalPairs}"></label></div></fieldset>
    <fieldset><legend>Growth and service rules</legend><div class="row">
      <label for="xref">Referral credit, each side ($)<input type="number" id="xref" min="0" max="100" step="5" value="${e.referralCreditCents / 100}"></label>
      <label for="xpre">Season prepay discount (%)<input type="number" id="xpre" min="0" max="20" step="1" value="${Math.round(e.prepayDiscount * 100)}"></label>
      <label for="xresp">Provider call window (business hours)<input type="number" id="xresp" min="4" max="72" step="1" value="${e.respondHours}"></label>
      <label for="xrev">Ask for a review after visit #<input type="number" id="xrev" min="1" max="6" step="1" value="${e.reviewAfterVisits}"></label></div>
      <p class="hint">Credits come out of your fee only. The prepay discount applies to new bookings and renewals.</p></fieldset>
    <fieldset><legend>Season</legend><div class="row"><label for="sweeks">Mowing season (weeks, ${esc(s.season.label)})<input type="number" id="sweeks" min="4" max="52" step="1" value="${s.season.weeks}"></label><label for="fapps">Fertilizer program applications per year<input type="number" id="fapps" min="1" max="12" step="1" value="${s.fertApps}"></label></div>
      <p class="hint">Weekly = ${s.season.weeks} cuts; every two weeks = ${Math.round(s.season.weeks / 2)} cuts.</p></fieldset>
    <fieldset><legend>Terrain factors</legend><p class="hint" style="margin-top:-8px">Applied to every provider's prices so comparisons stay fair.</p><div class="row">${s.terrains.map((t, k) => `<label for="y${k}">${esc(t.label)}<input type="number" id="y${k}" step="0.05" min="0.3" max="3" value="${t.mult}"></label>`).join("")}</div></fieldset>
    <fieldset><legend>Coverage factors</legend><div class="row">${s.coverages.map((t, k) => `<label for="c${k}">${esc(t.label)}<input type="number" id="c${k}" step="0.05" min="0.3" max="3" value="${t.mult}"></label>`).join("")}</div></fieldset>
    <fieldset><legend>Lot add-on scales</legend><p class="hint" style="margin-top:-8px">Aeration and leaf cleanup prices × this factor by lot size.</p><div class="row">${s.lots.map((t, k) => `<label for="l${k}">${esc(t.label)}<input type="number" id="l${k}" step="0.1" min="0.3" max="20" value="${t.scale}"></label>`).join("")}</div></fieldset>
    <fieldset><legend>Suggested prices for new providers</legend>${rateCardFields(s.lots, s.suggested, "sg")}</fieldset>
    <div class="btns"><button class="btn">Save settings</button></div><p class="hint">New quotes use saved settings right away; existing bookings keep their locked prices.</p></form>
  <aside class="card"><h3>Live price spread</h3><p class="muted small">Weekly cut, flat and open, front and back.</p><div class="tablewrap"><table><thead><tr><th>Lot</th><th class="r">Low</th><th class="r">High</th></tr></thead><tbody>
    ${s.lots.map((t, k) => { const ps = vendors.map((v) => v.rate_card?.mowTiers?.[k]).filter(Boolean); return `<tr><td>${esc(t.label)}</td><td class="r num">${ps.length ? usd(Math.min(...ps)) : "—"}</td><td class="r num">${ps.length ? usd(Math.max(...ps)) : "—"}</td></tr>`; }).join("")}
  </tbody></table></div></aside></div>`;
}

function wire(tab) {
  const id = tab.split("-").slice(1).join("-");
  $$("[data-bf]").forEach((b) => (b.onclick = () => { st.bf = b.dataset.bf; route(); }));
  $$("[data-pf]").forEach((b) => (b.onclick = () => { st.pf = b.dataset.pf; route(); }));
  $("#bsearch")?.addEventListener("submit", (e) => { e.preventDefault(); st.q = $("#bq").value; route(); });
  $("#month")?.addEventListener("change", (e) => { st.month = e.target.value; route(); });
  $$("[data-check]").forEach((c) => (c.onchange = () => act("setChecklist", { vendorId: id, key: c.dataset.check, value: c.checked }, "Checklist updated.")));
  $$("[data-act]").forEach((b) => (b.onclick = async () => {
    if (b.dataset.confirm && !b.dataset.armed) { b.dataset.armed = "1"; b.textContent = b.dataset.confirm; return; }
    b.disabled = true;
    const a = b.dataset.act;
    if (a === "schedule") return act("schedule", { bookingId: id, date: $("#sdate").value }, "Scheduled. The customer was notified.");
    if (a === "contacted") return act("markContacted", { bookingId: id }, "Logged the call.");
    if (a === "release") return act("release", { bookingId: id }, "Back in manual matching.");
    if (a === "assign") { scoreCache = null; return act("assign", { bookingId: id, vendorId: b.dataset.vendor }, "Assigned. The customer was emailed."); }
    if (a === "logClaim") return act("logClaim", { bookingId: id, description: $("#claimtxt").value }, "Re-service logged.");
    if (a === "status") return act("setVendorStatus", { vendorId: id, status: b.dataset.status }, "Status updated.");
    if (a === "claimStatus") return act("claimStatus", { claimId: b.dataset.claim, status: b.dataset.status }, "Updated.");
    if (a === "hideReview") { scoreCache = null; return act("hideReview", { reviewId: b.dataset.review, hidden: b.dataset.hidden === "1" }, "Updated."); }
    if (a === "coi") { const r = await call("admin", "coiUrl", { vendorId: id }); b.disabled = false; if (r.ok) window.open(r.data.url, "_blank", "noopener"); else toast(r.error); }
  }));
  $("#logvisit")?.addEventListener("click", async () => {
    const box = $("#vfbox"); box.hidden = !box.hidden;
    if (!box.hidden) { const { data: b } = await sb.from("bookings").select("prepaid_through").eq("id", id).maybeSingle(); mountVisitForm(box, { fn: "admin", bookingId: id, prepaid: !!(b?.prepaid_through && b.prepaid_through > today()), onDone: () => { scoreCache = null; route(); } }); }
  });
  $$("[data-photo]").forEach((x) => (x.onclick = async () => { const r = await call("admin", "visitPhotoUrl", { visitId: x.dataset.photo }); if (r.ok) window.open(r.data.url, "_blank", "noopener"); else toast(r.error); }));
  $$("[data-retry]").forEach((x) => (x.onclick = async () => { x.disabled = true; x.textContent = "Retrying…"; await act("retryPayment", { paymentId: x.dataset.retry }, "Payment went through."); }));
  $$("form[data-refund]").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = f.querySelector("button");
    if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = `Confirm ${usd(Number(f.querySelector("input").value), 2)}`; return; }
    btn.disabled = true;
    await act("refund", { paymentId: f.dataset.refund, amount: Number(f.querySelector("input").value), reason: "Operator refund" }, "Refunded. The customer was emailed.");
  }));
  $("#creditform")?.addEventListener("submit", (e) => { e.preventDefault(); act("addCredit", { bookingId: id, amount: Number($("#credamt").value), reason: $("#credwhy").value, notify: $("#crednotify").checked }, "Credit added."); });
  const cf = $("#cancelform");
  if (cf) {
    cf.closest("details").addEventListener("toggle", async (e) => { if (!e.target.open) return; const r = await call("admin", "cancelPreview", { bookingId: id }); if (r.ok && r.data.refund) $("#cancelrefund").textContent = `Unused prepay of ${usd(r.data.refund, 2)} will be refunded automatically.`; });
    cf.addEventListener("submit", (e) => { e.preventDefault(); const btn = cf.querySelector("button"); if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "Confirm cancel"; return; } act("cancel", { bookingId: id, reason: $("#cancelwhy").value || "Cancelled by operator" }, "Booking cancelled."); });
  }
  $("#vedit")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.currentTarget, s = await getSettings();
    act("updateVendor", { vendorId: id, rate_card: readRateCard(f, s.lots.length, "vr"), about: f.about.value, notes: f.notes.value, insurance_expires: f.insexp.value }, "Provider saved.");
  });
  $("#sform")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.currentTarget, s = await getSettings();
    act("saveSettings", { takeRate: Number($("#take").value) / 100, goalPairs: Number($("#goal").value), terrains: s.terrains.map((t, k) => ({ label: t.label, mult: Number($(`#y${k}`).value) })), coverages: s.coverages.map((t, k) => ({ label: t.label, mult: Number($(`#c${k}`).value) })), lotScales: s.lots.map((t, k) => Number($(`#l${k}`).value)), seasonWeeks: Number($("#sweeks").value), fertApps: Number($("#fapps").value), suggested: readRateCard(f, s.lots.length, "sg"),
      extras: { referralCredit: Number($("#xref").value), prepayDiscount: Number($("#xpre").value) / 100, respondHours: Number($("#xresp").value), reviewAfterVisits: Number($("#xrev").value) } }, "Settings saved.");
  });
}

async function route() {
  const tab = (location.hash || "#overview").slice(1);
  let html;
  try {
    if (tab.startsWith("booking-")) html = await bookingDetail(tab.slice(8));
    else if (tab.startsWith("provider-")) html = await providerDetail(tab.slice(9));
    else html = await ({ overview, bookings: bookingsTab, providers: providersTab, scorecards: scorecardsTab, metrics: metricsTab, payments: paymentsTab, claims: claimsTab, reviews: reviewsTab, settings: settingsTab }[tab] ?? overview)();
  } catch (e) { console.error(e); html = `<div class="banner bad">Couldn't load this view. Check your connection and reload.</div>`; }
  shell(tab, html);
  wire(tab);
}
window.addEventListener("hashchange", () => { scoreCache = null; route(); });
route();
void config;
