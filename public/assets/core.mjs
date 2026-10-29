// Shared browser code for every MowBrokers page: Supabase client, Edge Function calls, formatting, page chrome.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";
import { DEFAULT_SETTINGS, ADDONS, extrasOf } from "./pricing.mjs";

const C = window.MB_CONFIG || {};
export const config = C;
export const configured = !!(C.supabaseUrl && C.supabaseAnonKey && !String(C.supabaseUrl).includes("YOUR-") && !String(C.supabaseAnonKey).includes("YOUR-"));
export const sb = configured ? createClient(C.supabaseUrl, C.supabaseAnonKey) : null;

/** Call an Edge Function action. Always resolves to {ok:true,data} or {ok:false,error}. */
export async function call(fn, action, payload = {}) {
  if (!sb) return { ok: false, error: "The site isn't connected to its database yet. Fill in assets/config.js." };
  try {
    const { data, error } = await sb.functions.invoke(fn, { body: { action, ...payload } });
    if (error) return { ok: false, error: "We couldn't reach the server. Check your connection and try again." };
    return data && typeof data === "object" ? data : { ok: false, error: "Unexpected response." };
  } catch { return { ok: false, error: "We couldn't reach the server. Check your connection and try again." }; }
}

// ---------- formatting ----------
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const usd = (n, d = 0) => (n < 0 ? "−" : "") + "$" + Math.abs(n || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const usdAuto = (n) => usd(n, n % 1 ? 2 : 0);
export const usdCents = (c) => usd((c || 0) / 100, 2);
export function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso.length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0);
export const daysUntil = (d) => (d ? Math.ceil((new Date(d + "T12:00:00").getTime() - Date.now()) / 86400000) : 9999);
export const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export function prettyPhone(p) { const d = String(p || "").replace(/\D/g, "").slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : esc(p); }
export const shortName = (n) => String(n || "").split(/\s+/).slice(0, 2).join(" ");

export const STATUS_LABEL = {
  pending_card: "Waiting for card", new: "Needs manual match", matched: "Awaiting pro", scheduled: "Scheduled", active: "Active", completed: "Completed", cancelled: "Cancelled",
  applied: "Applied", vetting: "Vetting", approved: "Live", rejected: "Rejected", suspended: "Suspended",
  open: "Open", vendor_notified: "Pro notified", resolved: "Resolved", processing: "Processing", succeeded: "Paid", failed: "Failed"
};
export const CHECKS = [["business", "City business license verified"], ["license", "ADAI Horticulture license and OTPS certified operator verified (only if offering treatments)"], ["insurance", "Certificate of insurance verified with carrier"], ["background", "Background checks on owner and crew who visit homes"], ["references", "Three customer references called"], ["rideAlong", "Ride-along on a regular mowing route"], ["agreement", "Provider agreement signed"]];
export const CATEGORIES = [["MOW", "Mowing & yard maintenance"], ["OTPS", "Ornamental & Turf Pest Control (OTPS): fertilizer, weed control"], ["SLP", "Setting of Landscape Plants (SLP)"], ["TS", "Tree Surgery (TS)"]];
export const CATEGORY_LABEL = { MOW: "Mowing & yard maintenance", OTPS: "Ornamental & Turf Pest Control (OTPS)", SLP: "Setting of Landscape Plants (SLP)", TS: "Tree Surgery (TS)" };
/** Vetting checks that apply to a provider (the ADAI check only if they offer treatments or other horticulture work). */
export const checksFor = (cats) => CHECKS.filter(([k]) => k !== "license" || (cats || []).some((c) => c !== "MOW"));
export const chip = (s, label) => `<span class="chip c-${esc(s)}">${esc(label || STATUS_LABEL[s] || s)}</span>`;
const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const badges = (cats, extra = "") => `<div class="badges">${extra}<span class="badge v">${TICK} Insured</span><span class="badge v">${TICK} MowBrokers vetted</span>${(cats || []).includes("OTPS") ? `<span class="badge v">${TICK} ADAI turf licensed</span>` : ""}</div>`;

export function quoteLines(plan, x) {
  const mow = plan === "One-time cut" ? "One-time cut" : plan === "No mowing" ? "" : `${plan === "Weekly" ? "Weekly" : "Every-two-weeks"} mowing, ${x.visits} cuts × ${usd(x.perVisit)}`;
  const rows = [[mow, x.mowing], [`Fertilizer and weed control, ${x.fertApps} × ${usd(x.fertPerApp)}`, x.fert], ["Bundle discount (with mowing)", x.bundle], ["Core aeration", x.aeration], ["Fall leaf cleanup", x.leaves], [`Shrub trimming, ${x.shrubVisit ? Math.round(x.shrubs / x.shrubVisit) : 0} × ${usd(x.shrubVisit)}`, x.shrubs]];
  rows.push([plan === "One-time cut" ? "Total" : "Season total", x.annual, true]);
  return `<div class="lines">${rows.filter(([, v]) => v).map(([l, v, sum]) => `<div class="${sum ? "sum" : ""}"><span>${l}</span><span class="num">${usd(v)}</span></div>`).join("")}</div>`;
}

// ---------- ratings ----------
export function stars(r, size = "") {
  const n = Math.round((+r || 0) * 2) / 2;
  return `<span class="stars ${size}" role="img" aria-label="${n} out of 5 stars">${[1, 2, 3, 4, 5].map((i) => `<i class="${n >= i ? "on" : n >= i - 0.5 ? "half" : ""}">★</i>`).join("")}</span>`;
}
export function ratingLine(st) {
  if (!st || !st.reviews) return '<span class="hint">New on MowBrokers · no reviews yet</span>';
  return `${stars(st.rating)} <b class="num">${Number(st.rating).toFixed(1)}</b> <span class="muted small">(${st.reviews} review${st.reviews === 1 ? "" : "s"})</span>`;
}
export const respText = (h) => h == null ? "" : h <= 2 ? "Usually calls within 2 hours" : h <= 6 ? "Usually calls the same day" : h <= 26 ? "Usually calls within a day" : "";

// ---------- referral links: ?r=CODE is remembered for this visit ----------
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
try { const r = new URLSearchParams(location.search).get("r"); if (r && /^[A-Za-z0-9]{4,12}$/.test(r)) store.set("mb_ref", r.toUpperCase()); } catch { /* ignore */ }
export const referralCode = () => store.get("mb_ref") || "";
export const forgetReferral = () => store.set("mb_ref", "");

let toastT;
export function toast(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200);
}

// ---------- data ----------
export async function getSettings() {
  if (!sb) return DEFAULT_SETTINGS;
  const { data } = await sb.from("settings").select("*").eq("id", 1).maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  return { takeRate: Number(data.take_rate), roundTo: data.round_to, goalPairs: data.goal_pairs, season: data.season ?? DEFAULT_SETTINGS.season, fertApps: data.fert_apps ?? DEFAULT_SETTINGS.fertApps, lots: data.lots, terrains: data.terrains, coverages: data.coverages, suggested: data.suggested, extras: extrasOf({ extras: data.extras }) };
}

export async function session() { if (!sb) return null; const { data } = await sb.auth.getSession(); return data.session; }
export async function requireSession() {
  const s = await session();
  if (!s) { location.href = `login.html?next=${encodeURIComponent(location.pathname.split("/").pop() + location.search + location.hash)}`; throw new Error("redirecting"); }
  return s;
}
export async function myRole(uid) { const { data } = await sb.from("profiles").select("role").eq("id", uid).maybeSingle(); return data?.role ?? "provider"; }
export async function signOut() { if (sb) await sb.auth.signOut(); location.href = "index.html"; }

// ---------- rate card fields (provider profile, operator edits, settings) ----------
export function rateCardFields(lots, rc, prefix = "rc") {
  const fert = rc.fertTiers != null;
  return `<p class="hint">Price per weekly cut (mow, edge, trim, blow) for a flat, open yard, front and back. Prefilled with suggested starting rates; set your own.</p>
  <div class="rc-grid">${lots.map((t, k) => `<label for="${prefix}-t${k}">${esc(t.label)} ($)<input type="number" id="${prefix}-t${k}" name="${prefix}-t${k}" min="10" max="9999" step="5" value="${esc(rc.mowTiers?.[k])}" required></label>`).join("")}</div>
  <div class="rc-grid">
    <label for="${prefix}-bp">Every-two-weeks premium (%)<input type="number" id="${prefix}-bp" name="${prefix}-bp" min="0" max="100" step="1" value="${Math.round((rc.biweeklyPremium || 0) * 100)}"></label>
    <label for="${prefix}-om">One-time cut (× weekly cut)<input type="number" id="${prefix}-om" name="${prefix}-om" min="0.5" max="5" step="0.05" value="${esc(rc.oneTimeMult)}"></label>
    <label for="${prefix}-bd">Fertilizer bundle discount with mowing (%)<input type="number" id="${prefix}-bd" name="${prefix}-bd" min="0" max="50" step="1" value="${Math.round((rc.bundleDiscount || 0) * 100)}"></label>
  </div>
  <div class="addon"><label class="check"><input type="checkbox" name="${prefix}-fert" ${fert ? "checked" : ""}> Offer fertilizer and weed control (needs ADAI OTPS)</label>
    <p class="hint">Price per application by lot size.</p>
    <div class="rc-grid">${lots.map((t, k) => `<label for="${prefix}-f${k}">${esc(t.label)} ($)<input type="number" id="${prefix}-f${k}" name="${prefix}-f${k}" min="0" max="9999" step="5" value="${esc(rc.fertTiers?.[k] ?? DEFAULT_SETTINGS.suggested.fertTiers[k] ?? "")}"></label>`).join("")}</div></div>
  <div class="rc-grid">${ADDONS.map((a) => `<div class="addon"><label class="check"><input type="checkbox" name="${prefix}-o-${a.key}" ${rc.addons?.[a.key] != null ? "checked" : ""}> Offer ${esc(a.label.toLowerCase())}</label><label for="${prefix}-a-${a.key}">${a.scaled ? "Price for the smallest lot" : "Price"} ${a.unit} ($)<input type="number" id="${prefix}-a-${a.key}" name="${prefix}-a-${a.key}" min="0" max="9999" step="5" value="${esc(rc.addons?.[a.key] ?? "")}"></label>${a.scaled ? '<span class="hint">Larger lots scale by the standard lot factors.</span>' : ""}</div>`).join("")}</div>`;
}
export function readRateCard(form, n, prefix = "rc") {
  const f = new FormData(form), num = (k) => Number(f.get(`${prefix}-${k}`));
  const addons = {}; ADDONS.forEach((a) => { addons[a.key] = f.get(`${prefix}-o-${a.key}`) ? (num(`a-${a.key}`) || 0) : null; });
  const tiers = (c) => Array.from({ length: n }, (_, k) => num(`${c}${k}`));
  return { mowTiers: tiers("t"), biweeklyPremium: (num("bp") || 0) / 100, oneTimeMult: num("om") || 1.5, fertTiers: f.get(`${prefix}-fert`) ? tiers("f") : null, bundleDiscount: (num("bd") || 0) / 100, addons };
}

// ---------- chrome ----------
const MARK = `<svg viewBox="0 0 120 120" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M18 113 Q17 99 8 90"/><path d="M24 113 Q26 98 21 86"/><path d="M102 113 Q103 99 112 90"/><path d="M96 113 Q94 98 99 86"/></g><path d="M57 6 C25 32 22 80 57 113 Z" fill="currentColor"/><path d="M63 6 C95 32 98 80 63 113 Z" fill="#6CC04A"/></svg>`;
export function chrome(active) {
  const nav = [["/index.html", "Compare pros", "home"], ["/account.html", "My bookings", "account"], ["/join.html", "For lawn pros", "join"], ["/portal.html", "Pro sign in", "portal"]];
  const h = document.getElementById("site-header");
  if (h) h.outerHTML = `<a class="skip" href="#main">Skip to content</a><header class="top"><div class="wrap"><a class="brand" href="/" aria-label="MowBrokers home">${MARK}<b>Mow</b><span>Brokers</span></a>
    <nav class="main" aria-label="Main">${nav.map(([href, l, k]) => `<a href="${href}" ${k === active ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav></div></header>`;
  const f = document.getElementById("site-footer");
  if (f) f.outerHTML = `<footer class="site"><div class="wrap"><p>© ${new Date().getFullYear()} MowBrokers · Huntsville, Alabama · Every pro is insured and vetted. Fertilizer and weed control only by ADAI-licensed turf pros.</p><nav aria-label="More"><a href="/lawn-care/">Service areas</a><a href="/reservice.html">Free re-service</a><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><a href="/join.html">For lawn pros</a></nav></div></footer>`;
  if (!configured) {
    const m = document.getElementById("main");
    if (m) m.insertAdjacentHTML("afterbegin", `<div class="banner bad">Setup needed: this site isn't connected to its database yet. Fill in <b>assets/config.js</b> (see docs/LAUNCH.md).</div>`);
  }
}
