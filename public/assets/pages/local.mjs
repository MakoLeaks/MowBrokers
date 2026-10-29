// Live price ranges on the local search pages (town × service).
// data-service is one of: mowing, fert, aeration.
import { $, sb, esc, usd, getSettings } from "../core.mjs";
import { eligibility, quote } from "../pricing.mjs";

const box = $("#local-prices");
if (box && sb) {
  const zips = box.dataset.zips.split(","), key = box.dataset.service, town = box.dataset.town;
  const [s, { data }] = await Promise.all([getSettings(), sb.from("public_vendors").select("*")]);
  const base = { acres: 0.3, terrain: "Flat and open", coverage: "Front and back", plan: key === "mowing" ? "Weekly" : "No mowing", fert: key === "fert", aerate: key === "aeration", leaves: false, shrubs: 0, custom: [] };
  const rows = [];
  for (const v of data ?? []) {
    const zip = (v.zips || []).length ? zips.find((z) => v.zips.includes(z)) : zips[0];
    if (!zip) continue;
    const spec = { ...base, zip };
    if (eligibility(v, spec)) continue;
    const x = quote(s, v.rate_card, spec);
    rows.push({ amount: { mowing: x.perVisit, fert: x.fertPerApp, aeration: x.aeration }[key], annual: x.annual });
  }
  const range = (a) => { const lo = Math.min(...a), hi = Math.max(...a); return lo === hi ? usd(lo) : `${usd(lo)}–${usd(hi)}`; };
  const msg = rows.length
    ? `<p><span class="bigprice">${range(rows.map((r) => r.amount))}</span> ${esc(box.dataset.priceLabel)}</p>
       <p class="small muted">${rows.length} vetted pro${rows.length === 1 ? "" : "s"} serving ${esc(town)} today, for a flat, open 0.3-acre yard, front and back.${key === "mowing" ? ` Weekly mowing for the season: ${range(rows.map((r) => r.annual))}.` : ""} Your price depends on your yard.</p>`
    : `<p class="small">We're still adding vetted pros in ${esc(town)} for this service. Send your request and we'll find one for you, usually within a day.</p>`;
  box.innerHTML = `<h2>${box.querySelector("h2").innerHTML}</h2>${msg}<div class="btns"><a class="btn" href="${esc(box.dataset.search)}">See prices for my home</a></div>`;
}
