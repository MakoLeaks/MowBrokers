import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";
import { env } from "./env.ts";
import { DEFAULT_SETTINGS, extrasOf } from "./pricing.mjs";
import type { Settings } from "./types.ts";

let client: SupabaseClient | null = null;
/** Service-role client: bypasses RLS. Every handler must check permissions first. */
export function db(): SupabaseClient {
  if (!client) client = createClient(env.supabaseUrl(), env.serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export async function getSettings(): Promise<Settings> {
  const { data } = await db().from("settings").select("*").eq("id", 1).maybeSingle();
  if (!data) return DEFAULT_SETTINGS as Settings;
  return { takeRate: Number(data.take_rate), roundTo: data.round_to, goalPairs: data.goal_pairs, season: data.season ?? DEFAULT_SETTINGS.season, fertApps: data.fert_apps ?? DEFAULT_SETTINGS.fertApps, lots: data.lots, terrains: data.terrains, coverages: data.coverages, suggested: data.suggested, extras: extrasOf({ extras: data.extras }) } as Settings;
}

/** The signed-in user calling this function, from their Authorization header. */
export async function callerUser(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db().auth.getUser(jwt);
  return data.user ?? null;
}

export async function isAdmin(userId: string) {
  const { data } = await db().from("profiles").select("role").eq("id", userId).maybeSingle();
  return data?.role === "admin";
}

/** Append to a booking's timeline (also feeds provider scorecards). Never throws. */
export async function logEvent(bookingId: string | null, vendorId: string | null, type: string, detail = "") {
  try { await db().from("booking_events").insert({ booking_id: bookingId, vendor_id: vendorId, type, detail: detail.slice(0, 500) }); } catch { /* ignore */ }
}
