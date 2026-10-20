-- Run this in: Supabase Dashboard → SQL Editor → New query

create table if not exists match_signups (
  id             uuid        primary key default gen_random_uuid(),
  order_id       text        unique,          -- SumUp transaction/checkout ID, prevents duplicate rows
  match_date     date,                        -- parsed from product name, e.g. 2026-12-04
  venue_code     text,                        -- e.g. TD, WM
  canonical_name text        not null,        -- name from player_access (or raw if no account)
  raw_name       text,                        -- name as typed by customer in SumUp
  email          text        not null,
  product_name   text,                        -- full original product name string from SumUp
  created_at     timestamptz default now()
);

alter table match_signups enable row level security;

-- Scoring app (anon key) can read signups to populate the roster screen
create policy "anon_read" on match_signups
  for select to anon using (true);

-- Edge Function uses service_role key — full access
create policy "service_write" on match_signups
  for all to service_role using (true);

-- Handy index for the roster screen query (lookup by date)
create index if not exists match_signups_date_idx on match_signups (match_date);

-- Required from Oct 30 2026: explicit grants for new tables
grant select on public.match_signups to anon;
grant select, insert, update, delete on public.match_signups to authenticated;
grant select, insert, update, delete on public.match_signups to service_role;
