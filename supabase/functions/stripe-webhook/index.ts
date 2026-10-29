// Stripe webhook. Endpoint: https://YOUR-PROJECT-REF.supabase.co/functions/v1/stripe-webhook
// Platform events: setup_intent.succeeded, payment_intent.succeeded, payment_intent.payment_failed, charge.dispute.created
// Connected-account events (second endpoint, same URL): account.updated
// Verified by signing secret when one matches; otherwise the event is re-fetched from Stripe by id with the secret key.
import type Stripe from "npm:stripe@16.12.0";
import { env } from "../_shared/env.ts";
import { db } from "../_shared/db.ts";
import { cryptoProvider, notifyCardProblem, sendReceipt, stripe, syncProviderStatus } from "../_shared/payments.ts";
import { attachCardFromSetupIntent } from "../_shared/services.ts";
import { notifyAdmin } from "../_shared/notify.ts";
import type { Booking } from "../_shared/types.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Use POST", { status: 405 });
  const sig = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();
  let event: Stripe.Event | null = null;
  for (const secret of [env.stripeWebhookSecret(), env.stripeConnectWebhookSecret()].filter(Boolean)) {
    try { event = await stripe().webhooks.constructEventAsync(body, sig, secret, undefined, cryptoProvider); break; } catch { /* next */ }
  }
  // Fallback when no signing secret matches (or none is set): never trust the posted body. Re-fetch the event
  // from Stripe by id with our secret key, so only genuine events on our account (or a connected account) are processed.
  if (!event) {
    try {
      const claimed = JSON.parse(body) as { id?: unknown; account?: unknown };
      const id = typeof claimed.id === "string" && /^evt_[A-Za-z0-9]+$/.test(claimed.id) ? claimed.id : null;
      const acct = typeof claimed.account === "string" && /^acct_[A-Za-z0-9]+$/.test(claimed.account) ? claimed.account : null;
      if (id) event = await stripe().events.retrieve(id, undefined, acct ? { stripeAccount: acct } : undefined);
    } catch { /* not a real event */ }
  }
  if (!event) return new Response(JSON.stringify({ error: "bad signature" }), { status: 400 });
  try {
    switch (event.type) {
      case "setup_intent.succeeded":
        await attachCardFromSetupIntent(event.data.object as Stripe.SetupIntent);
        break;
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed": {
        const pi = event.data.object as Stripe.PaymentIntent;
        const { data: pay } = await db().from("payments").select("*").eq("stripe_payment_intent_id", pi.id).maybeSingle();
        if (!pay) break;
        const ok = event.type === "payment_intent.succeeded";
        if (pay.status === (ok ? "succeeded" : "failed")) break;
        const msg = ok ? null : pi.last_payment_error?.message ?? "Card was declined.";
        await db().from("payments").update({ status: ok ? "succeeded" : "failed", failure_message: msg }).eq("id", pay.id);
        const { data: b } = await db().from("bookings").select("*").eq("id", pay.booking_id).single();
        if (ok && pay.status === "processing") await sendReceipt(b as Booking, pay.label, pay.amount_cents / 100);
        if (!ok) await notifyCardProblem(b as Booking, pay.label, pay.amount_cents / 100, msg);
        break;
      }
      case "account.updated": {
        const a = event.data.object as Stripe.Account;
        await syncProviderStatus(a.id); // v2 capability status is the source of truth
        break;
      }
      case "charge.dispute.created": {
        const d = event.data.object as Stripe.Dispute;
        await notifyAdmin("dispute", `Chargeback opened: $${(d.amount / 100).toFixed(2)}`, `Reason: ${d.reason}. Respond in the Stripe dashboard before the deadline.`, "A customer opened a chargeback. Check Stripe.");
        break;
      }
    }
  } catch (e) {
    console.error("webhook", event.type, e);
    return new Response(JSON.stringify({ error: "handler failed" }), { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
