-- SPOTTER — 2026-09-19 — build-18 first-party crash breadcrumb: app_diagnostics.
--
-- Insert-only RLS for anon + authenticated. A crash can fire before sign-in
-- (and the JS handler may run before the supabase auth session is restored), so
-- anon must be able to append. There is deliberately NO client SELECT/UPDATE/
-- DELETE policy — reads are service-role only (dashboards), mirroring
-- analytics_events. NO PII beyond the error content itself (no user id, name,
-- email, install id, or session id). Idempotent (create table if not exists).
create table if not exists public.app_diagnostics (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  stack text,
  app_version text,
  build_number text,
  ts timestamptz not null default now()
);
alter table public.app_diagnostics enable row level security;
create index if not exists app_diagnostics_ts_idx
  on public.app_diagnostics (ts desc);
create policy "app_diagnostics_insert_anon_authenticated" on public.app_diagnostics
  for insert to anon, authenticated
  with check (true);
