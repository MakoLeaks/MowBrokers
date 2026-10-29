import { $, sb, esc, usd, usdAuto, badges, quoteLines, getSettings, shortName, CATEGORY_LABEL, stars, ratingLine, respText, fmtDate } from "../core.mjs";
import { ADDONS, eligibility, headline, parseSpec, quote, specQuery } from "../pricing.mjs";

const WHY = { mowing: "This pro doesn't offer mowing.", fertilization: "This pro doesn't offer fertilizer and weed control." };

const root = $("#pro-root");
const qs = new URLSearchParams(location.search);
const slug = qs.get("slug") || "";
const spec = parseSpec((k) => qs.get(k));
const q = spec ? specQuery(spec) : "";
const [s, res] = await Promise.all([getSettings(), sb ? sb.from("public_vendors").select("*").eq("slug", slug).maybeSingle() : Promise.resolve({ data: null })]);
const v = res.data;
if (!v) {
  root.innerHTML = `<div class="empty"><p>This provider profile isn't available.</p><a class="btn ghost" href="index.html">Search for pros</a></div>`;
} else {
  document.title = `${v.business} — lawn care · MowBrokers`;
  document.querySelector('meta[name="description"]')?.setAttribute("content", (v.about || `${v.business} on MowBrokers`).slice(0, 160));
  const [{ data: st }, { data: rv }] = await Promise.all([sb.rpc("vendor_stats", { p_ids: [v.id] }), sb.rpc("vendor_reviews", { p_slug: v.slug, p_limit: 20 })]);
  const stats = st?.[0] ?? { customers: 0, claims: 0, reviews: 0 };
  const reviews = rv ?? [];
  const rc = v.rate_card, x = spec ? quote(s, rc, spec) : null, why = spec ? eligibility(v, spec) : "";
  const initials = v.business.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const aside = spec && x ? (why
    ? `<div class="panel"><h3>Not a match for your request</h3><p class="muted small">${why === "zip" ? `This pro doesn't serve ZIP ${esc(spec.zip)}.` : WHY[why] ?? `This pro doesn't offer everything you selected (${esc(why)}).`}</p><a class="btn ghost" href="results.html?${q}">See matched pros</a></div>`
    : `<div class="chosen"><p class="eyebrow">Your price with this pro</p><p><span class="bigprice">${usdAuto(headline(spec, x).amount)}</span> ${headline(spec, x).per}</p>${quoteLines(spec.plan, x)}<a class="btn" href="book.html?slug=${encodeURIComponent(v.slug)}&${q}">Choose ${esc(shortName(v.business))}</a></div>`)
    : `<div class="panel"><h3>See your price</h3><p class="muted small">Describe your yard to see this pro's price next to other vetted pros.</p><a class="btn" href="index.html">Start a search</a></div>`;
  root.innerHTML = `
    <div class="btns" style="margin-bottom:18px">${spec ? `<a class="btn ghost sm" href="results.html?${q}">← Back to your matched pros</a>` : `<a class="btn ghost sm" href="index.html">← Search for pros</a>`}</div>
    <div class="grid2"><div>
      <div class="prof-head"><div class="mono" aria-hidden="true">${esc(initials)}</div><div style="display:grid;gap:6px;min-width:0"><h1>${esc(v.business)}</h1>${badges(v.categories)}<p class="small">${ratingLine(stats)}${respText(stats.resp_hours) ? ` · <span class="muted">${respText(stats.resp_hours)}</span>` : ""}</p></div></div>
      ${v.about ? `<p style="max-width:65ch;font-size:16px">${esc(v.about)}</p>` : ""}
      <div class="facts">${[[v.years, "Years in business"], [v.techs, "Crew members"], [stats.customers, "Customers on MowBrokers"], [stats.claims, "Re-service requests"]].map(([n, l]) => `<div class="fact"><span class="v">${esc(n)}</span><span class="l">${l}</span></div>`).join("")}</div>
      <section class="stack" style="margin-bottom:28px"><h2>Posted prices</h2>
        <div class="tablewrap"><table><thead><tr><th>Lot size</th><th class="r">Weekly cut</th><th class="r">Every two weeks</th><th class="r">One-time cut</th><th class="r">Fert &amp; weed, per application</th></tr></thead><tbody>
          ${s.lots.map((t, k) => { const p = rc.mowTiers[k], r = s.roundTo || 5, rt = (x) => Math.round(x / r) * r, mows = (v.categories || []).includes("MOW"); return `<tr><td>${esc(t.label)}</td><td class="r num">${mows ? usd(p) : "—"}</td><td class="r num">${mows ? usd(rt(p * (1 + rc.biweeklyPremium))) : "—"}</td><td class="r num">${mows ? usd(rt(p * rc.oneTimeMult)) : "—"}</td><td class="r num">${rc.fertTiers && (v.categories || []).includes("OTPS") ? usd(rc.fertTiers[k]) : '<span class="muted">Not offered</span>'}</td></tr>`; }).join("")}
        </tbody></table></div>
        <p class="hint">For a flat, open yard, front and back. Slopes, obstacles and front-only or back-only mowing adjust by MowBrokers' standard factors, the same for every pro. Lots over two acres are guide prices, confirmed on site.</p>
        <div class="tablewrap"><table><thead><tr><th>Add-on</th><th class="r">Price</th></tr></thead><tbody>
          ${ADDONS.map((a) => `<tr><td>${a.label}</td><td class="r num">${rc.addons[a.key] != null ? `${a.scaled ? "from " : ""}${usd(rc.addons[a.key])} <span class="muted">${a.unit}</span>` : '<span class="muted">Not offered</span>'}</td></tr>`).join("")}
        </tbody></table></div>
        ${(v.custom_jobs || []).length ? `<p class="small"><b>Also handles (quoted after inspection):</b> ${esc(v.custom_jobs.join(", "))}</p>` : ""}
      </section>
      <section class="stack" style="margin-bottom:28px" id="reviews"><h2>Customer reviews</h2>
        ${reviews.length ? `<div class="reviews">${reviews.map((r) => `<div class="review">${stars(r.rating)} <span class="muted small">${esc(r.customer_label)} · ${esc(r.plan)} plan · ${fmtDate(r.created_at)}</span>${r.comment ? `<p>${esc(r.comment)}</p>` : ""}</div>`).join("")}</div>
          <p class="hint">Only MowBrokers customers who've had a visit with this pro can leave a review.</p>` : '<p class="muted small">No reviews yet. Only MowBrokers customers who\'ve had a visit with this pro can leave one.</p>'}
      </section>
      <section class="stack"><h2>Credentials</h2><dl class="kv">
        <dt>${(v.categories || []).some((c) => c !== "MOW") ? "ADAI Horticulture license" : "Business license"}</dt><dd>${esc(v.license)}</dd>${v.operator ? `<dt>Certified operator</dt><dd>${esc(v.operator)}</dd>` : ""}
        <dt>Services</dt><dd>${esc(v.categories.map((c) => CATEGORY_LABEL[c] || c).join(", "))}</dd>
        <dt>Insurance</dt><dd>${usd(v.insurance_coverage)} general liability, verified by MowBrokers</dd>
        <dt>Serves ZIPs</dt><dd class="num">${esc((v.zips || []).join(", ") || "All of North Alabama")}</dd></dl></section>
    </div><aside class="sticky">${aside}</aside></div>`;
}
