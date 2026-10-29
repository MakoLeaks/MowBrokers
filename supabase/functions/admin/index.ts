// Operator actions. Requires a signed-in user whose profiles.role = 'admin'.
import { serveActions, UserError } from "../_shared/http.ts";
import { callerUser, db, getSettings, isAdmin, logEvent } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { eligibility, quote, validRateCard } from "../_shared/pricing.mjs";
import { announceBooking, cancelBooking, completeVisit, firstName, refundPayment, retryPayment, specOf, startResponseClock, unusedPrepayCents, visitOptions } from "../_shared/services.ts";
import { bookingLink, sendEmail, sendSms } from "../_shared/notify.ts";
import { CHECKS, fmtDate, isDate, str, usd } from "../_shared/util.ts";
import type { Booking, RateCard, Vendor } from "../_shared/types.ts";

const guard = <T,>(fn: (b: Record<string, unknown>) => Promise<T>) => async (b: Record<string, unknown>, req: Request) => {
  const u = await callerUser(req);
  if (!u || !(await isAdmin(u.id))) throw new UserError("Not authorized.");
  return fn(b);
};
const id = (v: unknown) => str(v, 60);
const loadBooking = async (bid: unknown) => { const { data } = await db().from("bookings").select("*").eq("id", id(bid)).maybeSingle(); if (!data) throw new UserError("Booking not found."); return data as Booking; };

serveActions({
  setChecklist: guard(async (b) => {
    const key = String(b.key);
    if (!CHECKS.some(([k]) => k === key)) throw new UserError("Unknown check.");
    const { data } = await db().from("vendors").select("checklist,status").eq("id", id(b.vendorId)).single();
    await db().from("vendors").update({ checklist: { ...(data?.checklist ?? {}), [key]: b.value === true }, status: data?.status === "applied" ? "vetting" : data?.status }).eq("id", id(b.vendorId));
    return { ok: true };
  }),

  setVendorStatus: guard(async (b) => {
    const status = String(b.status);
    if (!["applied", "vetting", "approved", "suspended", "rejected"].includes(status)) throw new UserError("Unknown status.");
    const { data } = await db().from("vendors").select("*").eq("id", id(b.vendorId)).single();
    const v = data as Vendor;
    if (status === "approved") {
      const treats = (v.categories || []).some((c) => c !== "MOW");
      const missing = CHECKS.filter(([k]) => !v.checklist?.[k] && (k !== "license" || treats));
      if (missing.length) throw new UserError(`Finish vetting first: ${missing.map(([, l]) => l.toLowerCase()).join("; ")}.`);
    }
    await db().from("vendors").update({ status, approved_at: status === "approved" ? new Date().toISOString() : v.approved_at }).eq("id", v.id);
    if (status === "approved") {
      await sendEmail("vendor.approved", v.email, "You're live on MowBrokers", `Hi ${v.contact},\n\n${v.business} passed vetting.${v.stripe_charges_enabled ? " Your profile is now live, and homeowners in your ZIPs can book you." : " One last step: set up payouts with Stripe in your portal. Your profile goes live as soon as Stripe is connected."}\n\nHow it works: when a customer books you, call them within one business day and tap “I called them” in your portal. After each visit, tap “Visit done”, note what you did (add a photo if you like) and the customer is charged automatically.\n\nPortal: ${env.siteUrl()}/portal.html`);
      await sendSms("vendor.approved", v.phone, `${v.business} is approved on MowBrokers. ${v.stripe_charges_enabled ? "You're live." : "Set up Stripe payouts in your portal to go live."}`);
    }
    if (status === "suspended") await sendEmail("vendor.suspended", v.email, "Your MowBrokers profile is paused", `Hi ${v.contact},\n\nWe've paused ${v.business} on MowBrokers, so new customers can't book you. Existing customers are unaffected. Reply to this email to resolve it.`);
    return { ok: true };
  }),

  updateVendor: guard(async (b) => {
    const s = await getSettings();
    const row: Record<string, unknown> = {};
    if (b.rate_card !== undefined) { if (!validRateCard(b.rate_card, s.lots.length)) throw new UserError("Check the prices."); row.rate_card = b.rate_card; }
    if (b.about !== undefined) row.about = str(b.about, 1200);
    if (b.notes !== undefined) row.notes = str(b.notes, 4000);
    if (b.insurance_expires !== undefined) { if (!isDate(b.insurance_expires)) throw new UserError("Enter a valid date."); row.insurance_expires = b.insurance_expires; }
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
    const [booking, { data: vd }, s] = await Promise.all([loadBooking(b.bookingId), db().from("vendors").select("*").eq("id", id(b.vendorId)).single(), getSettings()]);
    const v = vd as Vendor;
    if (!["new", "pending_card", "matched"].includes(booking.status)) throw new UserError("Only unscheduled bookings can be reassigned.");
    const why = eligibility(v, specOf(booking));
    if (why) throw new UserError(`That provider doesn't qualify (${why}).`);
    const x = quote(s, v.rate_card as RateCard, specOf(booking));
    const status = booking.stripe_payment_method_id ? "matched" : "pending_card";
    const { data: up } = await db().from("bookings").update({ vendor_id: v.id, quote: { ...x, takeRate: s.takeRate }, status, chosen_by_customer: false, matched_at: new Date().toISOString(), contacted_at: null, nudged_at: null }).eq("id", booking.id).select("*").single();
    await logEvent(booking.id, v.id, "assigned", "by operator");
    const link = bookingLink(booking.ref, booking.access_token);
    if (status === "pending_card") {
      await sendEmail("booking.offer", booking.customer_email, `Your pro and price — ${booking.ref}`, `Hi ${firstName(booking.customer_name)},\n\nWe matched you with ${v.business}. Your season price is ${usd(x.annual)} (${booking.plan}${x.perVisit ? `, ${usd(x.perVisit)} per cut` : ""}).\n\nSave a card to confirm. You're charged only after each visit: ${link}&card=1`);
      if (booking.sms_consent) await sendSms("booking.offer", booking.customer_phone, `We matched you with ${v.business}. Confirm your price and save a card: ${link}&card=1`);
    } else {
      await startResponseClock(up as Booking, v.id);
      await announceBooking(up as Booking);
    }
    return { ok: true };
  }),

  schedule: guard(async (b) => {
    if (!isDate(b.date)) throw new UserError("Choose a date.");
    const bk = await loadBooking(b.bookingId);
    if (!["matched", "scheduled", "active"].includes(bk.status)) throw new UserError("This booking can't be scheduled now.");
    const first = bk.status === "matched";
    await db().from("bookings").update({ status: first ? "scheduled" : bk.status, ...(first ? { first_visit: b.date, scheduled_at: new Date().toISOString() } : { next_visit_due: b.date }), contacted_at: bk.contacted_at ?? new Date().toISOString(), respond_by: null }).eq("id", bk.id);
    await logEvent(bk.id, bk.vendor_id, "scheduled", `${b.date} (operator)`);
    await sendEmail("booking.scheduled", bk.customer_email, `${first ? "First" : "Next"} visit set for ${fmtDate(String(b.date))} — ${bk.ref}`, `Hi ${firstName(bk.customer_name)},\n\nYour ${first ? "first" : "next"} visit is scheduled for ${fmtDate(String(b.date))}.\n\n${bookingLink(bk.ref, bk.access_token)}`);
    return { ok: true };
  }),

  markContacted: guard(async (b) => {
    const bk = await loadBooking(b.bookingId);
    await db().from("bookings").update({ contacted_at: new Date().toISOString(), respond_by: null }).eq("id", bk.id);
    await logEvent(bk.id, bk.vendor_id, "contacted", "logged by operator");
    return { ok: true };
  }),

  visitOptions: guard(async (b) => ({ options: await visitOptions(await loadBooking(b.bookingId), isDate(b.date) ? String(b.date) : undefined) })),

  completeVisit: guard(async (b) => completeVisit(id(b.bookingId), { date: b.date, items: b.items, notes: b.notes, photoPath: b.photoPath }, "operator")),

  visitPhotoUploadUrl: guard(async (b) => {
    const bk = await loadBooking(b.bookingId);
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
    const bk = await loadBooking(b.bookingId);
    const amt = Math.round(Number(b.amount) * 100);
    if (!(amt >= 100 && amt <= 50000)) throw new UserError("Credit between $1 and $500.");
    await db().from("bookings").update({ credit_cents: bk.credit_cents + amt }).eq("id", bk.id);
    await logEvent(bk.id, bk.vendor_id, "credit", `${usd(amt / 100, 2)}${b.reason ? ": " + str(b.reason, 200) : ""}`);
    if (b.notify === true) await sendEmail("credit.added", bk.customer_email, `${usd(amt / 100, 2)} credit added`, `Hi ${firstName(bk.customer_name)},\n\nWe added a ${usd(amt / 100, 2)} credit to your account. It comes off your next charges automatically.\n\n${bookingLink(bk.ref, bk.access_token)}`);
    return { ok: true };
  }),

  release: guard(async (b) => {
    const bk = await loadBooking(b.bookingId);
    await db().from("bookings").update({ vendor_id: null, status: "new", matched_at: null, respond_by: null, contacted_at: null, chosen_by_customer: false }).eq("id", bk.id).in("status", ["matched", "scheduled", "pending_card"]);
    await logEvent(bk.id, bk.vendor_id, "released", "by operator");
    return { ok: true };
  }),

  cancelPreview: guard(async (b) => ({ refund: (await unusedPrepayCents(await loadBooking(b.bookingId))) / 100 })),
  cancel: guard(async (b) => cancelBooking(id(b.bookingId), "operator", str(b.reason, 300))),

  logClaim: guard(async (b) => {
    const bk = await loadBooking(b.bookingId);
    await db().from("claims").insert({ booking_id: bk.id, vendor_id: bk.vendor_id, description: str(b.description, 1000) || "Logged by operator after a customer call" });
    await logEvent(bk.id, bk.vendor_id, "claim", "logged by operator");
    return { ok: true };
  }),

  claimStatus: guard(async (b) => {
    const status = String(b.status);
    if (!["open", "vendor_notified", "resolved"].includes(status)) throw new UserError("Unknown status.");
    await db().from("claims").update({ status, resolved_at: status === "resolved" ? new Date().toISOString() : null }).eq("id", id(b.claimId));
    return { ok: true };
  }),

  hideReview: guard(async (b) => {
    await db().from("reviews").update({ hidden: b.hidden === true }).eq("id", id(b.reviewId));
    return { ok: true };
  }),

  saveSettings: guard(async (b) => {
    const s = await getSettings();
    const take = Number(b.takeRate), goal = Math.round(Number(b.goalPairs));
    const factors = (arr: unknown, base: { label: string }[]) => {
      if (!Array.isArray(arr) || arr.length !== base.length) throw new UserError("Check the factors.");
      return base.map((t, k) => { const m = Number((arr[k] as { mult: number }).mult); if (!(m >= 0.3 && m <= 3)) throw new UserError("Factors must be between 0.3 and 3."); return { label: t.label, mult: m }; });
    };
    if (!(take >= 0 && take <= 0.5)) throw new UserError("Take rate must be between 0% and 50%.");
    if (!(goal >= 1)) throw new UserError("Enter a goal.");
    if (!validRateCard(b.suggested, s.lots.length)) throw new UserError("Check the suggested prices.");
    const weeks = Math.round(Number(b.seasonWeeks ?? s.season.weeks)), fertApps = Math.round(Number(b.fertApps ?? s.fertApps));
    if (!(weeks >= 4 && weeks <= 52)) throw new UserError("Mowing season must be 4 to 52 weeks.");
    if (!(fertApps >= 1 && fertApps <= 12)) throw new UserError("Fertilizer program must be 1 to 12 applications.");
    const scales = Array.isArray(b.lotScales) && b.lotScales.length === s.lots.length ? s.lots.map((l, k) => { const m = Number((b.lotScales as unknown[])[k]); if (!(m >= 0.3 && m <= 20)) throw new UserError("Lot add-on scales must be between 0.3 and 20."); return { ...l, scale: m }; }) : s.lots;
    const e = (b.extras ?? {}) as Record<string, unknown>;
    const extras = {
      referralCreditCents: Math.round(Number(e.referralCredit ?? s.extras.referralCreditCents / 100) * 100),
      prepayDiscount: Number(e.prepayDiscount ?? s.extras.prepayDiscount),
      respondHours: Math.round(Number(e.respondHours ?? s.extras.respondHours)),
      reviewAfterVisits: Math.round(Number(e.reviewAfterVisits ?? s.extras.reviewAfterVisits))
    };
    if (!(extras.referralCreditCents >= 0 && extras.referralCreditCents <= 10000)) throw new UserError("Referral credit must be $0 to $100.");
    if (!(extras.prepayDiscount >= 0 && extras.prepayDiscount <= 0.2)) throw new UserError("Prepay discount must be 0% to 20%.");
    if (!(extras.respondHours >= 4 && extras.respondHours <= 72)) throw new UserError("Response window must be 4 to 72 business hours.");
    if (!(extras.reviewAfterVisits >= 1 && extras.reviewAfterVisits <= 6)) throw new UserError("Ask for reviews after 1 to 6 visits.");
    await db().from("settings").update({ take_rate: take, goal_pairs: goal, terrains: factors(b.terrains, s.terrains), coverages: factors(b.coverages, s.coverages), lots: scales, season: { ...s.season, weeks }, fert_apps: fertApps, suggested: b.suggested, extras, updated_at: new Date().toISOString() }).eq("id", 1);
    return { ok: true };
  })
});
