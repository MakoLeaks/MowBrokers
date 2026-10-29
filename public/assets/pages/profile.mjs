import { $, sb, esc, call, getSettings, requireSession, rateCardFields, readRateCard, toast, CATEGORIES } from "../core.mjs";
import { CUSTOM_JOBS } from "../pricing.mjs";

const root = $("#profile-root");
const s = await requireSession();
const [settings, { data: v }] = await Promise.all([getSettings(), sb.from("vendors").select("*").eq("owner_id", s.user.id).maybeSingle()]);
const isNew = !v;
const i = v ?? { rate_card: settings.suggested, categories: ["MOW"], email: s.user.email, years: 0, techs: 1, insurance_coverage: 1000000, zips: [], custom_jobs: [] };
const val = (x) => esc(x ?? "");
root.innerHTML = `<div class="grid2"><div>
  <p class="eyebrow">${isNew ? "Provider application" : "Your company"}</p><h1 style="margin:4px 0 8px">${isNew ? "Apply to join MowBrokers" : "Profile and prices"}</h1>
  <p class="muted" style="margin-bottom:22px">${isNew ? "Tell us about your company and post your prices. We'll start vetting within two business days." : "Changes to prices and your description show to customers right away. License or insurance changes are re-verified."}</p>
  <form id="vf" novalidate>
    <fieldset><legend>Company</legend>
      <div class="row"><label for="business">Business name<input type="text" id="business" name="business" value="${val(i.business)}" required></label><label for="contact">Owner or contact<input type="text" id="contact" name="contact" value="${val(i.contact)}" required></label></div>
      <div class="row"><label for="phone">Business phone (gets new-job texts)<input type="tel" id="phone" name="phone" value="${val(i.phone)}" required></label><label for="email">Business email (gets new-job emails)<input type="email" id="email" name="email" value="${val(i.email)}" required></label></div>
      <div class="row"><label for="years">Years in business<input type="number" id="years" name="years" min="0" value="${val(i.years)}"></label><label for="techs">Crew members who visit homes<input type="number" id="techs" name="techs" min="1" value="${val(i.techs)}"></label></div>
      <label for="about">About your company (shown on your public profile)<textarea id="about" name="about" maxlength="1200" placeholder="Family-owned since 2014. Same crew every week. We mow at the height your grass needs and never leave clippings on the drive.">${val(i.about)}</textarea></label>
    </fieldset>
    <fieldset><legend>Services and Alabama licensing</legend>
      <p class="hint" style="margin-top:-8px">Mowing needs a city business license and insurance. Fertilizer, weed control or any pesticide or herbicide for hire needs the ADAI Horticulture Professional Services license in the OTPS category, with a certified operator.</p>
      ${CATEGORIES.map(([k, l]) => `<label class="check"><input type="checkbox" name="categories" value="${k}" ${i.categories.includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")}
      <div class="row"><label for="license">License number (ADAI Horticulture license if you offer treatments, otherwise city business license)<input type="text" id="license" name="license" value="${val(i.license)}" required></label><label for="operator">Certified operator name (OTPS, SLP or TS only)<input type="text" id="operator" name="operator" value="${val(i.operator)}"></label></div>
    </fieldset>
    <fieldset><legend>Insurance</legend><div class="row">
      <label for="carrier">General liability carrier<input type="text" id="carrier" name="carrier" value="${val(i.insurance_carrier)}" required></label>
      <label for="coverage">Coverage per occurrence ($)<input type="number" id="coverage" name="coverage" min="0" step="100000" value="${val(i.insurance_coverage)}"></label>
      <label for="insexp">Policy expires<input type="date" id="insexp" name="insexp" value="${val(i.insurance_expires)}" required></label></div></fieldset>
    <fieldset><legend>Service area</legend><label for="zips">ZIP codes you serve (comma separated)<input type="text" id="zips" name="zips" value="${val((i.zips || []).join(", "))}" placeholder="35801, 35802, 35806, 35756, 35758" required></label></fieldset>
    <fieldset><legend>Your prices</legend>${rateCardFields(settings.lots, i.rate_card)}</fieldset>
    <fieldset><legend>Quoted jobs you take</legend><p class="hint" style="margin-top:-8px">You quote these after seeing the yard. Customers asking for them only see pros who check them. Tree and stump removal needs TS; landscape bed installs need SLP.</p>
      <div class="row">${CUSTOM_JOBS.map((c) => `<label class="check"><input type="checkbox" name="custom_jobs" value="${esc(c)}" ${(i.custom_jobs || []).includes(c) ? "checked" : ""}> ${esc(c)}</label>`).join("")}</div></fieldset>
    <fieldset><legend>Program terms</legend><label class="check"><input type="checkbox" name="agree" ${isNew ? "" : "checked"}> <span>I'll honor the prices I post, adjusted only by MowBrokers' published terrain, coverage and lot factors. Customers pay through MowBrokers, which keeps <b>${Math.round(settings.takeRate * 1000) / 10}%</b>; Stripe pays me weekly. Re-service under the guarantee (a missed or poor cut, or weeds back between treatments) is free to the customer. I agree to the <a href="terms.html">Provider Terms</a>.</span></label></fieldset>
    <p class="err" id="vf-err" role="alert" hidden></p>
    <div class="btns"><button class="btn" type="submit" id="vf-btn">${isNew ? "Submit application" : "Save changes"}</button>${isNew ? "" : '<a class="btn ghost" href="portal.html">Back to portal</a>'}</div>
  </form></div>
  <aside class="sticky stack">
    ${v ? `<div class="panel"><h3>Insurance certificate</h3><label for="coi">${v.coi_path ? "Replace" : "Upload"} certificate of insurance (PDF, PNG or JPG)<input type="file" id="coi" accept=".pdf,.png,.jpg,.jpeg"></label><p id="coi-msg" class="small" role="status"></p></div>` : ""}
    ${v?.status === "approved" ? `<div class="panel"><h3>Your public profile</h3><a class="btn ghost sm" href="pro.html?slug=${encodeURIComponent(v.slug)}">View it as customers do</a></div>` : ""}
    <div class="panel small"><h3>How prices are compared</h3><p>Customers see your price for their lot size × the standard terrain factor (${settings.terrains.map((t) => `${esc(t.label.toLowerCase())} ${t.mult}`).join(", ")}) × the coverage factor (${settings.coverages.map((t) => `${esc(t.label.toLowerCase())} ${t.mult}`).join(", ")}). Every-two-weeks and one-time cuts use your premium and multiplier. Aeration and leaf cleanup scale by lot (${settings.lots.map((l) => l.scale + "×").join(", ")}). Every pro uses the same factors.</p></div>
  </aside></div>`;

$("#vf").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget, f = new FormData(form), err = $("#vf-err"), btn = $("#vf-btn");
  err.hidden = true; btn.disabled = true;
  const r = await call("portal", "saveProfile", { profile: {
    business: f.get("business"), contact: f.get("contact"), phone: f.get("phone"), email: f.get("email"), years: f.get("years"), techs: f.get("techs"), about: f.get("about"),
    license: f.get("license"), operator: f.get("operator"), categories: f.getAll("categories"), insurance_carrier: f.get("carrier"), insurance_coverage: f.get("coverage"), insurance_expires: f.get("insexp"),
    zips: String(f.get("zips") || "").split(/[\s,]+/).filter((z) => /^\d{5}$/.test(z)), custom_jobs: f.getAll("custom_jobs"), rate_card: readRateCard(form, settings.lots.length), agree: f.get("agree") === "on" } });
  btn.disabled = false;
  if (!r.ok) { err.textContent = r.error; err.hidden = false; err.scrollIntoView({ block: "center" }); return; }
  if (r.data.created) location.href = "portal.html?applied=1"; else toast("Saved. Customers see your changes on their next search.");
});

$("#coi")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0], msg = $("#coi-msg"); if (!file) return;
  if (file.size > 10 * 1024 * 1024) { msg.textContent = "Files must be under 10 MB."; return; }
  msg.textContent = "Uploading…";
  const u = await call("portal", "coiUploadUrl", { fileName: file.name });
  if (!u.ok) { msg.textContent = u.error; return; }
  const { error } = await sb.storage.from("coi").uploadToSignedUrl(u.data.path, u.data.token, file);
  if (error) { msg.textContent = "Upload failed. Try again."; return; }
  const sv = await call("portal", "saveCoiPath", { path: u.data.path });
  msg.textContent = sv.ok ? "Certificate uploaded. We'll verify it with your carrier." : sv.error;
});
