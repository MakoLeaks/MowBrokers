// "Visit done" form shared by the provider portal and the operator console.
// Lists what can be billed on this visit (with remaining counts), takes a service note and an optional photo,
// then logs the visit. The server charges the card or pays out from the customer's annual prepay.
import { sb, esc, usdAuto, call, toast, today } from "./core.mjs";

export async function mountVisitForm(el, { fn, bookingId, prepaid = false, onDone }) {
  el.innerHTML = '<p class="muted small">Loading…</p>';
  const r = await call(fn, "visitOptions", { bookingId });
  if (!r.ok) { el.innerHTML = `<p class="err small">${esc(r.error)}</p>`; return; }
  const opts = r.data.options || [];
  const id = `vf-${bookingId.slice(0, 8)}`;
  el.innerHTML = `<form class="visitform" id="${id}" novalidate>
    <div class="row"><label for="${id}-date">Visit date<input type="date" id="${id}-date" value="${today()}" max="${today()}" required></label></div>
    <fieldset><legend class="small">What did you do?</legend>
      ${opts.map((o) => {
        const dis = o.remaining <= 0 || o.blocked;
        const checked = o.kind === "visit" && !dis;
        return `<label class="check ${dis ? "muted" : ""}"><input type="checkbox" name="items" value="${o.kind}" ${checked ? "checked" : ""} ${dis ? "disabled" : ""}> ${esc(o.label)} · <span class="num">${usdAuto(o.amount)}</span> <span class="hint">${o.remaining} left this season</span></label>`;
      }).join("")}
    </fieldset>
    <label for="${id}-notes">Service note for the customer<textarea id="${id}-notes" required minlength="10" maxlength="2000" placeholder="Mowed front and back at 3 inches, edged the drive and walk, trimmed along the back fence, blew off the patio. Low spot by the downspout stays wet; we mowed around it."></textarea></label>
    <label for="${id}-photo">Photo (optional)<input type="file" id="${id}-photo" accept="image/jpeg,image/png,image/webp,image/heic"></label>
    <p class="hint">${prepaid ? "This customer prepaid the season: logging the visit pays you your share automatically." : "Logging the visit charges the customer's saved card. They get your note as a service report."}</p>
    <p class="err small" role="alert" hidden></p>
    <div class="btns"><button class="btn sm" type="submit">Log visit${prepaid ? "" : " and charge"}</button><button class="btn ghost sm" type="button" data-cancel>Cancel</button></div>
  </form>`;
  const form = el.querySelector("form"), err = form.querySelector(".err"), btn = form.querySelector("button[type=submit]");
  form.querySelector("[data-cancel]").onclick = () => { el.innerHTML = ""; el.hidden = true; };
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.hidden = true;
    const items = [...form.querySelectorAll("input[name=items]:checked")].map((c) => c.value);
    const notes = form.querySelector("textarea").value.trim();
    if (!items.length) { err.textContent = "Choose what you did."; err.hidden = false; return; }
    if (notes.length < 10) { err.textContent = "Add a short service note (what you did)."; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = "Saving…";
    let photoPath = null;
    const file = form.querySelector("input[type=file]").files[0];
    if (file) {
      if (file.size > 12 * 1024 * 1024) { err.textContent = "Photo is too large (12 MB max)."; err.hidden = false; btn.disabled = false; btn.textContent = "Log visit"; return; }
      const u = await call(fn, "visitPhotoUploadUrl", { bookingId, fileName: file.name });
      if (!u.ok) { err.textContent = u.error; err.hidden = false; btn.disabled = false; btn.textContent = "Log visit"; return; }
      const up = await sb.storage.from("visit-photos").uploadToSignedUrl(u.data.path, u.data.token, file, { contentType: file.type || "image/jpeg" });
      if (up.error) { err.textContent = "Photo upload failed. Try again or skip the photo."; err.hidden = false; btn.disabled = false; btn.textContent = "Log visit"; return; }
      photoPath = u.data.path;
    }
    const res = await call(fn, "completeVisit", { bookingId, date: form.querySelector("input[type=date]").value, items, notes, photoPath });
    if (!res.ok) { err.textContent = res.error; err.hidden = false; btn.disabled = false; btn.textContent = "Log visit"; return; }
    const d = res.data;
    toast(d.status === "failed" ? d.message : d.charged ? `Visit logged. Charged ${usdAuto(d.charged)}${d.covered ? " (rest prepaid)" : ""}.` : d.covered ? "Visit logged. Paid from the customer's prepay." : "Visit logged.");
    onDone?.(d);
  });
}
