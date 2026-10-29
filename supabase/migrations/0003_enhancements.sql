-- MowBrokers — platform enhancements (visit reports, response deadlines, reviews, self-service,
-- referrals, annual prepay, refunds, scorecards). Safe to run once after 0001 and 0002.

-- ---------- platform settings: new knobs ----------
alter table public.settings add column if not exists extras jsonb not null
  default '{"referralCreditCents":2500,"prepayDiscount":0.05,"respondHours":24,"reviewAfterVisits":2}';

-- ---------- bookings: new fields ----------
alter table public.bookings
  add column if not exists visit_window text not null default 'any' check (visit_window in ('morning','afternoon','any')),
  add column if not exists preferred_alt date,
  add column if not exists respond_by timestamptz,
  add column if not exists contacted_at timestamptz,
  add column if not exists next_visit_due date,
  add column if not exists service_year_start date,
  add column if not exists paused_until date,
  add column if not exists cancel_reason text,
  add column if not exists cancelled_by text,
  add column if not exists prepay boolean not null default false,
  add column if not exists prepaid_through date,
  add column if not exists prepay_payment_id uuid,
  add column if not exists prepay_covers jsonb,
  add column if not exists credit_cents int not null default 0 check (credit_cents >= 0),
  add column if not exists referral_code text,
  add column if not exists referred_by text,
  add column if not exists review_requested_at timestamptz,
  add column if not exists marketing_opt_out boolean not null default false;
create unique index if not exists bookings_referral_code_idx on public.bookings(referral_code) where referral_code is not null;
create index if not exists bookings_email_idx on public.bookings(lower(customer_email));
create index if not exists bookings_respond_idx on public.bookings(respond_by) where status = 'matched';

update public.bookings set service_year_start = first_visit where service_year_start is null and first_visit is not null;
update public.bookings set referral_code =
  upper(left(regexp_replace(coalesce(customer_name,''), '[^A-Za-z]', '', 'g') || 'LAWNS', 5)) || upper(substr(md5(id::text || random()::text), 1, 4))
  where referral_code is null;

-- ---------- payments: itemized service charges, prepay, payouts, refunds ----------
alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments add constraint payments_kind_check
  check (kind in ('visit','fert','service','prepay','prepaid_visit'));
alter table public.payments
  add column if not exists items jsonb not null default '[]',
  add column if not exists discount_cents int not null default 0,
  add column if not exists refunded_cents int not null default 0,
  add column if not exists stripe_charge_id text,
  add column if not exists stripe_transfer_id text,
  add column if not exists visit_id uuid,
  add column if not exists attempts int not null default 0;

-- ---------- visits (service reports) ----------
create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  vendor_id uuid references public.vendors(id) on delete set null,
  visit_date date not null,
  items text[] not null,
  notes text not null default '',
  photo_path text,
  payment_id uuid references public.payments(id) on delete set null,
  logged_by text not null default 'provider' check (logged_by in ('provider','operator')),
  created_at timestamptz not null default now()
);
create index if not exists visits_booking_idx on public.visits(booking_id);
create index if not exists visits_vendor_idx on public.visits(vendor_id);

-- Backfill visits from charges made before visit reports existed.
insert into public.visits (booking_id, vendor_id, visit_date, items, notes, payment_id, logged_by)
select p.booking_id, p.vendor_id, (p.created_at at time zone 'America/Chicago')::date, array[p.kind], 'Logged before service reports were available.', p.id, 'operator'
from public.payments p
where p.status = 'succeeded' and p.kind in ('visit','fert')
  and not exists (select 1 from public.visits v where v.payment_id = p.id);
update public.payments p set visit_id = v.id from public.visits v where v.payment_id = p.id and p.visit_id is null;

-- ---------- reviews ----------
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid unique not null references public.bookings(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text not null default '',
  customer_label text not null default '',
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reviews_vendor_idx on public.reviews(vendor_id);

-- ---------- referrals ----------
create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  referrer_booking_id uuid not null references public.bookings(id) on delete cascade,
  referee_booking_id uuid unique not null references public.bookings(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','earned','void')),
  created_at timestamptz not null default now(),
  earned_at timestamptz
);

-- ---------- booking timeline (also feeds provider scorecards) ----------
create table if not exists public.booking_events (
  id bigint generated always as identity primary key,
  booking_id uuid references public.bookings(id) on delete cascade,
  vendor_id uuid references public.vendors(id) on delete set null,
  type text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists booking_events_booking_idx on public.booking_events(booking_id);
create index if not exists booking_events_vendor_type_idx on public.booking_events(vendor_id, type);

-- ---------- Row Level Security for the new tables ----------
alter table public.visits enable row level security;
alter table public.reviews enable row level security;
alter table public.referrals enable row level security;
alter table public.booking_events enable row level security;
drop policy if exists "vendor sees own visits" on public.visits;
create policy "vendor sees own visits" on public.visits for select using (
  public.is_admin() or vendor_id in (select id from public.vendors where owner_id = auth.uid()));
drop policy if exists "vendor sees own reviews" on public.reviews;
create policy "vendor sees own reviews" on public.reviews for select using (
  public.is_admin() or vendor_id in (select id from public.vendors where owner_id = auth.uid()));
drop policy if exists "admin reads referrals" on public.referrals;
create policy "admin reads referrals" on public.referrals for select using (public.is_admin());
drop policy if exists "vendor sees own events" on public.booking_events;
create policy "vendor sees own events" on public.booking_events for select using (
  public.is_admin() or vendor_id in (select id from public.vendors where owner_id = auth.uid()));

-- Private bucket for visit photos (read through short-lived signed links only).
insert into storage.buckets (id, name, public) values ('visit-photos', 'visit-photos', false) on conflict (id) do nothing;

-- =====================================================================
-- Provider scores: rating, response time, reliability, re-service rate.
-- =====================================================================
create or replace function public.vendor_scores()
returns table (vendor_id uuid, rating numeric, reviews int, resp_hours numeric, sla_misses int, matches int,
               reservice_rate numeric, cancels int, active int, score int)
language sql stable security definer set search_path = public as $$
  with base as (
    select v.id,
      (select avg(r.rating)::numeric from reviews r where r.vendor_id = v.id and not r.hidden) as rating,
      (select count(*)::int from reviews r where r.vendor_id = v.id and not r.hidden) as reviews,
      (select sum(r.rating)::numeric from reviews r where r.vendor_id = v.id and not r.hidden) as rating_sum,
      (select avg(extract(epoch from (coalesce(b.contacted_at, b.scheduled_at) - b.matched_at)) / 3600)::numeric
         from bookings b where b.vendor_id = v.id and b.matched_at is not null and coalesce(b.contacted_at, b.scheduled_at) is not null
           and b.matched_at > now() - interval '365 days') as resp_hours,
      (select count(*)::int from booking_events e where e.vendor_id = v.id and e.type = 'sla_miss') as sla_misses,
      (select count(*)::int from booking_events e where e.vendor_id = v.id and e.type = 'matched') as matches,
      (select count(*)::int from claims c where c.vendor_id = v.id) as claims,
      (select count(*)::int from visits x where x.vendor_id = v.id) as visits,
      (select count(*)::int from bookings b where b.vendor_id = v.id and b.status = 'cancelled' and b.cancelled_by = 'customer') as cancels,
      (select count(*)::int from bookings b where b.vendor_id = v.id and b.status in ('scheduled','active')) as active
    from vendors v
  )
  select id, round(rating, 2), reviews, round(resp_hours, 1), sla_misses, matches,
    case when visits > 0 then round(claims::numeric / visits, 3) end,
    cancels, active,
    round(100 * (
        0.40 * ((coalesce(rating_sum, 0) + 4.0 * 3) / (reviews + 3) / 5)
      + 0.25 * (case when resp_hours is null then 0.8 else greatest(0, least(1, 1 - (resp_hours - 4) / 44)) end)
      + 0.15 * (case when matches + sla_misses = 0 then 0.9 else 1 - least(1, 2.0 * sla_misses / (matches + sla_misses)) end)
      + 0.20 * (case when visits = 0 then 0.9 else 1 - least(1, 5.0 * claims / visits) end)
    ))::int
  from base;
$$;
revoke execute on function public.vendor_scores() from public, anon, authenticated;
grant execute on function public.vendor_scores() to service_role;

-- Operator-only full scorecards.
create or replace function public.vendor_scorecards()
returns table (vendor_id uuid, rating numeric, reviews int, resp_hours numeric, sla_misses int, matches int,
               reservice_rate numeric, cancels int, active int, score int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query select * from public.vendor_scores();
end $$;
grant execute on function public.vendor_scorecards() to authenticated;

-- Public stats for search results and profiles (approved providers only).
drop function if exists public.vendor_stats(uuid[]);
create function public.vendor_stats(p_ids uuid[])
returns table (vendor_id uuid, customers int, claims int, rating numeric, reviews int, resp_hours numeric, score int)
language sql stable security definer set search_path = public as $$
  select v.id,
    (select count(*)::int from bookings b where b.vendor_id = v.id and b.status in ('scheduled','active','completed')),
    (select count(*)::int from claims c where c.vendor_id = v.id),
    s.rating, coalesce(s.reviews, 0), s.resp_hours, s.score
  from vendors v left join public.vendor_scores() s on s.vendor_id = v.id
  where v.id = any(p_ids) and v.status = 'approved';
$$;
grant execute on function public.vendor_stats(uuid[]) to anon, authenticated;

-- Published reviews for a provider profile.
create or replace function public.vendor_reviews(p_slug text, p_limit int default 20)
returns table (rating int, comment text, customer_label text, plan text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.rating, r.comment, r.customer_label, b.plan, r.created_at
  from reviews r join vendors v on v.id = r.vendor_id join bookings b on b.id = r.booking_id
  where v.slug = p_slug and v.status = 'approved' and not r.hidden
  order by r.created_at desc limit least(greatest(p_limit, 1), 50);
$$;
grant execute on function public.vendor_reviews(text, int) to anon, authenticated;

-- A customer's private booking page (their account): booking, visits, payments, review, referral.
create or replace function public.get_booking(p_ref text, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b bookings; out jsonb;
begin
  select * into b from bookings where ref = upper(p_ref);
  if b.id is null or b.access_token is distinct from p_token then return null; end if;
  select jsonb_build_object(
    'booking', to_jsonb(b) - 'access_token' - 'stripe_customer_id' - 'stripe_payment_method_id' - 'prepay_payment_id'
      || jsonb_build_object('has_card', b.stripe_payment_method_id is not null),
    'vendor', (select jsonb_build_object('business', business, 'slug', slug, 'phone', phone) from vendors where id = b.vendor_id),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'amount_cents', amount_cents, 'discount_cents', discount_cents,
        'refunded_cents', refunded_cents, 'status', status, 'kind', kind, 'created_at', created_at) order by created_at desc)
      from payments where booking_id = b.id and kind <> 'prepaid_visit'), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'visit_date', visit_date, 'items', items, 'notes', notes,
        'has_photo', photo_path is not null) order by visit_date desc, created_at desc) from visits where booking_id = b.id), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('description', description, 'status', status, 'created_at', created_at) order by created_at desc) from claims where booking_id = b.id), '[]'::jsonb),
    'review', (select jsonb_build_object('rating', rating, 'comment', comment, 'created_at', created_at) from reviews where booking_id = b.id),
    'referrals', (select jsonb_build_object('earned', count(*) filter (where status = 'earned'), 'pending', count(*) filter (where status = 'pending'))
      from referrals where referrer_booking_id = b.id)
  ) into out;
  return out;
end $$;
grant execute on function public.get_booking(text, text) to anon, authenticated;

-- Business numbers by month for the operator console.
create or replace function public.monthly_metrics(p_months int default 12)
returns table (month date, new_customers int, cancellations int, collected_cents bigint, fee_cents bigint, refunded_cents bigint, payouts_cents bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
  with m as (select generate_series(date_trunc('month', now()) - make_interval(months => greatest(p_months, 1) - 1), date_trunc('month', now()), interval '1 month')::date as month)
  select m.month,
    (select count(*)::int from bookings b where b.status not in ('pending_card','new') and date_trunc('month', coalesce(b.matched_at, b.created_at))::date = m.month),
    (select count(*)::int from bookings b where b.status = 'cancelled' and b.vendor_id is not null and date_trunc('month', b.cancelled_at)::date = m.month),
    (select coalesce(sum(p.amount_cents), 0)::bigint from payments p where p.status = 'succeeded' and p.kind <> 'prepaid_visit' and date_trunc('month', p.created_at)::date = m.month),
    (select coalesce(sum(p.fee_cents), 0)::bigint from payments p where p.status = 'succeeded' and date_trunc('month', p.created_at)::date = m.month),
    (select coalesce(sum(p.refunded_cents), 0)::bigint from payments p where date_trunc('month', p.created_at)::date = m.month),
    (select coalesce(sum(p.net_cents), 0)::bigint from payments p where p.status = 'succeeded' and date_trunc('month', p.created_at)::date = m.month)
  from m order by m.month;
end $$;
grant execute on function public.monthly_metrics(int) to authenticated;

-- ---------- hourly job: provider response deadlines ----------
select cron.unschedule('mowbrokers-hourly') where exists (select 1 from cron.job where jobname = 'mowbrokers-hourly');
select cron.schedule('mowbrokers-hourly', '7 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/daily',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from private.app_secrets where name = 'cron')),
    body := '{"task":"hourly"}'::jsonb
  );
$$);
