import { $, $$, sb } from "../core.mjs";
const root = $("#auth-root"), mode = root.dataset.mode, form = $("#auth-form"), err = $("#auth-err"), msg = $("#auth-msg");
const base = location.href.replace(/[^/]*$/, "");
const nextParam = new URLSearchParams(location.search).get("next") || "portal.html";
const next = /^[a-z0-9-]+\.html/i.test(nextParam) ? nextParam : "portal.html";
$$("[data-signup]").forEach((el) => (el.hidden = mode !== "signup"));
$$("[data-login]").forEach((el) => (el.hidden = mode !== "login"));
const submit = $("#auth-submit"); if (submit) submit.textContent = mode === "signup" ? "Create account" : "Sign in";
const show = (el, t) => { err.hidden = msg.hidden = true; el.textContent = t; el.hidden = false; };

if (sb && mode !== "reset") { const { data } = await sb.auth.getSession(); if (data.session) location.replace(next); }

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sb) return show(err, "The site isn't connected yet.");
  const f = new FormData(form), email = String(f.get("email") || ""), password = String(f.get("password") || "");
  if (password.length < 8) return show(err, "Use a password of at least 8 characters.");
  if (mode === "signup") {
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: String(f.get("name") || "") }, emailRedirectTo: base + "profile.html" } });
    if (error) return show(err, error.message);
    if (!data.session) return show(msg, "Check your email to confirm your account, then come back and sign in.");
    location.href = "profile.html"; return;
  }
  if (mode === "reset") {
    const { error } = await sb.auth.updateUser({ password });
    if (error) return show(err, error.message);
    show(msg, "Password updated. Taking you to your portal…"); setTimeout(() => (location.href = "portal.html"), 1200); return;
  }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return show(err, "That email and password don't match an account.");
  location.href = next;
});
$("#forgot")?.addEventListener("click", async () => {
  const email = $("#a-email").value;
  if (!email) return show(err, "Enter your email first, then choose Forgot password.");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: base + "reset.html" });
  error ? show(err, error.message) : show(msg, "We sent a password reset link to your email.");
});
