-- MowBrokers — initial schema
-- Run in Supabase: SQL Editor > New query > paste > Run.
-- All writes go through the app's server code (service role) with explicit field checks.
-- Row Level Security is ON everywhere; browsers can only read what policies below allow.

create extension if not exists "pgcrypto";

-- ---------- people ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'provider' check (role in ('provider','admin')),
  full_name text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- platform settings (single row) ----------
create table public.settings (
  id int primary key default 1 check (id = 1),
  take_rate numeric not null default 0.12,
  round_to int not null default 5,
  goal_pairs int not null default 500,
  season jsonb not null default '{"weeks":30,"label":"April–October"}',
  fert_apps int not null default 6 check (fert_apps between 1 and 12),
  lots jsonb not null,
  terrains jsonb not null,
  coverages jsonb not null,
  suggested jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.settings (id, lots, terrains, coverages, suggested) values (1,
  '[{"label":"Under ¼ acre","min":0,"scale":1.0},{"label":"¼–½ acre","min":0.25,"scale":1.6},{"label":"½–1 acre","min":0.5,"scale":2.6},{"label":"1–2 acres","min":1,"scale":4.0},{"label":"Over 2 acres","min":2,"scale":6.0}]',
  '[{"label":"Flat and open","mult":1.00},{"label":"Some slopes or obstacles","mult":1.15},{"label":"Steep or heavily landscaped","mult":1.30}]',
  '[{"label":"Front and back","mult":1.00},{"label":"Front yard only","mult":0.60},{"label":"Back yard only","mult":0.55}]',
  '{"mowTiers":[45,55,70,95,130],"biweeklyPremium":0.15,"oneTimeMult":1.5,"fertTiers":[55,70,95,135,190],"bundleDiscount":0.10,"addons":{"aeration":95,"leafCleanup":175,"shrubTrim":85}}'
);

-- ---------- providers ----------
create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid unique references auth.users(id) on delete set null,
  slug text unique not null,
  status text not null default 'applied' check (status in ('applied','vetting','approved','suspended','rejected')),
  business text not null,
  contact text not null,
  phone text not null,
  email text not null,
  years int not null default 0,
  techs int not null default 1,
  about text not null default '',
  license text not null,                 -- city business license, or ADAI Horticulture Professional Services license if offering treatments
  operator text not null default '',     -- OTPS certified operator (required only if offering treatments)
  categories text[] not null default '{MOW}' check (categories <@ array['MOW','OTPS','SLP','TS']::text[]),
  insurance_carrier text not null,
  insurance_coverage int not null default 0,
  insurance_expires date not null,
  coi_path text,
  zips text[] not null default '{}',
  rate_card jsonb not null,
  custom_jobs text[] not null default '{}',
  checklist jsonb not null default '{}',
  notes text not null default '',
  stripe_account_id text unique,
  stripe_charges_enabled boolean not null default false,
  stripe_payouts_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  updated_at timestamptz not null default now()
);
create index vendors_status_idx on public.vendors(status);
create index vendors_zips_idx on public.vendors using gin (zips);

-- ---------- bookings ----------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null,
  access_token text not null,
  status text not null check (status in ('pending_card','new','matched','scheduled','active','completed','cancelled')),
  chosen_by_customer boolean not null default false,
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  sms_consent boolean not null default false,
  street text not null,
  zip text not null,
  yard jsonb not null,                   -- {acres, terrain, coverage}
  plan text not null check (plan in ('Weekly','Every two weeks','One-time cut','No mowing')),
  addons jsonb not null,
  custom text[] not null default '{}',
  notes text not null default '',
  preferred_start date,
  first_visit date,
  vendor_id uuid references public.vendors(id) on delete set null,
  quote jsonb,
  stripe_customer_id text,
  stripe_payment_method_id text,
  visits_charged int not null default 0,
  fert_charged int not null default 0,
  created_at timestamptz not null default now(),
  matched_at timestamptz,
  scheduled_at timestamptz,
  cancelled_at timestamptz,
  nudged_at timestamptz
);
create index bookings_vendor_idx on public.bookings(vendor_id);
create index bookings_status_idx on public.bookings(status);

-- ---------- payments ----------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  vendor_id uuid references public.vendors(id) on delete set null,
  kind text not null check (kind in ('visit','fert')),
  label text not null,
  amount_cents int not null,
  fee_cents int not null,
  net_cents int not null,
  status text not null default 'processing' check (status in ('processing','succeeded','failed')),
  failure_message text,
  stripe_payment_intent_id text unique,
  created_at timestamptz not null default now()
);
create index payments_booking_idx on public.payments(booking_id);
create index payments_vendor_idx on public.payments(vendor_id);

-- ---------- re-service claims ----------
create table public.claims (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  vendor_id uuid references public.vendors(id) on delete set null,
  description text not null,
  status text not null default 'open' check (status in ('open','vendor_notified','resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index claims_vendor_idx on public.claims(vendor_id);

-- ---------- notification log ----------
create table public.notifications (
  id bigint generated always as identity primary key,
  event text not null,
  channel text not null,
  recipient text not null,
  ok boolean not null,
  error text,
  created_at timestamptz not null default now()
);

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.vendors enable row level security;
alter table public.bookings enable row level security;
alter table public.payments enable row level security;
alter table public.claims enable row level security;
alter table public.notifications enable row level security;

create policy "own profile" on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "settings readable" on public.settings for select using (true);
create policy "own vendor or admin" on public.vendors for select using (owner_id = auth.uid() or public.is_admin());
create policy "vendor sees own bookings" on public.bookings for select using (
  public.is_admin() or vendor_id in (select id from public.vendors where owner_id = auth.uid()));
create policy "vendor sees own payments" on public.payments for select using (
  public.is_admin() or vendor_id in (select id from public.vendors where owner_id = auth.uid()));
create policy "vendor sees own claims" on public.claims for select using (
  public.is_admin() or vendor_id in (select id from public.vendors where owner_id = auth.uid()));
create policy "admin reads log" on public.notifications for select using (public.is_admin());

-- ---------- storage for insurance certificates (private) ----------
insert into storage.buckets (id, name, public) values ('coi', 'coi', false) on conflict (id) do nothing;

-- =====================================================================
-- Static-site additions: what the public HTML pages may read directly.
-- Writes still go only through Edge Functions (service role).
-- =====================================================================

-- Public provider directory: safe columns only, approved providers only.
create or replace view public.public_vendors as
  select id, slug, status, business, years, techs, about, license, operator, categories,
         insurance_coverage, insurance_expires, zips, rate_card, custom_jobs, stripe_charges_enabled
  from public.vendors where status = 'approved';
grant select on public.public_vendors to anon, authenticated;

-- Customer counts and re-service counts for profile cards.
create or replace function public.vendor_stats(p_ids uuid[])
returns table (vendor_id uuid, customers int, claims int)
language sql stable security definer set search_path = public as $$
  select v.id,
    (select count(*)::int from bookings b where b.vendor_id = v.id and b.status in ('scheduled','active','completed')),
    (select count(*)::int from claims c where c.vendor_id = v.id)
  from vendors v where v.id = any(p_ids) and v.status = 'approved';
$$;
grant execute on function public.vendor_stats(uuid[]) to anon, authenticated;

-- A customer's private booking page: needs the booking ref and its secret token.
create or replace function public.get_booking(p_ref text, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b bookings; out jsonb;
begin
  select * into b from bookings where ref = upper(p_ref);
  if b.id is null or b.access_token is distinct from p_token then return null; end if;
  select jsonb_build_object(
    'booking', to_jsonb(b) - 'access_token' - 'stripe_customer_id' - 'stripe_payment_method_id'
      || jsonb_build_object('has_card', b.stripe_payment_method_id is not null),
    'vendor', (select jsonb_build_object('business', business, 'slug', slug, 'phone', phone) from vendors where id = b.vendor_id),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'amount_cents', amount_cents, 'status', status, 'created_at', created_at) order by created_at desc) from payments where booking_id = b.id), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('description', description, 'status', status, 'created_at', created_at) order by created_at desc) from claims where booking_id = b.id), '[]'::jsonb)
  ) into out;
  return out;
end $$;
grant execute on function public.get_booking(text, text) to anon, authenticated;

-- Never let browsers call the internal helper directly with elevated rights.
revoke execute on function public.handle_new_user() from anon, authenticated;
