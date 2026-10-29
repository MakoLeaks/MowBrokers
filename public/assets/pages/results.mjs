import { $, sb, esc, usd, usdAuto, badges, quoteLines, getSettings, shortName, ratingLine, respText } from "../core.mjs";
import { bestMatchKey, headline, matchVendors, parseSpec, specQuery, specSummary } from "../pricing.mjs";

const root = $("#results-root");
const qs = new URLSearchParams(location.search);
const spec = parseSpec((k) => qs.get(k));
if (!spec) location.replace("index.html");
const q = specQuery(spec);
const SORTS = [["best", "Best match"], ["price", "Lowest price"], ["rating", "Top rated"], ["exp", "Most experience"]];
const sort = SORTS.some(([k]) => k === qs.get("sort")) ? qs.get("sort") : "best";

const [s, vend] = await Promise.all([getSettings(), sb ? sb.from("public_vendors").select("*") : Promise.resolve({ data: [] })]);
const vendors = vend.data ?? [];
const { matches, skipped, inZip } = matchVendors(s, vendors, spec);
const stats = {};
if (sb && matches.length) {
  const { data } = await sb.rpc("vendor_stats", { p_ids: matches.map((m) => m.v.id) });
  (data ?? []).forEach((r) => (stats[r.vendor_id] = r));
}
const st = (v) => stats[v.id] ?? {};
if (sort === "exp") matches.sort((a, b) => b.v.years - a.v.years);
if (sort === "rating") matches.sort((a, b) => ((st(b.v).reviews ? st(b.v).rating : 0) - (st(a.v).reviews ? st(a.v).rating : 0)) || a.x.annual - b.x.annual);
if (sort === "best") matches.sort((a, b) => bestMatchKey(a.x.annual, st(a.v).score) - bestMatchKey(b.x.annual, st(b.v).score));
const cheapest = matches.length ? Math.min(...matches.map((m) => m.x.annual)) : 0;
document.title = matches.length ? `${matches.length} pros for your yard · MowBrokers` : "No pros match yet · MowBrokers";

const notes = [];
if (matches.length) notes.push(`Prices are each pro's posted rates for a ${matches[0].x.tier} lot, ${spec.terrain.toLowerCase()}, ${spec.coverage.toLowerCase()}.`);
if (matches.length > 1 && sort === "best") notes.push("“Best match” weighs price with each pro's ratings, response time and re-service record.");
if (skipped) notes.push(`${skipped} other pro${skipped === 1 ? "" : "s"} in your area don't offer everything you selected.`);
if (spec.custom.length) notes.push(`${spec.custom.join(", ")} will be quoted after inspection.`);

root.innerHTML = `
  <div class="specbar"><div class="s">${specSummary(spec).map((b) => `<span>${esc(b)}</span>`).join("")}</div><a class="btn ghost sm" href="index.html?${q}">Edit yard details</a></div>
  <div class="sechead" style="margin-bottom:8px"><h1>${matches.length ? `${matches.length} vetted pro${matches.length === 1 ? "" : "s"} for your yard` : "No pros match yet"}</h1>
    ${matches.length > 1 ? `<nav class="filters" aria-label="Sort">${SORTS.map(([k, l]) => `<a href="results.html?${q}${k === "best" ? "" : "&sort=" + k}" aria-pressed="${sort === k}">${l}</a>`).join("")}</nav>` : ""}</div>
  <p class="muted" style="margin-bottom:16px">${esc(notes.join(" "))}</p>
  ${matches.length ? `<div class="results">${matches.map(({ v, x }) => {
    const h = headline(spec, x), best = matches.length > 1 && x.annual === cheapest;
    return `<article class="rcard ${best ? "best" : ""}">
      <div class="who"><h2 style="font-size:18px">${esc(v.business)}</h2>${badges(v.categories, best ? '<span class="badge best">Lowest price</span>' : "")}
        <p class="small">${ratingLine(st(v))}</p>
        <p class="muted small">${esc(v.years)} years in business · ${esc(v.techs)} crew member${v.techs == 1 ? "" : "s"} · ${st(v).customers ?? 0} customers on MowBrokers${respText(st(v).resp_hours) ? " · " + respText(st(v).resp_hours) : ""}</p>
        ${v.about ? `<p class="small" style="max-width:62ch">${esc(v.about.length > 180 ? v.about.slice(0, 177) + "…" : v.about)}</p>` : ""}</div>
      <div class="price"><span class="big">${usdAuto(h.amount)}</span><span class="muted small">${h.per}</span><span class="num small" style="font-weight:600;margin-top:4px">${usd(x.annual)} ${spec.plan === "One-time cut" ? "total" : "for the season"}</span>${x.guideOnly ? '<span class="hint">Guide price, confirmed on site</span>' : ""}</div>
      <div class="acts"><details><summary>Price breakdown</summary>${quoteLines(spec.plan, x)}</details>
        <div class="btns"><a class="btn ghost sm" href="pro.html?slug=${encodeURIComponent(v.slug)}&${q}">View profile</a><a class="btn sm" href="book.html?slug=${encodeURIComponent(v.slug)}&${q}">Choose ${esc(shortName(v.business))}</a></div></div>
    </article>`; }).join("")}</div>`
  : `<div class="empty"><p>${inZip ? "Pros serve your area, but none offer everything you selected. Try removing an add-on." : `We don't have a vetted pro in ZIP ${esc(spec.zip)} yet.`}</p><p>Send us your request and we'll find one for you, usually within a day.</p>
      <div class="btns"><a class="btn" href="book.html?request=1&${q}">Send my request</a><a class="btn ghost" href="index.html?${q}">Change details</a></div></div>`}`;
