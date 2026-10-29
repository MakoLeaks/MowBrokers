// Service lifecycle: logging visits, billing them (per visit or from an season prepay), credits, referrals,
// retries, refunds, cancellations, response deadlines and re-matching.
import type Stripe from "npm:stripe@16.12.0";
import { db, getSettings, logEvent } from "./db.ts";
import { env } from "./env.ts";
import { UserError } from "./http.ts";
import {
  addBusinessHours, applyCredit, bestMatchKey, extrasOf, itemAmount, itemLabel, itemLimits, matchVendors, prepaidPayout, quote, splitFee, visitIntervalDays
} from "./pricing.mjs";
import { ensureCustomer, notifyCardProblem, stripe } from "./payments.ts";
import { bookingLink, notifyAdmin, sendEmail, sendSms } from "./notify.ts";
import { fmtDate, isDate, str, usd } from "./util.ts";
import type { Booking, ItemKind, Payment, Settings, Spec, Vendor } from "./types.ts";

export const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
export const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addYear = (iso: string) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); };
const KINDS: ItemKind[] = ["visit", "fert", "aeration", "leaves", "shrubs"];
const cents = (dollars: number) => Math.round(dollars * 100);
export const specOf = (b: Booking): Spec => ({ acres: b.yard.acres, zip: b.zip, terrain: b.yard.terrain, coverage: b.yard.coverage, plan: b.plan, fert: b.addons.fert, aerate: b.addons.aerate, leaves: b.addons.leaves, shrubs: b.addons.shrubs, custom: b.custom });
export const firstName = (n: string) => String(n || "").trim().split(/\s+/)[0] || "there";

async function loadBooking(id: string) {
  const { data } = await db().from("bookings").select("*").eq("id", id).maybeSingle();
  if (!data) throw new UserError("Booking not found.");
  return data as Booking;
}
async function loadVendor(id: string | null) {
  if (!id) return null;
  const { data } = await db().from("vendors").select("*").eq("id", id).maybeSingle();
  return (data as Vendor) ?? null;
}

/** The current service year for a booking (each year starts on the anniversary of the first visit, so it spans one mowing season). */
export function serviceYear(b: Booking, date: string) {
  let start = b.service_year_start ?? date;
  while (addYear(start) <= date) start = addYear(start);
  return { start, end: addYear(start) };
}

/** Items already done within the service year. */
export async function usedItems(b: Booking, year: { start: string; end: string }) {
  const { data } = await db().from("visits").select("visit_date,items").eq("booking_id", b.id);
  const used: Record<string, number> = Object.fromEntries(KINDS.map((k) => [k, 0]));
  let inYear = 0;
  for (const v of (data ?? []) as { visit_date: string; items: string[] }[]) {
    const within = v.visit_date >= year.start && v.visit_date < year.end;
    if (within) { for (const k of v.items) used[k] = (used[k] ?? 0) + 1; inYear++; }
  }
  return { used, inYear, total: (data ?? []).length };
}

/** What a provider can mark done on a visit today, with remaining counts and prices. */
export async function visitOptions(b: Booking, date = todayCT()) {
  if (!b.quote) return [];
  const year = serviceYear(b, date);
  const { used } = await usedItems(b, year);
  const lim = itemLimits(b.plan, b.quote, b.addons) as Record<string, number>;
  return KINDS.filter((k) => lim[k] > 0).map((k) => ({
    kind: k, label: itemLabel(k, b.plan), amount: itemAmount(b.quote!, k), remaining: Math.max(0, lim[k] - (used[k] ?? 0)), blocked: false
  }));
}

// ---------------------------------------------------------------------------------------------
// Logging a visit
// ---------------------------------------------------------------------------------------------
export type VisitInput = { date: unknown; items: unknown; notes: unknown; photoPath?: unknown };

export async function completeVisit(bookingId: string, input: VisitInput, by: "provider" | "operator") {
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
  const notes = str(input.notes, 2000);
  if (notes.length < 10) throw new UserError("Add a short service note: what you did and anything the customer should know.");
  const items = [...new Set((Array.isArray(input.items) ? input.items : []).map(String))] as ItemKind[];
  if (!items.length || items.some((k) => !KINDS.includes(k))) throw new UserError("Choose what you did on this visit.");
  const photo = input.photoPath ? str(input.photoPath, 300) : null;
  if (photo && !photo.startsWith(`${v.id}/${b.id}/`)) throw new UserError("That photo doesn't belong to this booking.");

  const year = serviceYear(b, date);
  const { used, total } = await usedItems(b, year);
  const lim = itemLimits(b.plan, b.quote, b.addons) as Record<string, number>;
  for (const k of items) {
    if ((lim[k] ?? 0) <= 0) throw new UserError(`${itemLabel(k, b.plan)} isn't part of this customer's plan.`);
    if ((used[k] ?? 0) >= lim[k]) throw new UserError(`${itemLabel(k, b.plan)}: all ${lim[k]} for this service year are already logged. Re-service visits under the guarantee are free.`);
  }

  // Decide what's billed now vs. covered by an season prepay.
  const s = await getSettings();
  const ex = extrasOf(s);
  const takeRate = b.quote.takeRate ?? s.takeRate;
  const prepayActive = !!(b.prepay_payment_id && b.prepaid_through && date < b.prepaid_through);
  const usedThisYear = KINDS.reduce((t, k) => t + (used[k] ?? 0), 0);
  const startPrepay = b.prepay && b.plan !== "One-time cut" && !prepayActive && usedThisYear === 0;
  const covers: Record<string, number> = startPrepay ? Object.fromEntries(KINDS.map((k) => [k, lim[k] ?? 0])) : (b.prepay_covers ?? {});
  const discount = b.quote.prepayDiscount ?? ex.prepayDiscount;
  const lines = items.map((k) => {
    const amount = itemAmount(b.quote!, k);
    const covered = (prepayActive || startPrepay) && (used[k] ?? 0) < (covers[k] ?? 0);
    return { kind: k, amount, covered };
  });

  const { data: visit, error: vErr } = await db().from("visits").insert({ booking_id: b.id, vendor_id: v.id, visit_date: date, items, notes, photo_path: photo, logged_by: by }).select("*").single();
  if (vErr) throw vErr;

  // Booking bookkeeping happens whether or not the card goes through (the work was done).
  const interval = visitIntervalDays(b.plan);
  const patch: Record<string, unknown> = {
    status: b.plan === "One-time cut" && items.includes("visit") && !KINDS.some((k) => k !== "visit" && (lim[k] ?? 0) > (used[k] ?? 0) + (items.includes(k) ? 1 : 0)) ? "completed" : "active",
    first_visit: b.first_visit ?? date,
    service_year_start: b.service_year_start ?? date,
    contacted_at: b.contacted_at ?? new Date().toISOString(),
    respond_by: null,
    visits_charged: b.visits_charged + items.filter((k) => k === "visit").length,
    fert_charged: b.fert_charged + items.filter((k) => k === "fert").length
  };
  if (interval && (items.includes("visit") || (b.plan === "No mowing" && items.length))) patch.next_visit_due = addDays(date, interval);
  await db().from("bookings").update(patch).eq("id", b.id);
  const fresh = { ...b, ...patch } as Booking;
  await logEvent(b.id, v.id, "visit", `${items.join(", ")} on ${date} (${by})`);

  // Money.
  const results: { charged: number; status: string; message?: string; covered: number } = { charged: 0, status: "succeeded", covered: 0 };
  const billed = lines.filter((l) => !l.covered);
  const covered = lines.filter((l) => l.covered);
  const label = (ls: typeof lines) => ls.map((l) => itemLabel(l.kind, b.plan)).join(" + ");

  if (startPrepay) {
    const prepayCents = cents(b.quote.prepay ?? Math.round(b.quote.annual * (1 - discount)));
    const billedCents = billed.reduce((t, l) => t + cents(l.amount), 0);
    const billedFee = billed.reduce((t, l) => t + splitFee(l.amount, takeRate).fee_cents, 0);
    const credit = applyCredit(billedCents + prepayCents, billedFee + Math.round(prepayCents * takeRate), fresh.credit_cents);
    const row = await insertPayment({
      booking_id: b.id, vendor_id: v.id, kind: "prepay", label: `${billed.length ? label(billed) + " + " : ""}Season prepay (${Math.round(discount * 100)}% off)`,
      amount_cents: credit.charge_cents, fee_cents: Math.max(0, billedFee - credit.discount_cents), net_cents: billedCents - billedFee, discount_cents: credit.discount_cents,
      visit_id: visit.id, status: "processing",
      items: [...billed.map((l) => ({ kind: l.kind, amount_cents: cents(l.amount) })), ...covered.map((l) => ({ kind: l.kind, amount_cents: cents(l.amount), covered: true })),
        { kind: "prepay", amount_cents: prepayCents, through: year.end, covers }]
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
        booking_id: b.id, vendor_id: v.id, kind: "service", label: label(billed), amount_cents: credit.charge_cents, fee_cents: credit.fee_cents,
        net_cents: split.net_cents, discount_cents: credit.discount_cents, visit_id: visit.id, status: "processing",
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

async function insertPayment(row: Record<string, unknown>): Promise<Payment> {
  const { data, error } = await db().from("payments").insert(row).select("*").single();
  if (error) throw error;
  return data as Payment;
}

/** Runs (or re-runs) the Stripe side of a payment row and records the outcome. */
export async function executePayment(p: Payment, b: Booking, v: Vendor): Promise<{ status: string; message?: string }> {
  const attempt = (p.attempts ?? 0) + 1;
  await db().from("payments").update({ attempts: attempt }).eq("id", p.id);
  const common = {
    customer: b.stripe_customer_id!, payment_method: b.stripe_payment_method_id!, off_session: true, confirm: true, currency: "usd",
    description: `${p.label} — ${v.business} — ${b.ref}`, statement_descriptor_suffix: "MOWBROKERS",
    metadata: { booking_id: b.id, ref: b.ref, vendor_id: v.id, payment_id: p.id, kind: p.kind }
  };
  let pi: Stripe.PaymentIntent | null = null, status: "processing" | "succeeded" | "failed" = "processing", failure: string | null = null;
  try {
    if (p.kind === "prepay") pi = await stripe().paymentIntents.create({ amount: p.amount_cents, ...common }, { idempotencyKey: `pay-${p.id}-${attempt}` });
    else pi = await stripe().paymentIntents.create({ amount: p.amount_cents, ...common, application_fee_amount: p.fee_cents, transfer_data: { destination: v.stripe_account_id! } }, { idempotencyKey: `pay-${p.id}-${attempt}` });
    status = pi.status === "succeeded" ? "succeeded" : pi.status === "processing" ? "processing" : "failed";
    if (status === "failed") failure = `Payment needs attention (${pi.status}).`;
  } catch (e) {
    const err = e as Stripe.errors.StripeError;
    status = "failed"; failure = err.message || "Card was declined.";
    pi = (err.payment_intent as Stripe.PaymentIntent) ?? null;
  }
  const chargeId = typeof pi?.latest_charge === "string" ? pi.latest_charge : pi?.latest_charge?.id ?? null;
  await db().from("payments").update({ status, failure_message: failure, stripe_payment_intent_id: pi?.id ?? p.stripe_payment_intent_id, stripe_charge_id: chargeId }).eq("id", p.id);
  if (status === "failed") {
    await notifyCardProblem(b, p.label, p.amount_cents / 100, failure);
    return { status, message: `Charge failed: ${failure}. We emailed the customer to update their card; retry once they have.` };
  }
  await afterSuccessfulCharge(p, b);
  if (p.kind === "prepay" && chargeId) {
    const pre = (p.items as unknown as { kind: string; through?: string; covers?: Record<string, number>; covered?: boolean; amount_cents: number }[]);
    const meta = pre.find((i) => i.kind === "prepay");
    await db().from("bookings").update({ prepay_payment_id: p.id, prepaid_through: meta?.through ?? null, prepay_covers: meta?.covers ?? null }).eq("id", b.id);
    if (p.net_cents > 0) await transferTo(v, p.net_cents, chargeId, b, `${p.label} (provider share)`, p.id);
    const cov = pre.filter((i) => i.covered);
    if (cov.length) {
      const fresh = await loadBooking(b.id);
      await payoutCovered(fresh, v, p.visit_id!, cov.map((i) => ({ kind: i.kind as ItemKind, amount: i.amount_cents / 100 })), fresh.quote?.prepayDiscount ?? 0.05, fresh.quote?.takeRate ?? 0.12, chargeId);
    }
  }
  return { status };
}

async function transferTo(v: Vendor, amount_cents: number, sourceCharge: string, b: Booking, what: string, paymentId: string) {
  try {
    const t = await stripe().transfers.create({ amount: amount_cents, currency: "usd", destination: v.stripe_account_id!, source_transaction: sourceCharge, transfer_group: b.ref, description: what, metadata: { booking_id: b.id, payment_id: paymentId } }, { idempotencyKey: `xfer-${paymentId}` });
    await db().from("payments").update({ stripe_transfer_id: t.id }).eq("id", paymentId);
    return t.id;
  } catch (e) {
    await notifyAdmin("payout.failed", `Provider payout failed on ${b.ref}`, `${what}: ${(e as Error).message}. Retry from the booking in the console.`);
    return null;
  }
}

/** Pays the provider their share of items covered by the customer's season prepay. */
async function payoutCovered(b: Booking, v: Vendor, visitId: string, items: { kind: ItemKind; amount: number }[], discount: number, takeRate: number, sourceCharge?: string) {
  let source = sourceCharge ?? null;
  if (!source && b.prepay_payment_id) {
    const { data } = await db().from("payments").select("stripe_charge_id").eq("id", b.prepay_payment_id).maybeSingle();
    source = data?.stripe_charge_id ?? null;
  }
  const parts = items.map((i) => ({ kind: i.kind, ...prepaidPayout(i.amount, discount, takeRate) }));
  const row = await insertPayment({
    booking_id: b.id, vendor_id: v.id, kind: "prepaid_visit", label: `${items.map((i) => itemLabel(i.kind, b.plan)).join(" + ")} (prepaid)`,
    amount_cents: parts.reduce((t, p) => t + p.amount_cents, 0), fee_cents: parts.reduce((t, p) => t + p.fee_cents, 0), net_cents: parts.reduce((t, p) => t + p.net_cents, 0),
    visit_id: visitId, status: "processing", items: parts.map((p) => ({ kind: p.kind, amount_cents: p.amount_cents, covered: true }))
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

/** Credits consumed, referral rewards earned. */
async function afterSuccessfulCharge(p: Payment, b: Booking) {
  if (p.discount_cents > 0) {
    const fresh = await loadBooking(b.id);
    await db().from("bookings").update({ credit_cents: Math.max(0, fresh.credit_cents - p.discount_cents) }).eq("id", b.id);
  }
  const { data: ref } = await db().from("referrals").select("*").eq("referee_booking_id", b.id).eq("status", "pending").maybeSingle();
  if (ref) {
    const s = await getSettings();
    const amt = extrasOf(s).referralCreditCents;
    const { data: rb } = await db().from("bookings").select("*").eq("id", ref.referrer_booking_id).maybeSingle();
    await db().from("referrals").update({ status: "earned", earned_at: new Date().toISOString() }).eq("id", ref.id);
    if (rb) {
      await db().from("bookings").update({ credit_cents: (rb.credit_cents ?? 0) + amt }).eq("id", rb.id);
      await sendEmail("referral.earned", rb.customer_email, `You earned ${usd(amt / 100)} — thanks for the referral`, `Hi ${firstName(rb.customer_name)},\n\n${firstName(b.customer_name)} booked through your link, so you've earned ${usd(amt / 100)} off your lawn care. It comes off your next charges automatically.\n\nYour account: ${bookingLink(rb.ref, rb.access_token)}`);
      await logEvent(rb.id, rb.vendor_id, "referral_earned", b.ref);
    }
  }
}

/** Retry a failed charge or payout (provider for own bookings, operator for any). */
export async function retryPayment(paymentId: string) {
  const { data } = await db().from("payments").select("*").eq("id", paymentId).maybeSingle();
  const p = data as Payment | null;
  if (!p || p.status !== "failed") throw new UserError("Only failed payments can be retried.");
  const b = await loadBooking(p.booking_id);
  const v = await loadVendor(p.vendor_id);
  if (!v) throw new UserError("Provider not found.");
  if (p.kind === "prepaid_visit") {
    const fresh = b;
    let source: string | null = null;
    if (fresh.prepay_payment_id) { const { data: pp } = await db().from("payments").select("stripe_charge_id").eq("id", fresh.prepay_payment_id).maybeSingle(); source = pp?.stripe_charge_id ?? null; }
    if (!source) throw new UserError("The prepay charge hasn't gone through yet.");
    const t = await transferTo(v, p.net_cents, source, b, p.label, p.id);
    await db().from("payments").update({ status: t ? "succeeded" : "failed" }).eq("id", p.id);
    return { status: t ? "succeeded" : "failed" };
  }
  if (!b.stripe_payment_method_id) throw new UserError("The customer has no card on file.");
  const r = await executePayment(p, b, v);
  if (r.status === "failed") throw new UserError(r.message ?? "Charge failed again.");
  const fresh = await loadBooking(b.id);
  await sendEmail("payment.receipt", b.customer_email, `Receipt: ${p.label} ${usd(p.amount_cents / 100, 2)} — ${b.ref}`, `Hi ${firstName(b.customer_name)},\n\nWe charged ${usd(p.amount_cents / 100, 2)} for ${p.label.toLowerCase()} with ${v.business}.\n\nYour account: ${bookingLink(fresh.ref, fresh.access_token)}`);
  return r;
}

async function sendServiceReport(b: Booking, v: Vendor, visitId: string, date: string, items: ItemKind[], notes: string, hasPhoto: boolean, money: { charged: number; status: string; covered: number }) {
  const link = bookingLink(b.ref, b.access_token);
  const lines = items.map((k) => `• ${itemLabel(k, b.plan)}`).join("\n");
  const pay = money.status === "failed" ? "We couldn't charge your card for this visit. Please update it from your account page."
    : money.charged ? `Charged to your card: ${usd(money.charged, 2)}.${money.covered ? " The rest was covered by your season prepay." : ""}`
    : money.covered ? "Covered by your season prepay. Nothing was charged today." : "";
  const next = b.next_visit_due && b.plan !== "One-time cut" ? `\nNext visit due around ${fmtDate(b.next_visit_due)}. ${v.business} will reach out to schedule.` : "";
  await sendEmail("visit.report", b.customer_email, `Service report: ${fmtDate(date)} — ${v.business}`,
    `Hi ${firstName(b.customer_name)},\n\n${v.business} completed your service on ${fmtDate(date)}.\n\nWhat was done:\n${lines}\n\nTechnician's notes:\n${notes}\n${hasPhoto ? "\nA photo from the visit is on your account page.\n" : ""}\n${pay}${next}\n\nMissed spot, or weeds back before your next treatment? Re-service is free: ${link}`);
  if (b.sms_consent) await sendSms("visit.report", b.customer_phone, `${v.business} finished your service today. Report${hasPhoto ? " and photo" : ""}: ${link}`);
  void visitId;
}

async function maybeRequestReview(b: Booking, v: Vendor, visitCount: number) {
  if (b.review_requested_at) return;
  const s = await getSettings();
  const need = b.plan === "One-time cut" ? 1 : extrasOf(s).reviewAfterVisits;
  if (visitCount < need) return;
  const { count } = await db().from("reviews").select("id", { count: "exact", head: true }).eq("booking_id", b.id);
  if (count) return;
  await db().from("bookings").update({ review_requested_at: new Date().toISOString() }).eq("id", b.id);
  await sendEmail("review.request", b.customer_email, `How is ${v.business} doing?`,
    `Hi ${firstName(b.customer_name)},\n\nYou've had ${visitCount} visit${visitCount === 1 ? "" : "s"} with ${v.business}. Would you rate them? It takes 20 seconds and helps your neighbors pick a pro.\n\nRate ${v.business}: ${bookingLink(b.ref, b.access_token)}#review`);
}

// ---------------------------------------------------------------------------------------------
// Refunds, credits, cancellations
// ---------------------------------------------------------------------------------------------
/** Unused part of an season prepay (what a cancellation refunds). */
export async function unusedPrepayCents(b: Booking) {
  if (!b.prepay_payment_id || !b.prepaid_through || b.prepaid_through <= todayCT()) return 0;
  const { data: pp } = await db().from("payments").select("*").eq("id", b.prepay_payment_id).maybeSingle();
  if (!pp || pp.status !== "succeeded") return 0;
  const portion = ((pp.items ?? []) as { kind: string; amount_cents: number }[]).find((i) => i.kind === "prepay")?.amount_cents ?? 0;
  const { data: used } = await db().from("payments").select("amount_cents").eq("booking_id", b.id).eq("kind", "prepaid_visit").gte("created_at", pp.created_at);
  const consumed = (used ?? []).reduce((t: number, r: { amount_cents: number }) => t + r.amount_cents, 0);
  return Math.max(0, Math.min(portion - consumed, pp.amount_cents - pp.refunded_cents));
}

export async function refundPayment(paymentId: string, amountCents: number, reason: string) {
  const { data } = await db().from("payments").select("*").eq("id", paymentId).maybeSingle();
  const p = data as Payment | null;
  if (!p || p.status !== "succeeded" || !p.stripe_payment_intent_id) throw new UserError("Only successful card charges can be refunded.");
  if (p.kind === "prepaid_visit") throw new UserError("This is a provider payout from a prepay. Refund the prepay charge instead.");
  const max = p.amount_cents - p.refunded_cents;
  const amt = Math.round(amountCents);
  if (!(amt >= 50 && amt <= max)) throw new UserError(`Refund between $0.50 and ${usd(max / 100, 2)}.`);
  const b = await loadBooking(p.booking_id);
  const params: Stripe.RefundCreateParams = { payment_intent: p.stripe_payment_intent_id, amount: amt, reason: "requested_by_customer", metadata: { payment_id: p.id, note: reason.slice(0, 200) } };
  if (p.kind !== "prepay") Object.assign(params, { reverse_transfer: true, refund_application_fee: true });
  await stripe().refunds.create(params, { idempotencyKey: `refund-${p.id}-${p.refunded_cents}-${amt}` });
  await db().from("payments").update({ refunded_cents: p.refunded_cents + amt }).eq("id", p.id);
  await logEvent(b.id, p.vendor_id, "refund", `${usd(amt / 100, 2)} on ${p.label}${reason ? ": " + reason : ""}`);
  await sendEmail("payment.refund", b.customer_email, `Refund: ${usd(amt / 100, 2)} — ${b.ref}`, `Hi ${firstName(b.customer_name)},\n\nWe refunded ${usd(amt / 100, 2)} for ${p.label.toLowerCase()} to your card. It usually appears within 5–10 business days.\n\nYour account: ${bookingLink(b.ref, b.access_token)}`);
  return { refunded: amt / 100 };
}

export async function cancelBooking(bookingId: string, by: "customer" | "operator", reason: string) {
  const b = await loadBooking(bookingId);
  if (["cancelled", "completed"].includes(b.status)) throw new UserError("This booking is already closed.");
  const refund = await unusedPrepayCents(b);
  await db().from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: reason.slice(0, 300), cancelled_by: by, respond_by: null }).eq("id", b.id);
  let refunded = 0;
  if (refund >= 50 && b.prepay_payment_id) { try { refunded = (await refundPayment(b.prepay_payment_id, refund, "Unused season prepay")).refunded; } catch (e) { await notifyAdmin("refund.failed", `Prepay refund failed on ${b.ref}`, (e as Error).message); } }
  await logEvent(b.id, b.vendor_id, "cancelled", `${by}${reason ? ": " + reason : ""}`);
  await sendEmail("booking.cancelled", b.customer_email, `Booking cancelled — ${b.ref}`, `Hi ${firstName(b.customer_name)},\n\nYour MowBrokers service (${b.ref}) is cancelled. You won't be charged for future visits.${refunded ? ` We refunded ${usd(refunded, 2)} of unused prepay to your card.` : ""}\n\nChanged your mind? Reply to this email and we'll set you back up.`);
  const v = await loadVendor(b.vendor_id);
  if (v) await sendEmail("booking.cancelled", v.email, `Customer cancelled — ${b.ref}`, `${b.customer_name} (${b.ref}) cancelled${by === "customer" ? " from their account" : ""}. Don't schedule further visits.${reason ? `\nReason given: ${reason}` : ""}`);
  await notifyAdmin("booking.cancelled", `Cancelled: ${b.ref}`, `${b.customer_name}${v ? " with " + v.business : ""} · by ${by}${reason ? " · " + reason : ""}${refunded ? ` · refunded ${usd(refunded, 2)}` : ""}`);
  return { refunded };
}

// ---------------------------------------------------------------------------------------------
// Matching and response deadlines
// ---------------------------------------------------------------------------------------------
/** Start a provider's one-business-day clock to reach the customer. */
export async function startResponseClock(b: Booking, vendorId: string) {
  const s = await getSettings();
  const by = addBusinessHours(new Date(), extrasOf(s).respondHours).toISOString();
  await db().from("bookings").update({ respond_by: by, contacted_at: null }).eq("id", b.id);
  await logEvent(b.id, vendorId, "matched", `respond by ${by}`);
  return by;
}

/** Best qualifying providers for a booking, ranked by price and provider score. */
export async function rankedMatches(b: Booking, exclude: string[] = []) {
  const [s, { data: vendors }, { data: scores }] = await Promise.all([getSettings(), db().from("public_vendors").select("*"), db().rpc("vendor_scores")]);
  const scoreOf = Object.fromEntries(((scores ?? []) as { vendor_id: string; score: number }[]).map((r) => [r.vendor_id, r.score]));
  const { matches } = matchVendors(s, (vendors ?? []).filter((v: { id: string }) => !exclude.includes(v.id)), specOf(b));
  return matches.map((m: { v: Vendor; x: ReturnType<typeof quote> }) => ({ ...m, score: scoreOf[m.v.id] ?? null, key: bestMatchKey(m.x.annual, scoreOf[m.v.id]) }))
    .sort((a: { key: number }, c: { key: number }) => a.key - c.key);
}

/** Hourly: providers who didn't log a call within one business day lose the booking. */
export async function enforceResponseDeadlines() {
  const out: string[] = [];
  const { data } = await db().from("bookings").select("*").eq("status", "matched").is("contacted_at", null).not("respond_by", "is", null).lt("respond_by", new Date().toISOString()).limit(50);
  for (const b of (data ?? []) as Booking[]) {
    const old = await loadVendor(b.vendor_id);
    await logEvent(b.id, b.vendor_id, "sla_miss", `no call logged by ${b.respond_by}`);
    const { data: misses } = await db().from("booking_events").select("vendor_id").eq("booking_id", b.id).eq("type", "sla_miss");
    const exclude = [...new Set(((misses ?? []) as { vendor_id: string }[]).map((m) => m.vendor_id).filter(Boolean))];
    const oldAnnual = b.quote?.annual ?? Infinity;
    const best = (await rankedMatches(b, exclude)).find((m: { x: { annual: number } }) => m.x.annual <= oldAnnual + 0.5);
    if (old) await sendEmail("sla.released", old.email, `Booking reassigned — ${b.ref}`, `${b.customer_name} (${b.ref}) was waiting more than one business day for a call, so we've passed the booking to another pro. Logging a call (“I called them”) in your portal stops the clock next time.`);
    const bestV = best ? await loadVendor(best.v.id) : null;
    if (best && bestV) {
      const s = await getSettings();
      const nq = { ...best.x, takeRate: s.takeRate };
      const { data: up } = await db().from("bookings").update({ vendor_id: best.v.id, quote: nq, matched_at: new Date().toISOString(), chosen_by_customer: false, nudged_at: null }).eq("id", b.id).select("*").single();
      await startResponseClock(up as Booking, best.v.id);
      await logEvent(b.id, best.v.id, "reassigned", `from ${old?.business ?? "—"}`);
      await sendEmail("sla.reassigned", b.customer_email, `A faster pro for your yard — ${b.ref}`,
        `Hi ${firstName(b.customer_name)},\n\n${old?.business ?? "Your pro"} didn't reach you within one business day, so we've matched you with ${best.v.business}, another vetted pro. Your season price is ${usd(nq.annual)}${nq.annual < oldAnnual ? ` (down from ${usd(oldAnnual)})` : ", the same as before"}. Nothing has been charged.\n\n${best.v.business} will call ${b.customer_phone} to set your first visit. Rather choose someone else? Reply to this email.\n\nYour account: ${bookingLink(b.ref, b.access_token)}`);
      await notifyNewJob(up as Booking, bestV, true);
      await notifyAdmin("sla.reassigned", `${b.ref} moved to ${best.v.business}`, `${old?.business ?? "Provider"} missed the one-business-day call window. Auto-reassigned at ${usd(nq.annual)} for the season.`);
      out.push(`reassigned ${b.ref} → ${best.v.business}`);
    } else {
      await db().from("bookings").update({ vendor_id: null, status: "new", respond_by: null, matched_at: null, chosen_by_customer: false }).eq("id", b.id);
      await logEvent(b.id, null, "released", `from ${old?.business ?? "—"}`);
      await sendEmail("sla.released", b.customer_email, `We're lining up another pro — ${b.ref}`, `Hi ${firstName(b.customer_name)},\n\n${old?.business ?? "Your pro"} didn't reach you within one business day, so we're lining up another vetted pro. We'll confirm their price with you before anything changes. Nothing has been charged.\n\nYour account: ${bookingLink(b.ref, b.access_token)}`);
      await notifyAdmin("sla.released", `${b.ref} needs a new pro`, `${old?.business ?? "Provider"} missed the call window and no other pro qualifies at the same price. Assign one in the console.`, `${b.ref} needs a new pro: ${old?.business ?? "provider"} missed the call window.`);
      out.push(`released ${b.ref}`);
    }
  }
  return out;
}

export async function notifyNewJob(b: Booking, v: Vendor, reassigned = false) {
  const price = b.quote ? `Season price: ${usd(b.quote.annual)} (${b.plan}${b.quote.perVisit ? `, ${usd(b.quote.perVisit)} per cut` : ""}).` : "";
  const when = [b.preferred_start ? `Preferred first visit: ${fmtDate(b.preferred_start)}` : "", b.preferred_alt ? `Backup date: ${fmtDate(b.preferred_alt)}` : "", b.visit_window !== "any" ? `Time of day: ${b.visit_window}` : ""].filter(Boolean).join("\n");
  await sendEmail("booking.new_job", v.email, `New MowBrokers customer: ${b.customer_name} (${b.ref})`,
    `${b.customer_name} ${reassigned ? "was matched to you" : "chose you"} on MowBrokers.\n\nPhone: ${b.customer_phone}\nAddress: ${b.street}, ${b.zip}\nYard: ${b.yard.acres} acres, ${b.yard.terrain}, ${b.yard.coverage}\nPlan: ${b.plan}${b.prepay ? " (season prepay)" : ""}\n${price}\n${when ? when + "\n" : ""}${b.custom.length ? "Inspect and quote: " + b.custom.join(", ") + "\n" : ""}${b.notes ? "Customer says: " + b.notes + "\n" : ""}\nCall within one business day and tap “I called them” (or mark the visit scheduled) in your portal, or the booking moves to another pro: ${env.siteUrl()}/portal.html`);
  await sendSms("booking.new_job", v.phone, `New customer ${b.customer_name} (${b.ref}), ${b.zip}. Call within 1 business day and log it in your portal, or it moves to another pro.`);
}

// ---------------------------------------------------------------------------------------------
// Card saved / booking announced
// ---------------------------------------------------------------------------------------------
/** After the card SetupIntent succeeds (from the booking page or the webhook). Idempotent. */
export async function attachCardFromSetupIntent(si: Stripe.SetupIntent): Promise<Booking | null> {
  const bookingId = si.metadata?.booking_id;
  if (!bookingId || si.status !== "succeeded" || !si.payment_method) return null;
  const pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method.id;
  const { data } = await db().from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!data) return null;
  const b = data as Booking;
  if (b.stripe_payment_method_id === pm) return b;
  const custId = typeof si.customer === "string" ? si.customer : si.customer?.id;
  if (custId) await stripe().customers.update(custId, { invoice_settings: { default_payment_method: pm } });
  const wasPending = b.status === "pending_card";
  const nextStatus = wasPending ? (b.vendor_id ? "matched" : "new") : b.status;
  const { data: up } = await db().from("bookings").update({ stripe_payment_method_id: pm, status: nextStatus, matched_at: b.vendor_id && !b.matched_at ? new Date().toISOString() : b.matched_at }).eq("id", b.id).select("*").single();
  if (wasPending) {
    if (b.vendor_id) await startResponseClock(up as Booking, b.vendor_id);
    await announceBooking(up as Booking);
  } else await logEvent(b.id, b.vendor_id, "card_updated");
  return up as Booking;
}

export async function announceBooking(b: Booking) {
  const link = bookingLink(b.ref, b.access_token);
  const v = await loadVendor(b.vendor_id);
  const price = b.quote ? `Season price: ${usd(b.quote.annual)} (${b.plan}${b.prepay ? ", season prepay" : ""}).` : "";
  if (v) {
    await sendEmail("booking.confirmed", b.customer_email, `Booked with ${v.business} — ${b.ref}`,
      `Hi ${firstName(b.customer_name)},\n\nYou're booked with ${v.business}. They'll call ${b.customer_phone} within one business day to set your first visit.\n${price}\nYour card is saved and is charged only after each visit${b.prepay ? " (your season prepay is charged at the first visit)" : ""}.\n\nYour account (visit reports, receipts, free re-service, pause or cancel): ${link}\nReference code: ${b.ref}`);
    if (b.sms_consent) await sendSms("booking.confirmed", b.customer_phone, `You're booked with ${v.business} (${b.ref}). They'll call within 1 business day. Details: ${link}`);
    await notifyNewJob(b, v);
  } else {
    await sendEmail("booking.request", b.customer_email, `We're finding your pro — ${b.ref}`, `Hi ${firstName(b.customer_name)},\n\nWe got your request. We'll find a vetted lawn pro for your yard and send you their price before anything is booked.\n\nTrack it here: ${link}`);
  }
  await notifyAdmin("booking.created", `${v ? "New booking" : "Needs manual match"}: ${b.ref}`, `${b.customer_name}, ${b.zip}, ${b.plan}${v ? " → " + v.business : " — no automatic match"}.`, v ? undefined : `Needs manual match: ${b.ref} in ${b.zip}.`);
}
void ensureCustomer;
