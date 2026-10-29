import { $, esc, getSettings } from "../core.mjs";
import { CUSTOM_JOBS, needsService, parseSpec } from "../pricing.mjs";

const form = $("#spec-form");
$("#custom").innerHTML = CUSTOM_JOBS.map((c, k) => `<label class="check"><input type="checkbox" name="custom" value="${esc(c)}" id="cj-${k}"> ${esc(c)}</label>`).join("");
const s = await getSettings();
$("#terrain").innerHTML = s.terrains.map((t) => `<option>${esc(t.label)}</option>`).join("");
$("#coverage").innerHTML = s.coverages.map((t) => `<option>${esc(t.label)}</option>`).join("");
const W = s.season?.weeks ?? 30;
$("#plan-weekly").textContent = ` Weekly · ${W} cuts`;
$("#plan-biweekly").textContent = ` Every two weeks · ${Math.round(W / 2)} cuts`;
$("#season-label").textContent = s.season?.label ?? "April–October";
$("#fert-apps").textContent = String(s.fertApps ?? 6);

// Coming back from "Edit yard details": prefill.
const prev = parseSpec((k) => new URLSearchParams(location.search).get(k));
if (prev) {
  form.acres.value = prev.acres; form.zip.value = prev.zip; form.terrain.value = prev.terrain; form.coverage.value = prev.coverage; form.shrubs.value = String(prev.shrubs);
  form.querySelector(`input[name=plan][value="${prev.plan}"]`).checked = true;
  form.fert.checked = prev.fert; form.aerate.checked = prev.aerate; form.leaves.checked = prev.leaves;
  form.querySelectorAll("input[name=custom]").forEach((c) => (c.checked = prev.custom.includes(c.value)));
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("#spec-err"); err.hidden = true;
  const f = new FormData(form);
  const acres = Number(f.get("acres")), zip = String(f.get("zip") || "").trim();
  if (!(acres >= 0.05 && acres <= 100)) { err.textContent = "Enter your lot size in acres (0.05 or more). A typical subdivision lot is 0.2 to 0.4 acres."; err.hidden = false; form.acres.focus(); return; }
  if (!/^\d{5}$/.test(zip)) { err.textContent = "Enter a 5-digit ZIP code."; err.hidden = false; form.zip.focus(); return; }
  const spec = { plan: String(f.get("plan")), fert: !!f.get("fert"), aerate: !!f.get("aerate"), leaves: !!f.get("leaves"), shrubs: Number(f.get("shrubs") || 0) };
  if (needsService(spec)) { err.textContent = "With “No mowing”, choose at least one service: fertilizer and weed control, aeration, leaf cleanup or shrub trimming."; err.hidden = false; return; }
  const p = new URLSearchParams({ acres: String(Math.round(acres * 100) / 100), zip, terrain: String(f.get("terrain")), coverage: String(f.get("coverage")), plan: spec.plan,
    fert: spec.fert ? "1" : "0", aerate: spec.aerate ? "1" : "0", leaves: spec.leaves ? "1" : "0", shrubs: String(spec.shrubs) });
  const custom = f.getAll("custom").map(String);
  if (custom.length) p.set("custom", custom.join(","));
  location.href = `results.html?${p}`;
});
