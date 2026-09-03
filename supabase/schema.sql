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

-- ---------------------------------------------------------------------------
-- SLICE C: invites + pairing (partner invite/accept flow) + pair-scoped feed
--
-- Security model (the accept path, decided in slice C):
--  * invites are inviter-scoped under RLS: select/insert/update/delete all
--    require auth.uid() = inviter_id. There is NO unauthenticated write path
--    to the invites table and no "anyone holding the token can update the row"
--    policy — the token alone can never mutate invite rows.
--  * Accepting REQUIRES auth: the invitee signs up through the normal auth
--    path first, then calls accept_invite(token) with their own JWT. The
--    token (a random, readable code) is the capability: holding it can only
--    pair YOUR account with the inviter; it cannot impersonate or mutate
--    anything. accept_invite is a SECURITY DEFINER function that validates the
--    token, prevents self-accept, prevents double-accept, creates the pair
--    group (type 'pair' by shape: exactly 2 memberships) and inserts BOTH
--    memberships in one transaction.
--  * The public (unauthenticated) Accept screen reads ONLY get_invite(token),
--    which returns the inviter's first name + whether they have logs — no
--    email, no rows, no photo paths.
--  * Photo isolation is preserved and extended NARROWLY: pairing adds a
--    pair-scoped READ grant only — a user may SELECT workout rows (and the
--    storage objects backing them via signed URLs) authored by their single
--    accepted pair partner, and ONLY that. Workouts insert/update/delete and
--    storage write/delete remain strictly auth.uid()-scoped. Everyone else's
--    photos stay sealed.
-- ---------------------------------------------------------------------------

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references public.users (id) on delete cascade,
  token text not null unique,
  invitee_email text,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

alter table public.invites enable row level security;

create policy "invites_select_own" on public.invites
  for select using (auth.uid() = inviter_id);
create policy "invites_insert_own" on public.invites
  for insert with check (auth.uid() = inviter_id);
create policy "invites_update_own" on public.invites
  for update using (auth.uid() = inviter_id) with check (auth.uid() = inviter_id);
create policy "invites_delete_own" on public.invites
  for delete using (auth.uid() = inviter_id);

-- A user may now SELECT a workout authored by their accepted pair partner.
-- Own-row select policy above still applies (auth.uid() = user_id); this
-- policy is ADDITIVE and only fires for OTHER users' rows, and only inside a
-- group with exactly two members where I am the other member (i.e. my single
-- accepted partner).
create policy "workouts_select_pair" on public.workouts
  for select using (
    auth.uid() <> user_id
    and exists (
      select 1
      from public.memberships mine
      join public.memberships theirs on theirs.group_id = mine.group_id
      where mine.user_id = auth.uid()
        and theirs.user_id = workouts.user_id
        and (select count(*) from public.memberships m where m.group_id = mine.group_id) = 2
    )
  );

-- Pair-scoped storage READ: a user may sign URLs for objects under their
-- accepted partner's `${user_id}/` prefix (still never public-read, still
-- signed-URL-only). Write/delete under other prefixes stay forbidden.
create policy "workouts_storage_read_pair" on storage.objects
  for select using (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and exists (
      select 1
      from public.memberships mine
      join public.memberships theirs on theirs.group_id = mine.group_id
      where mine.user_id = auth.uid()
        and theirs.user_id = storage.foldername(name)[1]::uuid
        and theirs.user_id <> auth.uid()
        and (select count(*) from public.memberships m where m.group_id = mine.group_id) = 2
    )
  );

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Public (unauthenticated ok): resolve a pending invite code to the minimal
-- info the Accept landing screen needs (inviter first name + has-logs flag).
-- Returns one row (found) or nothing (not found / not pending).
create or replace function public.get_invite(p_token text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'inviter_name', coalesce(split_part(u.name, ' ', 1), 'Your partner'),
    'inviter_has_logs', exists (
      select 1 from public.workouts w where w.user_id = i.inviter_id
    ),
    'found', true
  )
  from public.invites i
  join public.users u on u.id = i.inviter_id
  where i.token = p_token and i.status = 'pending'
  limit 1;
$$;

-- Authenticated: pair the CURRENT auth.uid() with the inviter of this token.
-- Validates: token exists + pending; not your own invite. Creates the pair
-- group ("{FirstName} & {FirstName}") and both memberships in one transaction;
-- copies the inviter's weekly goal; invites get goal 3 until they onboard
-- (commitOnboarding upserts their real goal into the pair membership).
create or replace function public.accept_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_row public.invites%rowtype;
  inviter_goal int;
  inviter_first text;
  invitee_first text;
  pair_group_id uuid;
  my_id uuid := auth.uid();
begin
  if my_id is null then
    raise exception 'auth required';
  end if;

  select * into invite_row
  from public.invites
  where token = p_token
  for update;

  if invite_row is null then
    raise exception 'code not found';
  end if;
  if invite_row.status <> 'pending' then
    raise exception 'already accepted';
  end if;
  if invite_row.inviter_id = my_id then
    raise exception 'you cannot accept your own invite';
  end if;

  select coalesce(m.weekly_goal, 3)
    into inviter_goal
    from public.memberships m
    where m.user_id = invite_row.inviter_id
    order by m.created_at desc
    limit 1;

  select coalesce(split_part(u.name, ' ', 1), 'Partner')
    into inviter_first
    from public.users u
    where u.id = invite_row.inviter_id;

  select coalesce(split_part(u.name, ' ', 1), 'You')
    into invitee_first
    from public.users u
    where u.id = my_id;

  insert into public.groups (name, creator_id)
  values (inviter_first || ' & ' || invitee_first, invite_row.inviter_id)
  returning id into pair_group_id;

  insert into public.memberships (group_id, user_id, weekly_goal, role)
  values
    (pair_group_id, invite_row.inviter_id, inviter_goal, 'admin'),
    (pair_group_id, my_id, 3, 'member')
  on conflict (group_id, user_id) do nothing;

  update public.invites
     set status = 'accepted', accepted_at = now()
   where id = invite_row.id;

  return jsonb_build_object(
    'ok', true,
    'group_id', pair_group_id,
    'inviter_name', inviter_first
  );
end;
$$;

revoke all on function public.get_invite(text) from public;
grant execute on function public.get_invite(text) to anon, authenticated;
revoke all on function public.accept_invite(text) from public;
grant execute on function public.accept_invite(text) to authenticated;
-- ---------------------------------------------------------------------------