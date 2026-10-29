// Scheduled jobs, triggered by pg_cron with header x-cron-secret (see migrations 0002 and 0003).
//   {"task":"hourly"}  provider response deadlines (one business day to log a call)
//   anything else      the 8am daily run: reminders, seasonal offers, provider status, digest
import { env } from "../_shared/env.ts";
import { db, getSettings, logEvent } from "../_shared/db.ts";
import { bookingLink, notifyAdmin, sendEmail, sendSms } from "../_shared/notify.ts";
import { quote } from "../_shared/pricing.mjs";
import { syncProviderStatus } from "../_shared/payments.ts";
import { addDays, enforceResponseDeadlines, firstName, specOf, todayCT } from "../_shared/services.ts";
import { daysUntil, fmtDate, usd } from "../_shared/util.ts";
import type { Booking, RateCard, Vendor } from "../_shared/types.ts";

const DAY = 86400000;
async function once(b: Booking, type: string, fn: () => Promise<unknown>) {
  const { count } = await db().from("booking_events").select("id", { count: "exact", head: true }).eq("booking_id", b.id).eq("type", type);
  if (count) return false;
  await fn();
  await logEvent(b.id, b.vendor_id, type);
  return true;
}

// Seasonal add-on offers. Start dates are simple calendar defaults, not agronomic advice; adjust to taste.
const CAMPAIGNS = [
  { key: "fert", start: "02-15", addon: "fert", rate: null },
  { key: "aeration", start: "08-15", addon: "aerate", rate: "aeration" },
  { key: "leaves", start: "10-01", addon: "leaves", rate: "leafCleanup" }
] as const;

Deno.serve(async (req) => {
  const given = req.headers.get("x-cron-secret") ?? "";
  const fromEnv = env.cronSecret() && given === env.cronSecret();
  const fromDb = given.length >= 32 && (await db().rpc("check_cron_secret", { p_secret: given })).data === true;
  if (!fromEnv && !fromDb) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  let task = "daily";
  try { task = (await req.json())?.task ?? "daily"; } catch { /* empty body */ }
  const out: string[] = [];

  out.push(...(await enforceResponseDeadlines()));
  if (task === "hourly") return new Response(JSON.stringify({ ok: true, task, actions: out }), { headers: { "Content-Type": "application/json" } });

  const now = Date.now(), today = todayCT();

  // Called but not scheduled after 2 days: nudge the provider (once a day).
  const { data: stale } = await db().from("bookings").select("*").eq("status", "matched").not("contacted_at", "is", null).lt("contacted_at", new Date(now - 2 * DAY).toISOString());
  for (const b of (stale ?? []) as Booking[]) {
    if (b.nudged_at && now - new Date(b.nudged_at).getTime() < DAY) continue;
    const { data: v } = await db().from("vendors").select("business,email,phone").eq("id", b.vendor_id).single();
    if (!v) continue;
    await sendSms("nudge.schedule", v.phone, `Reminder: ${b.customer_name} (${b.ref}) still needs a first visit date. Mark it scheduled in your portal.`);
    await sendEmail("nudge.schedule", v.email, `Reminder: schedule ${b.customer_name} (${b.ref})`, `You called ${b.customer_name} but haven't set a first visit yet: ${b.customer_phone}. Once you have a date, mark it scheduled in your portal: ${env.siteUrl()}/portal.html`);
    await db().from("bookings").update({ nudged_at: new Date().toISOString() }).eq("id", b.id);
    out.push(`schedule nudge ${b.ref}`);
  }

  // Customers who picked a pro but never saved a card.
  const { data: unfinished } = await db().from("bookings").select("*").eq("status", "pending_card").is("nudged_at", null).lt("created_at", new Date(now - DAY).toISOString()).gt("created_at", new Date(now - 7 * DAY).toISOString());
  for (const b of (unfinished ?? []) as Booking[]) {
    await sendEmail("nudge.card", b.customer_email, `Finish booking your lawn pro — ${b.ref}`, `Hi ${firstName(b.customer_name)},\n\nYour price is held, but your pro isn't notified until you save a card. You're charged only after each visit.\n\nFinish here: ${bookingLink(b.ref, b.access_token)}&card=1`);
    await db().from("bookings").update({ nudged_at: new Date().toISOString() }).eq("id", b.id);
    out.push(`card reminder ${b.ref}`);
  }

  // Providers: insurance warnings and Stripe payout status (Accounts v2 sends no account.updated).
  const { data: vendors } = await db().from("vendors").select("*").in("status", ["approved", "vetting", "applied"]);
  const vById: Record<string, Vendor> = {};
  for (const v of (vendors ?? []) as Vendor[]) {
    vById[v.id] = v;
    if (v.stripe_account_id && !v.stripe_charges_enabled) {
      try { if (await syncProviderStatus(v.stripe_account_id)) { v.stripe_charges_enabled = true; out.push(`payouts live ${v.business}`); } } catch (e) { console.error("sync", v.id, e); }
    }
    if (v.status !== "approved") continue;
    const d = daysUntil(v.insurance_expires);
    if (![30, 14, 3, 0].includes(d)) continue;
    await sendEmail("insurance.expiring", v.email, d > 0 ? `Your insurance expires ${fmtDate(v.insurance_expires)}` : "Your insurance expired today", `Hi ${v.contact},\n\n${d > 0 ? `Your general liability policy on file expires in ${d} days.` : "Your policy on file has expired, so customers can't see you on MowBrokers."} Upload your renewed certificate and new expiration date in your portal: ${env.siteUrl()}/profile.html`);
    out.push(`insurance ${v.business} ${d}d`);
  }

  // Active customers: auto-resume, visit reminders, prepay renewals, seasonal offers.
  const { data: act } = await db().from("bookings").select("*").in("status", ["scheduled", "active"]).limit(5000);
  const active = (act ?? []) as Booking[];
  const s = await getSettings();
  const mmdd = today.slice(5), year = today.slice(0, 4);
  let offers = 0, overdue = 0;
  for (const b of active) {
    const v = b.vendor_id ? vById[b.vendor_id] : null;
    if (b.paused_until && b.paused_until < today) {
      await db().from("bookings").update({ paused_until: null }).eq("id", b.id);
      await logEvent(b.id, b.vendor_id, "resumed", "pause ended");
      if (v) await sendEmail("booking.resumed", v.email, `Service resumes — ${b.ref}`, `${b.customer_name}'s pause ended. Call ${b.customer_phone} to schedule the next visit.`);
      b.paused_until = null;
      out.push(`resumed ${b.ref}`);
    }
    if (b.paused_until || !v || b.plan === "One-time cut") continue;
    const due = b.next_visit_due;
    if (due === addDays(today, 7)) await once(b, `due_provider:${due}`, () => sendEmail("visit.due", v.email, `Visit due ${fmtDate(due)}: ${b.customer_name} (${b.ref})`, `${b.customer_name}'s next ${b.plan.toLowerCase()} visit is due around ${fmtDate(due)}. Call ${b.customer_phone} to schedule${b.visit_window !== "any" ? ` (prefers ${b.visit_window}s)` : ""}, then mark it in your portal: ${env.siteUrl()}/portal.html`));
    if (due === addDays(today, 5)) await once(b, `due_customer:${due}`, () => sendEmail("visit.due", b.customer_email, `Your next visit is coming up`, `Hi ${firstName(b.customer_name)},\n\nYour next lawn care visit with ${v.business} is due around ${fmtDate(due)}. They'll reach out to schedule. Need to skip a visit? Pause from your account: ${bookingLink(b.ref, b.access_token)}`));
    if (due && due < addDays(today, -14)) {
      overdue++;
      await once(b, `overdue:${due}:${Math.floor(now / (7 * DAY))}`, () => sendEmail("visit.overdue", v.email, `Overdue visit: ${b.customer_name} (${b.ref})`, `${b.customer_name}'s visit was due ${fmtDate(due)} and hasn't been logged. Schedule it, or log it with “Visit done” in your portal if it already happened: ${env.siteUrl()}/portal.html`));
    }
    if (b.prepay && b.prepaid_through === addDays(today, 30)) await once(b, `prepay_renew:${b.prepaid_through}`, () => sendEmail("prepay.renewal", b.customer_email, "Your prepaid season ends in 30 days", `Hi ${firstName(b.customer_name)},\n\nYour prepaid lawn care with ${v.business} runs through ${fmtDate(b.prepaid_through)}. Next season's prepay (${usd(b.quote?.prepay ?? 0)}, ${Math.round((b.quote?.prepayDiscount ?? 0.05) * 100)}% off) is charged at your first visit after that. Prefer to pay per visit? Switch anytime: ${bookingLink(b.ref, b.access_token)}`));

    // Seasonal add-on offers (3-week window after each season's start date, once a year each).
    if (b.marketing_opt_out || !b.customer_email || offers >= 150) continue;
    for (const c of CAMPAIGNS) {
      const end = new Date(`${year}-${c.start}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 21);
      if (mmdd < c.start || today > end.toISOString().slice(0, 10)) continue;
      if ((b.addons as Record<string, unknown>)[c.addon]) continue;
      if (c.rate ? v.rate_card?.addons?.[c.rate as keyof RateCard["addons"]] == null : (!v.rate_card?.fertTiers || !v.categories.includes("OTPS"))) continue;
      const x = quote(s, v.rate_card, { ...specOf(b), fert: true, aerate: true, leaves: true });
      const link = bookingLink(b.ref, b.access_token);
      const off = `\n\nDon't want seasonal offers? Turn them off: ${link}#prefs`;
      const msg = {
        fert: ["Add fertilizer and weed control this year", `${v.business} offers a ${s.fertApps}-application fertilizer and weed control program for your yard at ${usd(x.fertPerApp)} per application, billed after each application like your cuts.\n\nAdd it: ${link}#addons`],
        aeration: ["Core aeration for your lawn", `${v.business} offers core aeration for your yard for ${usd(x.aeration)}, once a year, billed after it's done.\n\nAdd it: ${link}#addons`],
        leaves: ["Fall leaf cleanup", `${v.business} offers a one-time fall leaf cleanup for your yard for ${usd(x.leaves)}, billed after it's done.\n\nAdd it: ${link}#addons`]
      }[c.key];
      const sent = await once(b, `offer:${c.key}:${year}`, () => sendEmail(`offer.${c.key}`, b.customer_email, msg[0], `Hi ${firstName(b.customer_name)},\n\n${msg[1]}${off}`));
      if (sent) { offers++; break; }
    }
  }
  if (offers) out.push(`seasonal offers ${offers}`);

  const [{ count: unmatched }, { count: open }, { count: applicants }, { count: misses }] = await Promise.all([
    db().from("bookings").select("id", { count: "exact", head: true }).eq("status", "new"),
    db().from("claims").select("id", { count: "exact", head: true }).eq("status", "open"),
    db().from("vendors").select("id", { count: "exact", head: true }).in("status", ["applied", "vetting"]),
    db().from("booking_events").select("id", { count: "exact", head: true }).eq("type", "sla_miss").gte("created_at", new Date(now - DAY).toISOString())
  ]);
  if ((unmatched ?? 0) + (open ?? 0) + (applicants ?? 0) + overdue + out.length > 0)
    await notifyAdmin("digest", "Morning digest", `Needs manual match: ${unmatched ?? 0}\nOpen re-service requests: ${open ?? 0}\nProviders in vetting: ${applicants ?? 0}\nVisits overdue 2+ weeks: ${overdue}\nMissed call deadlines (24h): ${misses ?? 0}\n\nAutomated today:\n${out.join("\n") || "nothing"}\n\n${env.siteUrl()}/admin.html`);
  return new Response(JSON.stringify({ ok: true, task, actions: out }), { headers: { "Content-Type": "application/json" } });
});
