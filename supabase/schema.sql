-- SPOTTER — Phase 1 MVP schema (Slice A: auth + onboarding).
-- Apply to a Supabase project via the SQL editor (or `supabase db push` after
-- init + link). Must stay in sync with src/lib/database.types.ts.
--
-- RLS is ON for every table. Every future photo/workout row is scoped to
-- auth.uid() — photo isolation is a trust requirement, never relax these
-- policies (see footer note for slice B).
--
-- NAMING FEATURE (optional pet name + team name): this file adds a nullable
-- `groups.team_name` column (idempotent ALTER below). Existing/live projects
-- MUST apply that ALTER before running a build that reads groups.team_name
-- (the matching client code is in src/lib/naming.ts + workoutStore.ts). The
-- pet name is LOCAL-ONLY (AsyncStorage) and needs no schema change.
--
-- UNPAIR FEATURE (App Store 5.1.1(v): users must be able to stop receiving
-- partner UGC): this file adds a `public.unpair()` RPC (additive, no table/
-- policy changes). Existing/live projects MUST apply that CREATE FUNCTION
-- before running a build that calls it (client code in src/lib/invites.ts).
--
-- GROUPS FEATURE (v1.0, owner decision 2026-09-11): the pair mechanism
-- generalizes to a shared group of up to group_capacity() members (v1.0 = 3:
-- you + up to 2 partners; the future Spotter+ tier raises the cap by changing
-- ONE function). Changes: is_paired_with flips to >= 2 so every pair policy
-- covers all co-members; my_group() replaces my_pair(); join_group() replaces
-- accept_invite(); leave_group() replaces unpair(); get_invite() gains
-- member_count/has_group; group policies are renamed _pair -> _group/_member
-- (bodies unchanged); a memberships BEFORE INSERT trigger enforces the cap.
-- The old pair RPCs (my_pair/accept_invite/unpair) are dropped in this file.

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

-- OPTIONAL PAIR TEAM NAME (naming feature). The `name` column above is the
-- AUTO-GENERATED label ("{A} & {B}" / "Personal") and stays NOT NULL; the
-- user-editable "team name" (e.g. "Team Us", wedding-party name) is a SEPARATE
-- nullable column so an unset name leaves the UI byte-identical (feed header
-- falls back to "Paired with {partner}"). Additive-only — no policy/table
-- changes. Existing/live projects MUST apply this ALTER before running a build
-- that reads groups.team_name.
alter table public.groups add column if not exists team_name text;

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
-- v1.0 dual-capture (onboarding-copy-addendum-2026-09-11.md §2): every log has
-- TWO live shots — a selfie (photo_path, optionally tonally graded on-device
-- and BAKED at capture) and an UNFILTERED environment shot (photo_env) — plus
-- an optional caption (≤140 chars). Additive: legacy rows have photo_env NULL /
-- caption NULL and render single-thumb. Both objects live under the SAME
-- `${user_id}/` storage prefix, so the per-user storage policies below are
-- unchanged — photo isolation keeps its existing guarantees.
create table if not exists public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  group_id uuid references public.groups (id) on delete set null,
  photo_path text not null,
  photo_env text,
  caption text,
  logged_at timestamptz not null default now(),
  workout_type text,
  created_at timestamptz not null default now(),
  check (workout_type is null or length(workout_type) between 1 and 40),
  check (caption is null or length(caption) between 1 and 140)
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

-- v1.0 dual-capture columns on EXISTING projects (camera-flow feature, owner
-- decision 2026-09-11): the CREATE TABLE above declares photo_env/caption for
-- fresh installs, but `create table if not exists` is a NO-OP when the table
-- already exists — these idempotent ALTERs upgrade an existing live table
-- (same pattern as the groups.team_name ALTER above) so a re-run converges:
-- both fresh and existing projects end with photo_env/caption present.
alter table public.workouts add column if not exists photo_env text;
alter table public.workouts add column if not exists caption text;

-- ...and the <=140-char caption check, added only when missing (never dropped
-- or relaxed): a fresh install gets `workouts_caption_check` from the CREATE
-- TABLE above; an existing table needs it added explicitly. This is the
-- DB-level backstop for the client-side <=140 enforcement.
do $s7$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.workouts'::regclass
       and conname = 'workouts_caption_check'
  ) then
    execute $$'alter table public.workouts'
      || ' add constraint workouts_caption_check'
      || ' check (caption is null or length(caption) between 1 and 140)'$$;
  end if;
end;
$s7$;

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
    and starts_with(name, auth.uid()::text || '/')
  );
create policy "workouts_storage_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and starts_with(name, auth.uid()::text || '/')
  );
create policy "workouts_storage_update_own" on storage.objects
  for update using (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and starts_with(name, auth.uid()::text || '/')
  ) with check (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and starts_with(name, auth.uid()::text || '/')
  );
create policy "workouts_storage_delete_own" on storage.objects
  for delete using (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and starts_with(name, auth.uid()::text || '/')
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
--    path first, then calls join_group(token) with their own JWT. The
--    token (a random, readable code) is the capability: holding it can only
--    join YOUR account to the inviter's CURRENT group; it cannot impersonate
--    or mutate anything. join_group is a SECURITY DEFINER function that
--    validates the token, prevents self-accept and double-join, resolves the
--    inviter's current shared group (creating it — inviter seat included — if
--    the inviter is still solo), enforces group_capacity() under a table lock,
--    and inserts the joiner's seat in one transaction.
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

-- ---------------------------------------------------------------------------
-- PAIR-READ HELPERS (v1.0 release-blocking fix — the pair-feed RLS bug family,
-- found by the real-mode smoke test 2026-09-10, report §2.1–2.3).
--
-- Root cause: RLS applies inside policy subqueries. The pair policies below
-- used to join public.memberships to find the partner, but memberships only
-- exposes OWN rows (memberships_select_own) — the partner's membership row was
-- invisible to the caller, so the pair check was ALWAYS false in real mode and
-- the app's client-side partner discovery saw every group as 1-member.
--
-- Fix: pair lookups now run inside SECURITY DEFINER functions owned by postgres
-- with search_path pinned to public. The definer (the table owner) bypasses
-- memberships RLS by design, yet the helpers are leak-proof: they only ever
-- resolve auth.uid()'s OWN shared group (any group with >= 2 members; the
-- 2-member pair is the base case — GROUPS feature flips the count check from
-- = 2 to >= 2 so every pair policy below covers all co-members), return
-- nothing for anon (auth.uid() is null), and is_paired_with's argument can
-- only flip the boolean for the caller's own co-members. Stranger isolation
-- is therefore unchanged: C is paired with nobody, so is_paired_with(C) is
-- false for every policy.
-- ---------------------------------------------------------------------------

create or replace function public.is_paired_with(p_other uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.group_id = mine.group_id
    where mine.user_id = auth.uid()
      and theirs.user_id = p_other
      and mine.user_id <> theirs.user_id
      and (select count(*) from public.memberships m where m.group_id = mine.group_id) >= 2  -- was: = 2
  );
$$;

-- Granted to anon too ONLY so anonymous policy evaluation resolves the function
-- (the function itself still returns false for anon — auth.uid() is null). All
-- pair-scoped reads require an authenticated caller anyway.
revoke all on function public.is_paired_with(uuid) from public;
grant execute on function public.is_paired_with(uuid) to anon, authenticated;

-- A user may now SELECT a workout authored by a co-member of their shared
-- group (a 2-member group = today's pair). Own-row select policy above still
-- applies (auth.uid() = user_id); this policy is ADDITIVE and only fires for
-- OTHER users' rows, and only when the caller truly shares a group with the
-- row's author (security definer check).
create policy "workouts_select_group" on public.workouts
  for select using (
    auth.uid() <> user_id
    and public.is_paired_with(user_id)
  );

-- Group-scoped storage READ: a user may sign URLs for objects under a
-- co-member's `${user_id}/` prefix (still never public-read, still
-- signed-URL-only). Write/delete under other prefixes stay forbidden.
create policy "workouts_storage_read_group" on storage.objects
  for select using (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and public.is_paired_with(split_part(name, '/', 1)::uuid)
  );

-- Group-scoped read of a co-member's users row (names in the feed; the app
-- reads `users.name` for the resolved ids from my_group()). Own-row access
-- stays on users_select_own; this ADDITIVE policy covers the other seats.
create policy "users_select_group" on public.users
  for select using (
    auth.uid() <> id
    and public.is_paired_with(id)
  );

-- Group-scoped read of the SHARED GROUP row (team_name — naming feature): any
-- member may read it. Own-row (membership-scoped) check only — the caller's own
-- membership row IS visible under memberships RLS, so no security definer is
-- needed here. Write stays creator-only (groups_update_own), exactly as before.
--
-- NOTE: `groups.id` must be QUALIFIED — inside the correlated subquery the
-- bare `id` binds to memberships.id (the inner table's column shadows the
-- outer one), which would make the check `m.group_id = m.id` → never true.
create policy "groups_select_member" on public.groups
  for select using (
    exists (
      select 1 from public.memberships m
      where m.group_id = groups.id and m.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Authenticated: resolve auth.uid()'s shared GROUP (>=2 members) — the
-- N-member generalization of the old my_pair() (2-member pair = base case).
-- Returns {"group_id": uuid, "member_ids": [uuid,...] (co-members, excludes
-- self), "member_count": int (len of member_ids)}; all null/[]/0 when solo.
-- SECURITY DEFINER (same reasoning as is_paired_with: co-members' membership
-- rows are invisible under memberships RLS, so this is the app's one approved
-- group discovery path). Leak-proof: no arguments, and it computes ONLY from
-- auth.uid()'s own membership rows. v1.0 has ONE shared group per user (D4),
-- so singular is safe by construction.
create or replace function public.my_group()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  gid uuid;
  members uuid[];
begin
  if auth.uid() is null then
    raise exception 'auth required';
  end if;

  select mine.group_id into gid
    from public.memberships mine
   where mine.user_id = auth.uid()
     and (select count(*) from public.memberships m where m.group_id = mine.group_id) >= 2
   order by mine.created_at desc
   limit 1;

  if gid is null then
    return jsonb_build_object('group_id', null, 'member_ids', '[]'::jsonb, 'member_count', 0);
  end if;

  select array_agg(theirs.user_id order by theirs.created_at asc)
    into members
    from public.memberships theirs
   where theirs.group_id = gid
     and theirs.user_id <> auth.uid();

  return jsonb_build_object(
    'group_id', gid,
    'member_ids', coalesce(members, '{}'),
    'member_count', coalesce(cardinality(members), 0)
  );
end;
$function$;

revoke all on function public.my_group() from public;
grant execute on function public.my_group() to authenticated;
drop function if exists public.my_pair();

-- Public (unauthenticated ok): resolve a pending invite code to the minimal
-- info the Accept landing screen needs (inviter first name + has-logs flag +
-- group state). Returns one row (found) or nothing (not found / not pending).
-- `member_count` = the inviter's CURRENT co-members in their shared group
-- (2 when the inviter sits in a 3-person group), 0 when the inviter is solo /
-- has no shared group yet — the Accept screen renders total size as
-- member_count + 1 ("Join {A}'s group — 3 people in it").
-- `has_group` = the inviter currently holds a shared-group seat (>= 2 members)
-- — false → the Accept screen shows "Start a group with {A}" instead.
-- Same security posture: first name + has-logs + counts only, never rows,
-- emails or photo paths.
create or replace function public.get_invite(p_token text)
returns jsonb
language sql
security definer
set search_path = public
as $g$
  select jsonb_build_object(
    'inviter_name', coalesce(split_part(u.name, ' ', 1), 'Your partner'),
    'inviter_has_logs', exists (
      select 1 from public.workouts w where w.user_id = i.inviter_id
    ),
    'member_count', coalesce((
      select count(*)::int
        from public.memberships cm
       where cm.group_id = inviter_group.gid
         and cm.user_id <> i.inviter_id
    ), 0),
    'has_group', inviter_group.gid is not null,
    'found', true
  )
  from public.invites i
  join public.users u on u.id = i.inviter_id
  left join lateral (
    select mg.group_id as gid
      from public.memberships mg
     where mg.user_id = i.inviter_id
       and (select count(*) from public.memberships x where x.group_id = mg.group_id) >= 2
     order by mg.created_at desc
     limit 1
  ) inviter_group on true
  where i.token = p_token and i.status = 'pending'
  limit 1;
$g$;

revoke all on function public.get_invite(text) from public;
grant execute on function public.get_invite(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- GROUP SIZE CAP (v1.0, owner decision 2026-09-11): you + up to 2 partners = 3.
-- The cap lives in ONE function so the future Spotter+ paid tier can raise it
-- (or add an entitlement check) with a single-function change — no migrations,
-- no policy edits. Enforced two ways: join_group's exact count under a table
-- lock (below), and this always-on BEFORE INSERT trigger as the table-level
-- second line of defense for any membership insert path.
-- ---------------------------------------------------------------------------
create or replace function public.group_capacity()
returns integer
language sql
stable
set search_path = public
as $f$
  select 3;  -- v1.0 free tier: you + up to 2 partners. Future Spotter+ raises this here.
$f$;

revoke all on function public.group_capacity() from public;
grant execute on function public.group_capacity() to anon, authenticated;

create or replace function public.memberships_cap_guard()
returns trigger
language plpgsql
set search_path = public
as $f$
begin
  if (select count(*) from public.memberships m where m.group_id = new.group_id) >= public.group_capacity() then
    raise exception 'this group is full';
  end if;
  return new;
end;
$f$;

-- The cap-keeping insert trigger is created ONLY when absent — an idempotent
-- re-run guard. There is NO `drop trigger` anywhere in this file, so a re-run
-- can never silently remove the always-on cap guard (live projects must keep
-- this trigger: it is the table-level second line of defense behind
-- join_group's exact count under lock).
do $s7$
begin
  if not exists (
    select 1 from pg_trigger t
     where t.tgname = 'memberships_cap_guard_trg'
       and t.tgrelid = 'public.memberships'::regclass
       and not t.tgisinternal
  ) then
    execute $$'create trigger memberships_cap_guard_trg'
      || ' before insert on public.memberships'
      || ' for each row execute function public.memberships_cap_guard()'$$;
  end if;
end;
$s7$;

-- Authenticated: join the CURRENT auth.uid() to the inviter's group via token
-- (replaces the old accept_invite; a 2-member pair is just the 2-seat case).
-- Validates: token exists + pending; not your own invite. Resolves the
-- inviter's CURRENT shared group (>= 2 members); if the inviter is still solo,
-- creates a fresh group ("{FirstName} & {FirstName}", creator = inviter,
-- inviter's goal copied) and seats the inviter first — so a code always
-- resolves to the inviter's current group, never a stranger's. Enforces
-- group_capacity() (v1.0 = 3) exactly under a table lock, rejects
-- already-members (idempotent-ish), and seats the joiner with goal 3 until
-- onboarding/Profile upserts their real goal. One code, reusable by multiple
-- distinct accepters (status stays 'pending'); rotation = delete + regenerate.
create or replace function public.join_group(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  invite_row public.invites%rowtype;
  inviter_first text; invitee_first text;
  gid uuid; my_goal int; cnt int;
  my_id uuid := auth.uid();
begin
  if my_id is null then raise exception 'auth required'; end if;
  -- exact cap enforcement: serialize joins table-wide (join frequency is tiny)
  lock table public.memberships in share row exclusive mode;

  select * into invite_row from public.invites where token = p_token for update;
  if invite_row is null then raise exception 'code not found'; end if;
  if invite_row.status <> 'pending' then raise exception 'already accepted'; end if;  -- kept: an inviter may rotate to invalidate
  if invite_row.inviter_id = my_id then raise exception 'you cannot accept your own invite'; end if;

  -- Resolve the inviter's current shared group (create if solo; one group per user, D4)
  select m.group_id into gid
    from public.memberships m
   where m.user_id = invite_row.inviter_id
     and (select count(*) from public.memberships x where x.group_id = m.group_id) >= 2
   order by m.created_at desc limit 1;

  if gid is null then
    select coalesce(split_part(u.name,' ',1),'Partner') into inviter_first from public.users u where u.id = invite_row.inviter_id;
    select coalesce(split_part(u.name,' ',1),'You') into invitee_first from public.users u where u.id = my_id;
    insert into public.groups (name, creator_id) values (inviter_first || ' & ' || invitee_first, invite_row.inviter_id) returning id into gid;
    select coalesce(m.weekly_goal, 3) into my_goal from public.memberships m
      where m.user_id = invite_row.inviter_id order by m.created_at desc limit 1;
    insert into public.memberships (group_id, user_id, weekly_goal, role)
      values (gid, invite_row.inviter_id, coalesce(my_goal,3), 'admin');
  end if;

  select count(*) into cnt from public.memberships where group_id = gid;
  -- Already-member check FIRST: on a full group, an existing member re-entering
  -- the code must hear "you are already in this group", not a misleading
  -- "this group is full". The lock + the memberships insert trigger keep the
  -- cap airtight regardless of check order.
  if exists (select 1 from public.memberships m where m.group_id = gid and m.user_id = my_id) then
    raise exception 'you are already in this group';  -- idempotent-ish; client can map to a friendly message
  end if;
  if cnt >= public.group_capacity() then raise exception 'this group is full'; end if;

  insert into public.memberships (group_id, user_id, weekly_goal, role)
    values (gid, my_id, 3, 'member');  -- goal 3 until onboarding/Profile upserts their real goal

  return jsonb_build_object('ok', true, 'group_id', gid, 'member_count', cnt + 1,
    'inviter_name', coalesce((select split_part(u.name,' ',1) from public.users u where u.id = invite_row.inviter_id), 'Partner'));
end;
$function$;

revoke all on function public.join_group(text) from public;
grant execute on function public.join_group(text) to authenticated;
drop function if exists public.accept_invite(text);

-- Authenticated: remove the CURRENT auth.uid() from their shared group
-- (replaces the old unpair; a 2-member pair is just the 2-seat case).
-- Group exists iff it has >= 2 members:
--   * <= 2 seats total → remove our seat AND delete the group row (dissolve;
--     the survivor returns to pure solo — their "Personal" group always was a
--     separate row). Same observable outcome as today's 2-member unpair.
--   * >= 3 seats → the group outlives us: if we are the creator, reassign
--     creator_id to the OLDEST remaining member FIRST (groups.creator_id
--     references public.users ON DELETE CASCADE — reusing delete_account's
--     hand-over hygiene so our auth row can never nuke the group), then delete
--     only our own membership row. Remaining members' past workouts/photos
--     become invisible to us immediately (every read is membership-driven).
-- The leaver keeps ALL own rows (workouts survive with group_id set null via
-- the FK; photos stay under their own storage prefix).
--
-- SECURITY DEFINER (so a member can delete their OWN seat — same shape as
-- unpair; the group-row delete needs no extra grant) + no argument (a user can
-- only ever leave on THEIR OWN behalf). Idempotent: already-solo → no-op, ok.
create or replace function public.leave_group()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  my_id uuid := auth.uid();
  gid uuid;
  members_left int;
begin
  if my_id is null then
    raise exception 'auth required';
  end if;

  -- My current shared group (>=2 members); the 1-member "Personal" solo group
  -- is ignored and never touched.
  select mine.group_id into gid
  from public.memberships mine
  where mine.user_id = my_id
    and (select count(*) from public.memberships m where m.group_id = mine.group_id) >= 2
  order by mine.created_at desc
  limit 1;

  if gid is null then
    return jsonb_build_object('ok', true);  -- already solo: no-op
  end if;

  select count(*) into members_left
    from public.memberships m
   where m.group_id = gid;

  if members_left <= 2 then
    -- Removing our seat leaves <= 1 member: dissolve the group. The group-row
    -- delete cascades the remaining seats and sets workouts.group_id null
    -- (workout rows survive); the survivor keeps only their Personal group.
    delete from public.groups where id = gid;
  else
    -- The group outlives us (>= 2 seats remain after our leave): if we created
    -- it, hand creator_id to the oldest remaining member FIRST (same logic as
    -- delete_account), then remove only our own seat.
    update public.groups
       set creator_id = (
         select m2.user_id
           from public.memberships m2
          where m2.group_id = gid
            and m2.user_id <> my_id
          order by m2.created_at asc, m2.id asc
          limit 1
       )
     where id = gid and creator_id = my_id;
    delete from public.memberships
     where group_id = gid and user_id = my_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.leave_group() from public;
grant execute on function public.leave_group() to authenticated;
drop function if exists public.unpair();

-- Authenticated ONLY: permanently delete the CURRENT user's account + data
-- (App Store Guideline 5.1.1(v) — in-app account deletion, real mode).
-- Runs with the caller's own JWT: auth.uid() IS the subject and there is no
-- argument, so a user can only ever delete themselves. SECURITY DEFINER so the
-- function can row-delete auth.users + storage.objects for that uid.
--
-- Group handling (pair groups AND any future squad groups) follows the same
-- invariant as leave_group: a shared group exists iff it has >= 2 members.
--   * If the deleting user is the LAST or SECOND-LAST member (deleting would
--     leave <= 1 member) → delete the whole group so no 1-member ghost
--     singleton survives (only their own data is in it; a survivor returns
--     to pure solo, exactly as leave_group dissolves a 2-member pair).
--   * Otherwise (>= 2 members would remain) → KEEP the group: if the deleting
--     user was the creator, reassign creator_id to the oldest remaining
--     member FIRST (groups.creator_id references public.users ON DELETE
--     CASCADE — leaving it would nuke the group + the partner's membership row
--     when auth.users disappears), then remove only the deleting user's own
--     membership row. Other users' rows are never touched.
--
-- Photo files: the CLIENT erases the actual bytes first via the Storage API
-- (storage.remove() under ${auth.uid()}/ — the only path that truly deletes
-- files; direct SQL row deletion is blocked by the storage.protect_delete()
-- trigger and would orphan the underlying file even with the flag — see the
-- "NEVER relax the policies" note above). This RPC then sweeps any remaining
-- storage.objects metadata rows under the user's prefix as final cleanup
-- (storage.allow_delete_query is the same session flag the Storage API sets
-- for its own deletes). Supabase cascade rules remove the rest: deleting the
-- auth.users row cascades to public.users and, through it, to our workouts,
-- invites and memberships; Supabase's own auth schema cascades clean up our
-- identities/sessions/refresh tokens.
create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  my_id uuid := auth.uid();
  g record;
  members_left int;
begin
  if my_id is null then
    raise exception 'auth required';
  end if;

  -- Sweep leftover storage metadata rows under our own prefix (the client
  -- already removed the underlying files via the Storage API, see above).
  -- storage.allow_delete_query is the same session flag the Storage API sets
  -- for its own deletes (storage.protect_delete() rejects direct deletes
  -- without it). Modern Supabase storage dropped the prefixes table entirely
  -- (folders are derived from objects at read time); touch it only if the
  -- project still has it (older storage versions).
  set local storage.allow_delete_query = 'true';
  delete from storage.objects
   where bucket_id = 'workouts'
     and starts_with(name, my_id::text || '/');
  if to_regclass('storage.prefixes') is not null then
    delete from storage.prefixes
     where bucket_id = 'workouts' and name = my_id::text || '/';
  end if;

  -- Keep partner groups alive unless we are their last OR second-last member
  -- (deleting would leave <= 1 member → a ghost singleton, violating the
  -- "shared group exists iff >= 2 members" invariant that leave_group already
  -- enforces). Iterate the groups we are a member of OR creator of (a creator
  -- who already left the membership must still hand the group over — otherwise
  -- the auth.users cascade would delete it out from under the remaining members).
  for g in
    select distinct group_id from (
      select m.group_id from public.memberships m where m.user_id = my_id
      union
      select id as group_id from public.groups gr where gr.creator_id = my_id
    ) mine
  loop
    select count(*) into members_left
      from public.memberships m
     where m.group_id = g.group_id;

    if members_left <= 2 then
      -- We are the last or second-last member: deleting leaves <= 1 member, so
      -- the group would become a ghost singleton — drop it (same dissolve
      -- threshold as leave_group; a survivor returns to pure solo).
      delete from public.groups where id = g.group_id;
    else
      -- The group outlives us: if we created it, hand it to the oldest
      -- remaining member so the auth.users cascade does not delete it.
      update public.groups
         set creator_id = (
           select m2.user_id
             from public.memberships m2
            where m2.group_id = g.group_id
              and m2.user_id <> my_id
            order by m2.created_at asc, m2.id asc
            limit 1
         )
       where id = g.group_id and creator_id = my_id;
      -- Remove only our own seat; remaining members keep theirs.
      delete from public.memberships
       where group_id = g.group_id and user_id = my_id;
    end if;
  end loop;

  -- Delete the auth user LAST: the FK cascade removes our public.users row,
  -- our workouts rows, our invites and any leftover memberships.
  delete from auth.users where id = my_id;
end;
$$;

revoke all on function public.delete_account() from public;
grant execute on function public.delete_account() to authenticated;
-- ---------------------------------------------------------------------------