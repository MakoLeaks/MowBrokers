// Provider actions. Requires a signed-in provider (Supabase Auth token in the Authorization header).
import { serveActions, UserError } from "../_shared/http.ts";
import { callerUser, db, getSettings, logEvent } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { CUSTOM_JOBS, validRateCard } from "../_shared/pricing.mjs";

const CATEGORIES = ["MOW", "OTPS", "SLP", "TS"];
import { createProviderAccount, providerOnboardingUrl, stripe, syncProviderStatus } from "../_shared/payments.ts";
import { completeVisit, retryPayment, visitOptions } from "../_shared/services.ts";
import { bookingLink, notifyAdmin, sendEmail, sendSms } from "../_shared/notify.ts";
import { fmtDate, isDate, slugify, str, toE164 } from "../_shared/util.ts";
import type { Booking, Vendor } from "../_shared/types.ts";

async function me(req: Request) {
  const user = await callerUser(req);
  if (!user) throw new UserError("Please sign in again.");
  const { data } = await db().from("vendors").select("*").eq("owner_id", user.id).maybeSingle();
  return { user, vendor: (data as Vendor) ?? null };
}
async function mine(req: Request, bookingId: unknown) {
  const { vendor } = await me(req);
  if (!vendor) throw new UserError("No provider profile.");
  const { data } = await db().from("bookings").select("*").eq("id", str(bookingId, 60)).maybeSingle();
  if (!data || data.vendor_id !== vendor.id) throw new UserError("That booking isn't yours.");
  return { vendor, booking: data as Booking };
}

serveActions({
  async saveProfile(body, req) {
    const { user, vendor } = await me(req);
    const f = (body.profile ?? {}) as Record<string, unknown>;
    const business = str(f.business, 120), contact = str(f.contact, 120), phone = toE164(f.phone), email = str(f.email, 200);
    const license = str(f.license, 60), operator = str(f.operator, 120), carrier = str(f.insurance_carrier, 120);
    const categories = (Array.isArray(f.categories) ? f.categories : []).filter((c): c is string => CATEGORIES.includes(String(c)));
    const zips = (Array.isArray(f.zips) ? f.zips : []).map(String).filter((z) => /^\d{5}$/.test(z)).slice(0, 200);
    const custom_jobs = (Array.isArray(f.custom_jobs) ? f.custom_jobs : []).map(String).filter((c) => CUSTOM_JOBS.includes(c));
    const treats = categories.some((c) => c !== "MOW");
    const errs: [boolean, string][] = [
      [business.length < 2, "Enter your business name."], [contact.length < 2, "Enter an owner or contact name."], [!phone, "Enter a 10-digit business phone."],
      [!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "Enter a valid business email."], [license.length < 2, treats ? "Enter your ADAI Horticulture Professional Services license number." : "Enter your city business license number."],
      [treats && operator.length < 2, "Enter your certified operator's name."], [!categories.length, "Choose at least one service category."],
      [carrier.length < 2, "Enter your insurance carrier."], [!isDate(f.insurance_expires), "Enter your policy expiration date."],
      [!zips.length, "List at least one ZIP code you serve."], [f.agree !== true, "Accept the program terms to continue."]
    ];
    const e = errs.find(([bad]) => bad);
    if (e) throw new UserError(e[1]);
    const s = await getSettings();
    if (!validRateCard(f.rate_card, s.lots.length)) throw new UserError("Check your prices: every lot size needs a price, and percentages must be reasonable.");
    const row = {
      business, contact, phone, email, license, operator, categories, zips, custom_jobs, rate_card: f.rate_card,
      years: Math.max(0, Math.min(150, Math.round(Number(f.years) || 0))), techs: Math.max(1, Math.min(1000, Math.round(Number(f.techs) || 1))),
      about: str(f.about, 1200), insurance_carrier: carrier, insurance_coverage: Math.max(0, Math.min(100_000_000, Math.round(Number(f.insurance_coverage) || 0))),
      insurance_expires: String(f.insurance_expires), updated_at: new Date().toISOString()
    };
    if (!vendor) {
      const { error } = await db().from("vendors").insert({ ...row, owner_id: user.id, slug: slugify(business), status: "applied" });
      if (error) throw error;
      await notifyAdmin("vendor.applied", `New provider application: ${business}`, `${contact} · ${phone} · ${email}\nLicense ${license} · ${categories.join(", ")}. Start vetting in the console.`, `New provider application: ${business}.`);
      return { created: true };
    }
    const credentialChange = vendor.status === "approved" && (vendor.license !== license || vendor.insurance_expires !== row.insurance_expires || vendor.insurance_carrier !== carrier);
    const { error } = await db().from("vendors").update(row).eq("id", vendor.id);
    if (error) throw error;
    if (credentialChange) await notifyAdmin("vendor.credentials", `${business} changed license or insurance`, "Re-verify their credentials in the console.");
    return { created: false };
  },

  async coiUploadUrl(body, req) {
    const { vendor } = await me(req);
    if (!vendor) throw new UserError("Save your company details first.");
    const ext = str(body.fileName, 200).split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    if (!["pdf", "png", "jpg", "jpeg"].includes(ext)) throw new UserError("Upload a PDF, PNG or JPG.");
    const path = `${vendor.id}/${Date.now()}.${ext}`;
    const { data, error } = await db().storage.from("coi").createSignedUploadUrl(path);
    if (error || !data) throw new UserError("Upload isn't available right now.");
    return { path, token: data.token };
  },

  async saveCoiPath(body, req) {
    const { vendor } = await me(req);
    const path = str(body.path, 200);
    if (!vendor || !path.startsWith(vendor.id + "/")) throw new UserError("Not allowed.");
    await db().from("vendors").update({ coi_path: path }).eq("id", vendor.id);
    await notifyAdmin("vendor.coi", `${vendor.business} uploaded an insurance certificate`, "Verify it in the console.");
    return { ok: true };
  },

  async stripeOnboarding(_b, req) {
    const { vendor } = await me(req);
    if (!vendor) throw new UserError("Save your company details first.");
    let acct = vendor.stripe_account_id;
    if (!acct) {
      acct = await createProviderAccount(vendor);
      await db().from("vendors").update({ stripe_account_id: acct }).eq("id", vendor.id);
    }
    return { url: await providerOnboardingUrl(acct, `${env.siteUrl()}/portal.html?stripe=refresh`, `${env.siteUrl()}/portal.html?stripe=return`) };
  },

  async stripeDashboard(_b, req) {
    const { vendor } = await me(req);
    if (!vendor?.stripe_account_id) throw new UserError("Connect Stripe first.");
    try { return { url: (await stripe().accounts.createLoginLink(vendor.stripe_account_id)).url }; }
    catch { throw new UserError("Finish Stripe setup first."); }
  },

  async refreshStripe(_b, req) {
    const { vendor } = await me(req);
    if (!vendor?.stripe_account_id) return { charges: false };
    return { charges: await syncProviderStatus(vendor.stripe_account_id) };
  },

  async schedule(body, req) {
    if (!isDate(body.date)) throw new UserError("Choose a visit date.");
    const { vendor, booking: b } = await mine(req, body.bookingId);
    if (!["matched", "scheduled", "active"].includes(b.status)) throw new UserError("This booking can't be scheduled now.");
    const date = String(body.date);
    const first = b.status === "matched";
    await db().from("bookings").update({ status: first ? "scheduled" : b.status, ...(first ? { first_visit: date, scheduled_at: new Date().toISOString() } : { next_visit_due: date }), contacted_at: b.contacted_at ?? new Date().toISOString(), respond_by: null }).eq("id", b.id);
    await logEvent(b.id, vendor.id, "scheduled", date);
    const link = bookingLink(b.ref, b.access_token);
    await sendEmail("booking.scheduled", b.customer_email, `${first ? "First visit" : "Next visit"} set for ${fmtDate(date)} — ${b.ref}`, `Hi ${b.customer_name.split(" ")[0]},\n\n${vendor.business} scheduled your ${first ? "first" : "next"} visit for ${fmtDate(date)}. Your card is charged after the visit.\n\nYour account: ${link}`);
    if (b.sms_consent) await sendSms("booking.scheduled", b.customer_phone, `${vendor.business} set your ${first ? "first" : "next"} visit for ${fmtDate(date)}. Details: ${link}`);
    return { ok: true };
  },

  async markContacted(body, req) {
    const { vendor, booking: b } = await mine(req, body.bookingId);
    if (b.status !== "matched") return { ok: true };
    await db().from("bookings").update({ contacted_at: new Date().toISOString(), respond_by: null }).eq("id", b.id);
    await logEvent(b.id, vendor.id, "contacted", str(body.note, 200));
    return { ok: true };
  },

  async visitOptions(body, req) {
    const { booking: b } = await mine(req, body.bookingId);
    return { options: await visitOptions(b, isDate(body.date) ? String(body.date) : undefined) };
  },

  async visitPhotoUploadUrl(body, req) {
    const { vendor, booking: b } = await mine(req, body.bookingId);
    const ext = str(body.fileName, 200).split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    if (!["jpg", "jpeg", "png", "webp", "heic"].includes(ext)) throw new UserError("Upload a JPG, PNG, WEBP or HEIC photo.");
    const path = `${vendor.id}/${b.id}/${Date.now()}.${ext}`;
    const { data, error } = await db().storage.from("visit-photos").createSignedUploadUrl(path);
    if (error || !data) throw new UserError("Photo upload isn't available right now.");
    return { path, token: data.token };
  },

  async completeVisit(body, req) {
    const { booking: b } = await mine(req, body.bookingId);
    return completeVisit(b.id, { date: body.date, items: body.items, notes: body.notes, photoPath: body.photoPath }, "provider");
  },

  async retryPayment(body, req) {
    const { vendor } = await me(req);
    const { data } = await db().from("payments").select("vendor_id").eq("id", str(body.paymentId, 60)).maybeSingle();
    if (!vendor || !data || data.vendor_id !== vendor.id) throw new UserError("Not allowed.");
    return retryPayment(String(body.paymentId));
  },

  async claim(body, req) {
    const { vendor } = await me(req);
    const status = String(body.status);
    if (!["vendor_notified", "resolved"].includes(status)) throw new UserError("Unknown status.");
    const { data } = await db().from("claims").select("vendor_id").eq("id", str(body.claimId, 60)).maybeSingle();
    if (!vendor || !data || data.vendor_id !== vendor.id) throw new UserError("Not allowed.");
    await db().from("claims").update({ status, resolved_at: status === "resolved" ? new Date().toISOString() : null }).eq("id", String(body.claimId));
    return { ok: true };
  }
});
