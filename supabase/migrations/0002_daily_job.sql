-- Schedules the daily Edge Function (reminders, insurance warnings, operator digest) at 8am Central (13:00 UTC).
-- Run after deploying the "daily" function. Safe to run more than once.
-- The job's shared secret is generated here and kept in a private table that only the database and
-- the Edge Functions (service role) can read, so nobody has to copy it anywhere.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.app_secrets (name text primary key, value text not null);
revoke all on private.app_secrets from public, anon, authenticated;
insert into private.app_secrets (name, value) values ('cron', encode(gen_random_bytes(24), 'hex'))
  on conflict (name) do nothing;

-- Lets the daily function compare the header it receives with the stored secret, without exposing it.
create or replace function public.check_cron_secret(p_secret text) returns boolean
language sql stable security definer set search_path = private as $$
  select exists (select 1 from private.app_secrets where name = 'cron' and value = p_secret);
$$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

select cron.unschedule('mowbrokers-daily') where exists (select 1 from cron.job where jobname = 'mowbrokers-daily');
select cron.schedule('mowbrokers-daily', '0 13 * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/daily',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from private.app_secrets where name = 'cron')),
    body := '{}'::jsonb
  );
$$);
