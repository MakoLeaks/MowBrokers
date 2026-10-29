import Stripe from "npm:stripe@16.12.0";
import { env } from "./env.ts";
import { db } from "./db.ts";
import type { Booking, Vendor } from "./types.ts";
import { bookingLink, notifyAdmin, sendEmail, sendSms } from "./notify.ts";
import { usd } from "./util.ts";

let s: Stripe | null = null;
export function stripe(): Stripe {
  if (!s) s = new Stripe(env.stripeSecret(), { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient(), appInfo: { name: "MowBrokers" } });
  return s;
}
export const cryptoProvider = Stripe.createSubtleCryptoProvider();

// ---------- Connect: provider accounts (Stripe Accounts v2) ----------
// Stripe blocks v1 account creation (type: "express") for new Connect platforms. Providers are v2 "recipient"
// accounts with the Express Dashboard; the platform is merchant of record and pays them by destination charge.
const V2_VERSION = "2026-09-30.preview";
async function stripeV2<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const r = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.stripeSecret()}`, "Stripe-Version": V2_VERSION, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${method} ${path}: ${j?.error?.message ?? r.status}`);
  return j as T;
}

export async function createProviderAccount(v: Vendor): Promise<string> {
  const a = await stripeV2<{ id: string }>("POST", "/v2/core/accounts", {
    contact_email: v.email,
    display_name: v.business,
    dashboard: "express",
    identity: { country: "us" },
    defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    metadata: { vendor_id: v.id }
  });
  // Weekly Friday payouts, as promised in the provider terms. Best effort: the onboarding still works without it.
  try { await stripe().accounts.update(a.id, { settings: { payouts: { schedule: { interval: "weekly", weekly_anchor: "friday" } } } }); }
  catch (e) { console.error("payout schedule", a.id, e); }
  return a.id;
}

export async function providerOnboardingUrl(account: string, refreshUrl: string, returnUrl: string): Promise<string> {
  const l = await stripeV2<{ url: string }>("POST", "/v2/core/account_links", {
    account,
    use_case: { type: "account_onboarding", account_onboarding: { refresh_url: refreshUrl, return_url: returnUrl } }
  });
  return l.url;
}

/** True once Stripe can transfer this provider's share to them (v2 recipient stripe_transfers capability active). */
export async function providerReady(account: string): Promise<boolean> {
  const a = await stripeV2<{ configuration?: { recipient?: { capabilities?: { stripe_balance?: { stripe_transfers?: { status?: string } } } } } }>(
    "GET", `/v2/core/accounts/${encodeURIComponent(account)}?include=configuration.recipient`);
  return a.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === "active";
}

export async function syncProviderStatus(account: string): Promise<boolean> {
  const ready = await providerReady(account);
  await db().from("vendors").update({ stripe_charges_enabled: ready, stripe_payouts_enabled: ready }).eq("stripe_account_id", account);
  return ready;
}

export async function ensureCustomer(b: Booking): Promise<string> {
  if (b.stripe_customer_id) return b.stripe_customer_id;
  const c = await stripe().customers.create({ name: b.customer_name, phone: b.customer_phone, email: b.customer_email || undefined, metadata: { booking_id: b.id, ref: b.ref } });
  await db().from("bookings").update({ stripe_customer_id: c.id }).eq("id", b.id);
  return c.id;
}

export async function sendReceipt(b: Booking, label: string, amount: number) {
  await sendEmail("payment.receipt", b.customer_email, `Receipt: ${label} ${usd(amount, 2)} — ${b.ref}`, `Hi ${b.customer_name},\n\nWe charged ${usd(amount, 2)} for your ${label.toLowerCase()}.\nMissed spot, or weeds back between treatments? Request a free re-service: ${bookingLink(b.ref, b.access_token)}`);
}

export async function notifyCardProblem(b: Booking, label: string, amount: number, why: string | null) {
  const link = bookingLink(b.ref, b.access_token) + "&card=1";
  await sendEmail("payment.failed", b.customer_email, `Action needed: update your card — ${b.ref}`, `Hi ${b.customer_name},\n\nWe couldn't charge ${usd(amount, 2)} for your ${label.toLowerCase()}${why ? ` (${why})` : ""}. Please update your card: ${link}`);
  if (b.sms_consent) await sendSms("payment.failed", b.customer_phone, `We couldn't charge your card for ${label.toLowerCase()}. Update it here: ${link}`);
  await notifyAdmin("payment.failed", `Card failed on ${b.ref}`, `${label} ${usd(amount, 2)} failed: ${why ?? "unknown"}`);
}
