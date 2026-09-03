-- SPOTTER — Phase 1 MVP schema (Slice A: auth + onboarding).
-- Apply to a Supabase project via the SQL editor (or `supabase db push` after
-- init + link). Must stay in sync with src/lib/database.types.ts.
--
-- RLS is ON for every table. Every future photo/workout row is scoped to
-- auth.uid() — photo isolation is a trust requirement, never relax these
-- policies (see footer note for slice B).

-- users: 1:1 with auth.users (id = auth.uid())
create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  week_start_day text not null check (week_start_day in ('Sun','Mon','Tue','Wed','Thu','Fri','Sat')),
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;

create policy "users_select_own" on public.users
  for select using (auth.uid() = id);
create policy "users_insert_own" on public.users
  for insert with check (auth.uid() = id);
create policy "users_update_own" on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "users_delete_own" on public.users
  for delete using (auth.uid() = id);

-- groups: a membership is required to see a group; the creator owns its row.
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  creator_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.groups enable row level security;

-- Once slice B adds real memberships, group reads can be scoped further via a
-- membership check; for slice A the creator is the only member, so this is
-- equivalent and safe.
create policy "groups_select_own" on public.groups
  for select using (auth.uid() = creator_id);
create policy "groups_insert_own" on public.groups
  for insert with check (auth.uid() = creator_id);
create policy "groups_update_own" on public.groups
  for update using (auth.uid() = creator_id) with check (auth.uid() = creator_id);
create policy "groups_delete_own" on public.groups
  for delete using (auth.uid() = creator_id);

-- memberships: weekly_goal per (group, user); unique group+user.
create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  weekly_goal integer not null check (weekly_goal between 1 and 7),
  role text not null default 'member' check (role in ('member','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, user_id)
);

alter table public.memberships enable row level security;

create policy "memberships_select_own" on public.memberships
  for select using (auth.uid() = user_id);
-- Insert restricted to the user's own row; the group must exist and the user
-- must be its creator (slice A: personal group). Policy chain: a membership
-- insert is visible if the user owns it or is the group creator.
create policy "memberships_insert_own" on public.memberships
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.groups g
      where g.id = group_id and g.creator_id = auth.uid()
    )
  );
create policy "memberships_update_own" on public.memberships
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "memberships_delete_own" on public.memberships
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- SLICE B: workouts + photo-proof storage (photo isolation — trust requirement)
-- ---------------------------------------------------------------------------
-- Every workouts row and every storage object is STRICTLY scoped to
-- auth.uid(). This is a non-negotiable trust requirement: a user's photo
-- proof must never be readable or writable by any other account. The private
-- storage bucket is accessed ONLY through short-lived signed URLs; there is
-- no public-read access of any kind.
-- ---------------------------------------------------------------------------

-- workouts: one row per logged workout (photo proof path + optional type).
create table if not exists public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  group_id uuid references public.groups (id) on delete set null,
  photo_path text not null,
  logged_at timestamptz not null default now(),
  workout_type text,
  created_at timestamptz not null default now(),
  check (workout_type is null or length(workout_type) between 1 and 40)
);

alter table public.workouts enable row level security;

create policy "workouts_select_own" on public.workouts
  for select using (auth.uid() = user_id);
create policy "workouts_insert_own" on public.workouts
  for insert with check (auth.uid() = user_id);
create policy "workouts_update_own" on public.workouts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "workouts_delete_own" on public.workouts
  for delete using (auth.uid() = user_id);

create index if not exists workouts_user_week_idx
  on public.workouts (user_id, logged_at desc);

-- ---------------------------------------------------------------------------
-- Photo storage — private "workouts" bucket + per-user object policies.
--
-- The client uploads to `${user_id}/${workout_id}.jpg` (photo_path on the
-- workouts row is exactly this path, NOT a public URL) and reads back only
-- via `createSignedUrl` / `createSignedUrls` from the Storage API.
--
-- In a real project the bucket itself is created with `storage.createBucket`
-- (or manually): private = true, so cargo.default gives it a random suffix
-- and no public-read setting. In the SQL editor the equivalent is:
--
--   insert into storage.buckets (id, name, public)
--   values ('workouts', 'workouts', false);
--
-- then run the policies below. Idempotent: safe to paste alongside the rest
-- of this file after a `supabase db reset`.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('workouts', 'workouts', false)
on conflict (id) do nothing;

-- Authenticated signers may write (and delete) ONLY under their own
-- `${auth.uid()}/` prefix; anyone else's prefix is invisible and unreadable.
create policy "workouts_storage_read_own" on storage.objects
  for select using (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and storage.foldername(name)[1] = auth.uid()::text
  );
create policy "workouts_storage_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and storage.foldername(name)[1] = auth.uid()::text
  );
create policy "workouts_storage_update_own" on storage.objects
  for update using (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and storage.foldername(name)[1] = auth.uid()::text
  ) with check (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and storage.foldername(name)[1] = auth.uid()::text
  );
create policy "workouts_storage_delete_own" on storage.objects
  for delete using (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and storage.foldername(name)[1] = auth.uid()::text
  );

-- NEVER relax the policies above. The bucket must stay private; photo URLs
-- served to the app are signed URLs only, and only for the owner (+ future
-- partner via an explicit cross-prefix grant that is still policy-scoped).
-- ---------------------------------------------------------------------------