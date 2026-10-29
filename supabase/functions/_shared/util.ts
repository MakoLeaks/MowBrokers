const ALPHA = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const refCode = () => "MB-" + Array.from(rand(6)).map((x) => ALPHA[x % ALPHA.length]).join("");
export const token = () => btoa(String.fromCharCode(...rand(24))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function slugify(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "pro";
  return `${base}-${Array.from(rand(2)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
export function toE164(phone: unknown): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
export const usd = (n: number, d = 0) => "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso.length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}
export const daysUntil = (d: string | null | undefined) => (d ? Math.ceil((new Date(d + "T12:00:00").getTime() - Date.now()) / 86400000) : 9999);
export const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
export const CHECKS: [string, string][] = [
  ["business", "City business license verified"], ["license", "ADAI Horticulture license and OTPS certified operator verified (only if offering treatments)"],
  ["insurance", "Certificate of insurance verified with carrier"], ["background", "Background checks on owner and crew who visit homes"],
  ["references", "Three customer references called"], ["rideAlong", "Ride-along on a regular mowing route"], ["agreement", "Provider agreement signed"]
];
