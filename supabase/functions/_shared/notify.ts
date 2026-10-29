import { env } from "./env.ts";
import { db } from "./db.ts";
import { toE164 } from "./util.ts";

// Best effort: failures are logged to the notifications table and never block a booking.
async function log(event: string, channel: string, recipient: string, ok: boolean, error?: string) {
  try { await db().from("notifications").insert({ event, channel, recipient, ok, error: error?.slice(0, 500) ?? null }); } catch { /* ignore */ }
}

export async function sendEmail(event: string, to: string | null | undefined, subject: string, text: string) {
  if (!to) return;
  const key = env.resendKey();
  if (!key) return log(event, "email", to, false, "RESEND_API_KEY not set");
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.emailFrom(), to: [to], subject, text: text + "\n\n— MowBrokers\nThe right lawn pro, matched." })
    });
    await log(event, "email", to, r.ok, r.ok ? undefined : await r.text());
  } catch (e) { await log(event, "email", to, false, String(e)); }
}

export async function sendSms(event: string, to: string | null | undefined, body: string) {
  const num = to ? toE164(to) : null;
  if (!num) return;
  const sid = env.twilioSid(), tok = env.twilioToken(), svc = env.twilioService();
  if (!sid || !tok || !svc) return log(event, "sms", num, false, "Twilio not configured");
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST", headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: num, MessagingServiceSid: svc, Body: `MowBrokers: ${body} Reply STOP to opt out.` })
    });
    await log(event, "sms", num, r.ok, r.ok ? undefined : await r.text());
  } catch (e) { await log(event, "sms", num, false, String(e)); }
}

export async function notifyAdmin(event: string, subject: string, text: string, sms?: string) {
  await Promise.all([sendEmail(event, env.adminEmail(), `[Ops] ${subject}`, text), sms ? sendSms(event, env.adminPhone(), sms) : Promise.resolve()]);
}

export const bookingLink = (ref: string, tok: string) => `${env.siteUrl()}/booking.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(tok)}`;
