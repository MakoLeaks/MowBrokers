// Generates the local search pages (town × service), the hub page and sitemap.xml.
// Usage: node scripts/build-local-pages.mjs   (re-run after editing towns or copy; output is committed)
// Each page shows live price ranges from approved pros via public/assets/pages/local.mjs.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const SITE = "https://mowbrokers.com";
const TOWNS = [
  { slug: "huntsville-al", name: "Huntsville", county: "Madison County", zips: ["35801", "35802", "35803", "35805", "35806", "35810", "35811", "35816", "35824"], near: ["madison-al", "hampton-cove-al", "harvest-al", "meridianville-al"] },
  { slug: "madison-al", name: "Madison", county: "Madison and Limestone counties", zips: ["35756", "35757", "35758"], near: ["huntsville-al", "harvest-al", "athens-al", "toney-al"] },
  { slug: "harvest-al", name: "Harvest", county: "Madison County", zips: ["35749"], near: ["madison-al", "toney-al", "huntsville-al", "meridianville-al"] },
  { slug: "hampton-cove-al", name: "Hampton Cove", county: "Madison County (Owens Cross Roads)", zips: ["35763"], near: ["huntsville-al", "gurley-al", "brownsboro-al", "new-market-al"] },
  { slug: "meridianville-al", name: "Meridianville", county: "Madison County", zips: ["35759"], near: ["hazel-green-al", "new-market-al", "huntsville-al", "harvest-al"] },
  { slug: "hazel-green-al", name: "Hazel Green", county: "Madison County", zips: ["35750"], near: ["meridianville-al", "new-market-al", "toney-al", "huntsville-al"] },
  { slug: "new-market-al", name: "New Market", county: "Madison County", zips: ["35761"], near: ["meridianville-al", "hazel-green-al", "brownsboro-al", "huntsville-al"] },
  { slug: "toney-al", name: "Toney", county: "Madison and Limestone counties", zips: ["35773"], near: ["harvest-al", "hazel-green-al", "madison-al", "athens-al"] },
  { slug: "gurley-al", name: "Gurley", county: "Madison County", zips: ["35748"], near: ["hampton-cove-al", "brownsboro-al", "huntsville-al", "new-market-al"] },
  { slug: "brownsboro-al", name: "Brownsboro", county: "Madison County", zips: ["35741"], near: ["huntsville-al", "gurley-al", "new-market-al", "hampton-cove-al"] },
  { slug: "athens-al", name: "Athens", county: "Limestone County", zips: ["35611", "35613", "35614"], near: ["madison-al", "decatur-al", "toney-al", "huntsville-al"] },
  { slug: "decatur-al", name: "Decatur", county: "Morgan County", zips: ["35601", "35603"], near: ["hartselle-al", "athens-al", "madison-al", "huntsville-al"] },
  { slug: "hartselle-al", name: "Hartselle", county: "Morgan County", zips: ["35640"], near: ["decatur-al", "athens-al", "madison-al", "huntsville-al"] }
];
const SERVICES = [
  { slug: "", key: "mowing", title: "Lawn care", noun: "lawn mowing", spec: {}, price: "per weekly cut",
    intro: (t) => `Compare insured, vetted lawn care companies serving ${t.name}, with each company's posted price for a yard like yours. No phone tag and no waiting for a quote: describe your yard, see the prices, and book the pro you like.`,
    body: [
      ["What a mowing plan covers", "Each cut on MowBrokers includes mowing, edging along drives and walks, string-trimming around beds and fences, and blowing clippings off hard surfaces. Choose weekly or every-two-weeks service through the mowing season, or a single one-time cut."],
      ["Why prices differ by yard", "Lawn companies price by how much grass there is and how long it takes to cut. On MowBrokers each pro posts a price for each lot size, and the same adjustments for slopes, obstacles and front-only or back-only mowing apply to every pro, so the comparison is fair."],
      ["If a cut is missed", "On a MowBrokers plan, if a scheduled cut is missed or done poorly, your pro comes back within two business days at no charge. Request it from your account page."]
    ] },
  { slug: "mowing", key: "mowing", title: "Lawn mowing", noun: "lawn mowing", spec: {}, price: "per weekly cut",
    intro: (t) => `Book weekly or every-two-weeks mowing from vetted lawn pros serving ${t.name}, at each pro's posted price, billed after each cut.`,
    body: [
      ["Weekly or every two weeks", "Weekly service keeps a lawn at an even height through the growing season. Every-two-weeks service costs less over the season, but each cut usually costs a little more because the grass is longer; pros post that premium up front."],
      ["One-time cuts", "Need a single cut before a party, a sale or while you're away? Choose a one-time cut. Pros price it as a multiple of their weekly cut, shown before you book."],
      ["Overgrown yards", "If the grass hasn't been cut in a long while, choose “Overgrown yard cleanup” when you search. Your pro looks at the yard and quotes the job first."]
    ] },
  { slug: "fertilization", key: "fert", title: "Lawn fertilization", noun: "lawn fertilization", spec: { fert: "1" }, price: "per application",
    intro: (t) => `Compare fertilizer and weed control programs from licensed lawn pros serving ${t.name}. Each application is billed after it's done.`,
    body: [
      ["Licensed pros only", "In Alabama, applying fertilizer and weed control for hire requires a Horticulture Professional Services license from the Alabama Department of Agriculture & Industries in the Ornamental & Turf Pest Control category, with a certified operator. Only pros with that license appear for this service on MowBrokers."],
      ["How the program works", "The MowBrokers program is a set number of applications spread across the year, priced per application by lot size. Your pro decides what goes down at each visit for your grass and season, and notes it in the service report."],
      ["Bundle with mowing", "Add the program to a weekly or every-two-weeks mowing plan and most pros take a bundle discount off the fertilizer program. One pro, one bill after each visit."]
    ] },
  { slug: "weed-control", key: "fert", title: "Weed control", noun: "weed control", spec: { fert: "1" }, price: "per application",
    intro: (t) => `Get lawn weed control from licensed, vetted lawn pros serving ${t.name}, as part of a fertilizer and weed control program billed after each application.`,
    body: [
      ["Part of the program", "On MowBrokers, weed control is part of the fertilizer and weed control program, so the same licensed pro handles feeding the lawn and keeping weeds down, and you see one price per application."],
      ["Licensed pros only", "Herbicides applied for hire in Alabama require the ADAI Ornamental & Turf Pest Control (OTPS) category. Every pro offering this service on MowBrokers holds it, with a certified operator."],
      ["If weeds come back", "If weeds come back between treatment visits, your pro comes back within two business days at no charge under the MowBrokers re-service guarantee."]
    ] },
  { slug: "aeration", key: "aeration", title: "Lawn aeration", noun: "core aeration", spec: { aerate: "1" }, price: "for a 0.3-acre yard",
    intro: (t) => `Book core aeration from vetted lawn pros serving ${t.name}, at each pro's posted price for your lot size, billed after it's done.`,
    body: [
      ["What core aeration is", "Core aeration pulls small plugs of soil out of the lawn so air, water and nutrients reach the roots more easily. It is usually done once a year."],
      ["Priced by lot size", "Each pro posts one aeration price; larger lots scale by MowBrokers' standard lot factors, the same for every pro."],
      ["Add it to a plan", "Aeration is an add-on, so you can book it on its own or alongside mowing or a fertilizer program with the same pro."]
    ] }
];
const FAQ = (t, s) => [
  [`How much does ${s.noun} cost in ${t.name}?`, `It depends on the size of your lot, the terrain and the company. The box on this page shows the current range of posted prices from vetted pros serving ${t.name}; describe your yard to see each pro's exact price.`],
  ["Are the companies licensed and insured?", "Every pro on MowBrokers has a verified city business license and general liability insurance we verify with the carrier, and passes our vetting: background checks on the owner and crew, three customer references and a ride-along on a mowing route. Pros who apply fertilizer or weed control also hold the ADAI Horticulture Professional Services license in the Ornamental & Turf Pest Control category."],
  ["When do I pay?", "You save a card when you book and you're charged only after each visit. Season prepay at the first visit is optional and saves a little more."],
  ["What if a cut is missed or weeds come back?", "If a scheduled cut is missed or done poorly, or weeds come back between treatment visits, your pro comes back within two business days at no charge. Request it from your account page."]
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const townBy = Object.fromEntries(TOWNS.map((t) => [t.slug, t]));
const url = (t, s) => `/lawn-care/${t ? t.slug + "/" : ""}${s && s.slug ? s.slug + "/" : ""}`;
const searchLink = (t, s) => {
  const p = new URLSearchParams({ acres: "0.3", zip: t.zips[0], terrain: "Flat and open", coverage: "Front and back", plan: s.key === "mowing" ? "Weekly" : "No mowing", fert: "0", aerate: "0", leaves: "0", shrubs: "0", ...s.spec });
  return `/index.html?${p}`;
};

function page({ title, description, path, crumbs, main, jsonld }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${SITE}${path}"><meta property="og:image" content="${SITE}/assets/og.png"><meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#13283D">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="/assets/styles.css">
<script src="/assets/config.js"></script>
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n")}
</head>
<body>
<div id="site-header"></div>
<main id="main" class="wrap">
<nav aria-label="Breadcrumb" class="small muted" style="margin-bottom:12px">${crumbs.map(([n, h], i) => i === crumbs.length - 1 ? `<span>${esc(n)}</span>` : `<a href="${h}">${esc(n)}</a> › `).join("")}</nav>
${main}
</main>
<div id="site-footer"></div>
<script type="module">import { chrome } from "/assets/core.mjs"; chrome("");</script>
<script type="module" src="/assets/pages/local.mjs"></script>
</body>
</html>
`;
}
const crumbsLd = (crumbs) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs.map(([n, h], i) => ({ "@type": "ListItem", position: i + 1, name: n, item: SITE + h })) });
const faqLd = (qs) => ({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: qs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });

const out = [];
const write = (path, html) => { const dir = `public${path}`; mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}index.html`, html); out.push(path); };

for (const t of TOWNS) for (const s of SERVICES) {
  const path = url(t, s);
  const h1 = `${s.title} in ${t.name}, AL`;
  const crumbs = [["Service areas", "/lawn-care/"], [`${t.name}, AL`, url(t)], ...(s.slug ? [[s.title, path]] : [])];
  const faq = FAQ(t, s);
  const main = `<div class="grid2"><div class="stack-lg">
  <div><p class="eyebrow">${esc(t.county)}</p><h1 style="margin-top:6px">${esc(h1)}</h1><p class="muted" style="margin-top:8px;max-width:62ch">${esc(s.intro(t))}</p></div>
  <section class="card" id="local-prices" data-zips="${t.zips.join(",")}" data-service="${s.key}" data-town="${esc(t.name)}" data-search="${esc(searchLink(t, s))}" data-price-label="${esc(s.price)}">
    <h2>What ${esc(s.noun)} costs in ${esc(t.name)}</h2><p class="muted small">Loading live prices from vetted pros…</p>
    <div class="btns"><a class="btn" href="${esc(searchLink(t, s))}">See prices for my yard</a></div></section>
  ${s.body.map(([h, p]) => `<section class="stack"><h2>${esc(h)}</h2><p style="max-width:68ch">${esc(p)}</p></section>`).join("")}
  <section class="stack"><h2>How MowBrokers works</h2><ol style="margin:0;padding-left:20px;display:grid;gap:6px;max-width:68ch"><li>Describe your yard: lot size, ZIP code, mowing plan and add-ons.</li><li>See every vetted pro serving ${esc(t.name)} with their posted price for your yard, plus ratings from real customers.</li><li>Pick one and save a card. Your pro calls within one business day, and you're charged only after each visit.</li></ol></section>
  <section class="stack"><h2>Questions</h2>${faq.map(([q, a]) => `<details class="card"><summary>${esc(q)}</summary><p class="small" style="margin-top:8px">${esc(a)}</p></details>`).join("")}</section>
</div>
<aside class="stack sticky">
  <div class="panel"><h3>${esc(t.name)} services</h3><ul style="margin:0;padding-left:18px;display:grid;gap:4px" class="small">${SERVICES.map((x) => `<li>${x.slug === s.slug ? `<b>${esc(x.title)}</b>` : `<a href="${url(t, x)}">${esc(x.title)}</a>`}</li>`).join("")}</ul></div>
  <div class="panel"><h3>${esc(s.title)} nearby</h3><ul style="margin:0;padding-left:18px;display:grid;gap:4px" class="small">${t.near.map((n) => `<li><a href="${url(townBy[n], s)}">${esc(townBy[n].name)}, AL</a></li>`).join("")}</ul></div>
  <p class="small muted">ZIP codes: ${t.zips.join(", ")}</p>
</aside></div>`;
  write(path, page({ title: `${h1} · Compare vetted pros · MowBrokers`, description: `${s.title} in ${t.name}, AL: compare posted prices and ratings from insured, vetted lawn care companies. Charged only after each visit.`, path, crumbs, main, jsonld: [crumbsLd(crumbs), faqLd(faq)] }));
}

// Hub page
{
  const path = "/lawn-care/", crumbs = [["Service areas", path]];
  const main = `<div class="stack-lg"><div><p class="eyebrow">North Alabama</p><h1 style="margin-top:6px">Lawn care service areas</h1><p class="muted" style="margin-top:8px;max-width:62ch">MowBrokers lists insured, vetted lawn care companies across Huntsville and the surrounding area. Pick your town to see live prices, or <a href="/index.html">describe your yard</a> to compare every pro serving your ZIP code.</p></div>
  <div class="results">${TOWNS.map((t) => `<article class="rcard" style="grid-template-columns:minmax(0,1fr)"><div class="who"><h2 style="font-size:18px"><a href="${url(t)}">${esc(t.name)}, AL</a></h2><p class="muted small">${esc(t.county)} · ZIP ${t.zips.join(", ")}</p><p class="small">${SERVICES.map((s) => `<a href="${url(t, s)}">${esc(s.title)}</a>`).join(" · ")}</p></div></article>`).join("")}</div></div>`;
  write(path, page({ title: "Lawn care service areas in North Alabama · MowBrokers", description: "Compare vetted lawn care pros in Huntsville, Madison, Harvest, Hampton Cove, Athens, Decatur and nearby towns. Posted prices, real reviews, charged only after each visit.", path, crumbs, main, jsonld: [crumbsLd(crumbs)] }));
}

// Sitemap: main pages + generated pages.
const staticPages = ["/", "/join.html", "/reservice.html", "/account.html", "/terms.html", "/privacy.html"];
const lastmod = new Date().toISOString().slice(0, 10);
writeFileSync("public/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...staticPages, ...out].map((p) => `  <url><loc>${SITE}${p}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")}\n</urlset>\n`);
let robots = readFileSync("public/robots.txt", "utf8").replace(/\nSitemap:.*$/m, "");
writeFileSync("public/robots.txt", robots.trimEnd() + `\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`wrote ${out.length} pages + sitemap.xml`);
