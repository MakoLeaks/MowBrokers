import { $, call } from "../core.mjs";
$("#links-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget), err = $("#links-err"), btn = e.currentTarget.querySelector("button");
  err.hidden = true; btn.disabled = true;
  const r = await call("public", "sendBookingLinks", { email: f.get("email"), website: f.get("website") || "" });
  btn.disabled = false;
  if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
  e.currentTarget.hidden = true; $("#links-done").hidden = false;
});
