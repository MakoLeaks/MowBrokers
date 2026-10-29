import { $, call } from "../core.mjs";
$("#claim-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget), err = $("#claim-err");
  err.hidden = true;
  const r = await call("public", "claimByPhone", { ref: f.get("ref"), phone: f.get("phone"), description: f.get("description"), website: f.get("website") || "" });
  if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
  e.currentTarget.hidden = true; $("#claim-done").hidden = false;
});
