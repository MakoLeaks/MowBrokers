// Edge Function secrets. Set them with: supabase secrets set NAME=value (see docs/LAUNCH.md).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by Supabase.
function need(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}. Run: supabase secrets set ${name}=...`);
  return v;
}
const opt = (name: string, d = "") => Deno.env.get(name) || d;
export const env = {
  supabaseUrl: () => need("SUPABASE_URL"),
  serviceKey: () => need("SUPABASE_SERVICE_ROLE_KEY"),
  siteUrl: () => opt("SITE_URL", "http://localhost:8080").replace(/\/$/, ""),
  stripeSecret: () => need("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: () => opt("STRIPE_WEBHOOK_SECRET"),
  stripeConnectWebhookSecret: () => opt("STRIPE_CONNECT_WEBHOOK_SECRET"),
  resendKey: () => opt("RESEND_API_KEY"),
  emailFrom: () => opt("EMAIL_FROM", "MowBrokers <onboarding@resend.dev>"),
  twilioSid: () => opt("TWILIO_ACCOUNT_SID"),
  twilioToken: () => opt("TWILIO_AUTH_TOKEN"),
  twilioService: () => opt("TWILIO_MESSAGING_SERVICE_SID"),
  adminEmail: () => opt("ADMIN_NOTIFY_EMAIL"),
  adminPhone: () => opt("ADMIN_NOTIFY_PHONE"),
  cronSecret: () => opt("CRON_SECRET"),
  allowedOrigins: () => opt("ALLOWED_ORIGINS", "*")
};
