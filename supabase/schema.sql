-- Holy Hostel PMS — Supabase schema
-- Run this once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to re-run: it only creates what is missing and replaces the functions/policies.

-- ─────────────────────────────────────────────────────────────
-- 1. Data: one table holds every record (bookings, rooms, settings, expenses, images…)
--    "collection" is the record type, "id" its key, "data" the record itself.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.docs (
  collection  text        not null,
  id          text        not null,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists docs_bookings_checkout on public.docs ((data->>'checkOut')) where collection = 'bookings';
create index if not exists docs_images_booking   on public.docs ((data->>'bookingId')) where collection = 'images';
alter table public.docs replica identity full;

-- ─────────────────────────────────────────────────────────────
-- 2. Devices: each tablet/phone/computer is approved once with a setup code.
--    No daily login: the device stays approved until you remove it.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.devices (
  uid         uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  role        text not null default 'staff' check (role in ('staff','admin')),
  created_at  timestamptz not null default now()
);

-- Setup codes live here. No one can read this table from the app.
create table if not exists public.app_secrets (
  id          int primary key default 1 check (id = 1),
  staff_code  text not null,
  admin_code  text not null
);

create table if not exists public.claim_failures (
  uid  uuid not null,
  at   timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- 3. Helper functions
-- ─────────────────────────────────────────────────────────────
create or replace function public.is_device() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.devices where uid = auth.uid())
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.devices where uid = auth.uid() and role = 'admin')
$$;

-- Called by the app the first time a device opens the PMS.
create or replace function public.claim_device(code text, device_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  s public.app_secrets;
  r text;
begin
  if auth.uid() is null then raise exception 'Not connected'; end if;
  if (select count(*) from public.claim_failures where uid = auth.uid() and at > now() - interval '1 hour') >= 5
     or (select count(*) from public.claim_failures where at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many wrong codes. Wait an hour and try again.';
  end if;
  select * into s from public.app_secrets where id = 1;
  if s.id is null then raise exception 'Setup codes have not been set yet (see README step 3).'; end if;
  if code = s.admin_code then r := 'admin';
  elsif code = s.staff_code then r := 'staff';
  else
    -- recorded (not raised) so the attempt counter survives; the app shows "Wrong setup code"
    insert into public.claim_failures(uid) values (auth.uid());
    return null;
  end if;
  insert into public.devices(uid, name, role)
  values (auth.uid(), coalesce(nullif(trim(device_name), ''), 'Device'), r)
  on conflict (uid) do update set name = excluded.name, role = excluded.role;
  return r;
end $$;

-- Merge fields into a record in one step (no lost updates when two tablets save at once).
create or replace function public.doc_merge(p_collection text, p_id text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.docs set data = data || p_patch, updated_at = now()
  where collection = p_collection and id = p_id;
  if not found then
    raise exception 'Record not found: %/%', p_collection, p_id using errcode = 'P0002';
  end if;
end $$;

revoke all on function public.claim_device(text, text) from public, anon;
grant execute on function public.claim_device(text, text) to authenticated;
grant execute on function public.doc_merge(text, text, jsonb) to authenticated;
grant execute on function public.is_device() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 4. Row-level security — only approved devices can see or change anything.
--    Rooms, settings, expenses and OTA invoices can only be changed by an owner (admin) device.
--    Expenses are only visible to owner devices.
-- ─────────────────────────────────────────────────────────────
alter table public.docs           enable row level security;
alter table public.devices        enable row level security;
alter table public.app_secrets    enable row level security;
alter table public.claim_failures enable row level security;

drop policy if exists docs_read   on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

create policy docs_read on public.docs for select to authenticated
  using (public.is_device() and (collection <> 'expenses' or public.is_admin()));

create policy docs_insert on public.docs for insert to authenticated
  with check (public.is_device() and (collection not in ('units','settings','payouts','expenses','cmconfig','ari') or public.is_admin()));

create policy docs_update on public.docs for update to authenticated
  using      (public.is_device() and (collection not in ('units','settings','payouts','expenses','cmconfig','ari') or public.is_admin()))
  with check (public.is_device() and (collection not in ('units','settings','payouts','expenses','cmconfig','ari') or public.is_admin()));

create policy docs_delete on public.docs for delete to authenticated
  using (public.is_device() and (collection not in ('units','settings','payouts','expenses','cmconfig','ari') or public.is_admin()));

drop policy if exists devices_read on public.devices;
create policy devices_read on public.devices for select to authenticated
  using (uid = auth.uid() or public.is_device());

-- ─────────────────────────────────────────────────────────────
-- 5. Live updates between tablets
-- ─────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
