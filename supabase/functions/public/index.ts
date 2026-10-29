// Customer-facing actions. Called from the public HTML pages with the anon key; no login required.
// Booking-specific actions are authorized by the booking's private link (ref + token).
import { serveActions, UserError } from "../_shared/http.ts";
import { db, getSettings, logEvent } from "../_shared/db.ts";
import { ADDONS, CUSTOM_JOBS, JOB_CATEGORY, eligibility, extrasOf, parseSpec, quote, withAddons } from "../_shared/pricing.mjs";
import { ensureCustomer, stripe } from "../_shared/payments.ts";
import { addDays, announceBooking, attachCardFromSetupIntent, cancelBooking, firstName, specOf, todayCT, unusedPrepayCents } from "../_shared/services.ts";
import { bookingLink, notifyAdmin, sendEmail, sendSms } from "../_shared/notify.ts";
import { fmtDate, isDate, refCode, str, toE164, token, usd } from "../_shared/util.ts";
import type { Booking, RateCard, Spec, Vendor } from "../_shared/types.ts";

const PUBLIC_COLS = "id,slug,status,business,years,techs,categories,zips,insurance_expires,rate_card,custom_jobs,stripe_charges_enabled";

async function bookingByToken(ref: unknown, tok: unknown): Promise<Booking> {
  const { data } = await db().from("bookings").select("*").eq("ref", str(ref, 20).toUpperCase()).maybeSingle();
  const t = String(tok ?? "");
  if (!data || typeof data.access_token !== "string" || data.access_token.length !== t.length) throw new UserError("Booking not found.");
  let diff = 0;
  for (let i = 0; i < t.length; i++) diff |= t.charCodeAt(i) ^ data.access_token.charCodeAt(i);
  if (diff) throw new UserError("Booking not found.");
  return data as Booking;
}
const vendorOf = async (b: Booking) => (b.vendor_id ? ((await db().from("vendors").select("*").eq("id", b.vendor_id).maybeSingle()).data as Vendor | null) : null);
const referralCode = (name: string) => (String(name).replace(/[^A-Za-z]/g, "").toUpperCase() + "LAWNS").slice(0, 5) + Array.from(crypto.getRandomValues(new Uint8Array(4))).map((x) => "23456789ABCDEFGHJKMNPQRSTUVWXYZ"[x % 31]).join("");
const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

async function openClaim(b: Booking, description: string) {
  if (description.length < 5) throw new UserError("Tell us what was missed or what's back.");
  if (!b.vendor_id || !["scheduled", "active", "completed"].includes(b.status)) throw new UserError("Re-service opens once your first visit is scheduled.");
  const { count } = await db().from("claims").select("id", { count: "exact", head: true }).eq("booking_id", b.id).neq("status", "resolved");
  if ((count ?? 0) > 0) throw new UserError("You already have an open re-service request. Your pro will call you.");
  await db().from("claims").insert({ booking_id: b.id, vendor_id: b.vendor_id, description });
  const { data: v } = await db().from("vendors").select("business,email,phone").eq("id", b.vendor_id).single();
  if (v) {
    await sendEmail("claim.created", v.email, `Free re-service requested: ${b.ref}`, `${b.customer_name} (${b.customer_phone}, ${b.street} ${b.zip}) reports: "${description}"\n\nUnder the MowBrokers re-service guarantee, coming back for a missed or poor cut, or for weeds that return between treatment visits, is free. Go back within two business days.`);
    await sendSms("claim.created", v.phone, `Re-service requested by ${b.customer_name} (${b.ref}). Go back within 2 business days.`);
  }
  await logEvent(b.id, b.vendor_id, "claim", description);
  await notifyAdmin("claim.created", `Re-service on ${b.ref}`, description);
  return { ok: true };
}

serveActions({
  async createBooking(body) {
    if (str(body.website, 100)) throw new UserError("Check the form and try again."); // honeypot
    const spec = parseSpec(body.spec ?? {}) as Spec | null;
    if (!spec) throw new UserError("Your yard details are incomplete. Go back and check them.");
    const name = str(body.name, 120), email = str(body.email, 200), street = str(body.street, 200), phone = toE164(body.phone);
    if (name.length < 2) throw new UserError("Enter your full name.");
    if (!phone) throw new UserError("Enter a 10-digit US mobile number.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("Enter a valid email so we can send your receipt.");
    if (street.length < 4) throw new UserError("Enter your street address.");
    const preferred = isDate(body.preferredStart) && String(body.preferredStart) >= todayCT() ? String(body.preferredStart) : null;
    const alt = isDate(body.preferredAlt) && String(body.preferredAlt) >= todayCT() ? String(body.preferredAlt) : null;
    const window = ["morning", "afternoon"].includes(String(body.visitWindow)) ? String(body.visitWindow) : "any";
    const s = await getSettings();
    let vendorId: string | null = null, q = null;
    if (body.vendorSlug) {
      const { data: v } = await db().from("vendors").select(PUBLIC_COLS).eq("slug", str(body.vendorSlug, 80)).maybeSingle();
      if (!v) throw new UserError("That pro isn't available. Go back and choose another.");
      if (eligibility(v, spec)) throw new UserError("That pro can no longer take this request. Go back and choose another.");
      q = { ...quote(s, v.rate_card as RateCard, spec), takeRate: s.takeRate };
      vendorId = v.id;
    }
    // Referral: a code from another customer gives this booking a credit (not for the same household).
    let referredBy: string | null = null, credit = 0, referrer: Booking | null = null;
    const code = str(body.referralCode, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code) {
      const { data: rb } = await db().from("bookings").select("*").eq("referral_code", code).maybeSingle();
      const r = rb as Booking | null;
      if (r && norm(r.customer_email) !== norm(email) && toE164(r.customer_phone) !== phone && norm(r.street) !== norm(street) && r.status !== "pending_card") {
        referredBy = code; credit = extrasOf(s).referralCreditCents; referrer = r;
      }
    }
    const row = {
      ref: refCode(), access_token: token(), status: vendorId ? "pending_card" : "new", chosen_by_customer: !!vendorId,
      customer_name: name, customer_phone: phone, customer_email: email, sms_consent: body.smsConsent === true, street, zip: spec.zip,
      yard: { acres: spec.acres, terrain: spec.terrain, coverage: spec.coverage }, plan: spec.plan, addons: { fert: spec.fert, aerate: spec.aerate, leaves: spec.leaves, shrubs: spec.shrubs },
      custom: spec.custom, notes: str(body.notes, 1000), preferred_start: preferred, preferred_alt: alt, visit_window: window, vendor_id: vendorId, quote: q,
      prepay: body.prepay === true && spec.plan !== "One-time cut", credit_cents: credit, referred_by: referredBy, referral_code: referralCode(name)
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, error } = await db().from("bookings").insert(row).select("*").single();
      if (!error) {
        if (referrer) await db().from("referrals").insert({ code: referredBy, referrer_booking_id: referrer.id, referee_booking_id: data.id });
        await logEvent(data.id, vendorId, "created", vendorId ? "customer chose provider" : "request");
        if (!vendorId) await announceBooking(data as Booking);
        return { ref: data.ref, token: data.access_token, needsCard: !!vendorId, credit: credit / 100 };
      }
      if (error.code === "23505") { row.ref = refCode(); row.referral_code = referralCode(name); continue; }
      throw error;
    }
    throw new Error("Could not create booking");
  },

  async checkReferral(body) {
    const code = str(body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) return { valid: false };
    const { data } = await db().from("bookings").select("customer_name,status").eq("referral_code", code).maybeSingle();
    const s = await getSettings();
    return data && data.status !== "pending_card" ? { valid: true, from: firstName(data.customer_name), credit: extrasOf(s).referralCreditCents / 100 } : { valid: false };
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
    return openClaim(await bookingByToken(body.ref, body.token), str(body.description, 1000));
  },

  async claimByPhone(body) {
    if (str(body.website, 100)) throw new UserError("Check the form and try again.");
    const ref = str(body.ref, 20).toUpperCase();
    if (!/^MB-[A-Z0-9]{4,8}$/.test(ref)) throw new UserError("Enter your reference code, like MB-7K2Q9X.");
    const { data } = await db().from("bookings").select("*").eq("ref", ref).maybeSingle();
    const want = String(data?.customer_phone ?? "").replace(/\D/g, "").slice(-10), got = String(body.phone ?? "").replace(/\D/g, "").slice(-10);
    if (!data || want.length !== 10 || want !== got) throw new UserError("We couldn't find a booking with that code and phone number.");
    return openClaim(data as Booking, str(body.description, 1000));
  },

  // ---------- customer account (booking page) ----------
  async sendBookingLinks(body) {
    if (str(body.website, 100)) return { ok: true };
    const email = norm(str(body.email, 200));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("Enter the email you booked with.");
    const since = new Date(Date.now() - 10 * 60000).toISOString();
    const { count } = await db().from("notifications").select("id", { count: "exact", head: true }).eq("event", "account.links").eq("recipient", email).gte("created_at", since);
    if (count) return { ok: true };
    const { data } = await db().from("bookings").select("*").ilike("customer_email", email).neq("status", "pending_card").order("created_at", { ascending: false }).limit(20);
    const rows = (data ?? []) as Booking[];
    if (!rows.length) return { ok: true }; // same answer either way; never reveal who has an account
    const vendors = Object.fromEntries((((await db().from("vendors").select("id,business").in("id", rows.map((r) => r.vendor_id).filter(Boolean) as string[])).data) ?? []).map((v: { id: string; business: string }) => [v.id, v.business]));
    await sendEmail("account.links", email, "Your MowBrokers bookings", `Hi ${firstName(rows[0].customer_name)},\n\nHere are the private links to your bookings. Each one shows visit reports, receipts and lets you request a free re-service, pause or cancel.\n\n${rows.map((r) => `${r.ref} · ${r.street} · ${r.plan} · ${r.vendor_id ? vendors[r.vendor_id] ?? "" : "matching"} · ${r.status}\n${bookingLink(r.ref, r.access_token)}`).join("\n\n")}\n\nDidn't ask for this? You can ignore it.`);
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
    const comment = str(body.comment, 1000);
    const parts = b.customer_name.trim().split(/\s+/);
    const label = `${parts[0]}${parts.length > 1 ? " " + parts[parts.length - 1][0].toUpperCase() + "." : ""}`;
    const { data: prev } = await db().from("reviews").select("id,created_at").eq("booking_id", b.id).maybeSingle();
    if (prev && Date.now() - new Date(prev.created_at).getTime() > 90 * 86400000) throw new UserError("Reviews can be edited for 90 days.");
    await db().from("reviews").upsert({ booking_id: b.id, vendor_id: b.vendor_id, rating, comment, customer_label: label, updated_at: new Date().toISOString() }, { onConflict: "booking_id" });
    await logEvent(b.id, b.vendor_id, "review", `${rating}★`);
    if (rating <= 2) await notifyAdmin("review.low", `${rating}-star review on ${b.ref}`, `${b.customer_name}: "${comment}"\nCall the customer and the provider.`, `${rating}-star review on ${b.ref}. Check the console.`);
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
    await sendEmail("booking.paused", b.customer_email, `Service paused until ${fmtDate(until)}`, `Hi ${firstName(b.customer_name)},\n\nYour service is paused until ${fmtDate(until)}. Nothing is charged while paused. Resume anytime: ${bookingLink(b.ref, b.access_token)}`);
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
    return { refund: (await unusedPrepayCents(b)) / 100 };
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
      const map: Record<string, string> = { aerate: "aeration", leaves: "leafCleanup", shrubs: "shrubTrim" };
      if (v.rate_card?.addons?.[map[key] as keyof RateCard["addons"]] == null) throw new UserError(`${v.business} doesn't offer that service.`);
    }
    const addons = { ...b.addons };
    if (key === "shrubs") addons.shrubs = Math.min(3, Math.max(1, Math.round(Number(body.count) || 1)));
    else (addons as Record<string, unknown>)[key] = true;
    const s = await getSettings();
    const nq = { ...withAddons(s, v.rate_card, b.quote, specOf(b), addons), takeRate: b.quote.takeRate };
    await db().from("bookings").update({ addons, quote: nq }).eq("id", b.id);
    const label = { fert: `Fertilizer and weed control (${s.fertApps} applications)`, aerate: "Core aeration", leaves: "Fall leaf cleanup", shrubs: `Shrub trimming ×${addons.shrubs}` }[key];
    await logEvent(b.id, v.id, "addon", label);
    await sendEmail("booking.addon", v.email, `Add-on: ${label} — ${b.ref}`, `${b.customer_name} (${b.ref}) added ${label} at your posted price. It now shows in the visit form in your portal.`);
    await sendEmail("booking.addon", b.customer_email, `${label} added`, `Hi ${firstName(b.customer_name)},\n\nYou added ${label} with ${v.business}. Your plan is now ${usd(nq.annual)} a year${b.prepay_payment_id ? " (the add-on is billed per visit this season, outside your prepay)" : ""}, charged after each service.\n\nYour account: ${bookingLink(b.ref, b.access_token)}`);
    return { ok: true, quote: nq };
  },

  async requestInspection(body) {
    const b = await bookingByToken(body.ref, body.token);
    const job = str(body.job, 60);
    if (!CUSTOM_JOBS.includes(job)) throw new UserError("Choose a service.");
    const v = await vendorOf(b);
    if (!v) throw new UserError("Your pro isn't available right now.");
    const need = (JOB_CATEGORY as Record<string, string>)[job];
    if (!(v.custom_jobs || []).includes(job) || (need && !v.categories.includes(need))) throw new UserError(`${v.business} doesn't take that job.`);
    const note = str(body.note, 500);
    await logEvent(b.id, v.id, "inspection_request", job);
    await sendEmail("inspection.request", v.email, `Inspection request: ${job} — ${b.ref}`, `${b.customer_name} (${b.customer_phone}, ${b.street} ${b.zip}) asked for a ${job.toLowerCase()} inspection and quote.${note ? `\n\nThey say: ${note}` : ""}\n\nCall them to set it up.`);
    await notifyAdmin("inspection.request", `${job} inspection on ${b.ref}`, `${b.customer_name} → ${v.business}`);
    return { ok: true };
  },

  async unsubscribe(body) {
    const b = await bookingByToken(body.ref, body.token);
    await db().from("bookings").update({ marketing_opt_out: body.on !== false }).eq("id", b.id);
    return { ok: true };
  }
});
void ADDONS;
