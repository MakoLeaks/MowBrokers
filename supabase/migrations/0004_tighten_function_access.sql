-- MowBrokers — hardening after the Supabase security advisor run (Oct 2026).
-- The trigger helper and the operator-only reports should not be callable by signed-out visitors.
-- (The reports already refuse non-admins; this removes the anonymous entry point entirely.)
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.monthly_metrics(int) from public, anon;
revoke execute on function public.vendor_scorecards() from public, anon;
grant execute on function public.monthly_metrics(int) to authenticated;
grant execute on function public.vendor_scorecards() to authenticated;
