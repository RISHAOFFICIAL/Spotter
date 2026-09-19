-- SPOTTER — 2026-09-19 — post-leave photo isolation: pin the workout-photos storage
-- read policy to CURRENT group membership through a purpose-built predicate.
--
-- AUDIT (live production project juxddhghhkvtmxcwvlpa, read from pg_policy BEFORE this
-- migration; the workout-photos bucket is the private bucket `workouts`, public = false):
--
--   storage.objects :: workouts_storage_read_own    (SELECT, roles {PUBLIC})
--     using (bucket_id = 'workouts' AND auth.role() = 'authenticated'
--            AND starts_with(name, (auth.uid())::text || '/'))
--   storage.objects :: workouts_storage_read_group  (SELECT, roles {PUBLIC})
--     using (bucket_id = 'workouts' AND auth.role() = 'authenticated'
--            AND is_paired_with((split_part(name, '/', 1))::uuid))     <-- the only
--                                                                       membership-based
--                                                                       storage policy
--   storage.objects :: workouts_storage_insert_own  (INSERT, CHECK): own prefix only
--   storage.objects :: workouts_storage_update_own  (UPDATE/USING+CHECK): own prefix only
--   storage.objects :: workouts_storage_delete_own  (DELETE, USING): own prefix only
--
--   helper public.is_paired_with(p_other uuid)  (SECURITY DEFINER, STABLE, search_path=public)
--     select exists (select 1 from public.memberships mine
--                    join public.memberships theirs on theirs.group_id = mine.group_id
--                    where mine.user_id = auth.uid() and theirs.user_id = p_other
--                      and mine.user_id <> theirs.user_id
--                      and (select count(*) from public.memberships m
--                            where m.group_id = mine.group_id) >= 2)
--   -> requires a memberships row for BOTH sides in the SAME group, so a departed member
--      (leave_group/delete_account DELETE the seat) cannot match. Verified live: after C
--      leaves a 3-seat group, is_paired_with(C -> A) is false and storage.objects shows
--      0 objects under A's prefix to C.
--
-- WHAT THIS MIGRATION CHANGES (and why)
--   The photo policy is re-pinned to public.can_read_workout_photo(name) — an explicit,
--   purpose-built predicate that states the current-membership requirement in one place:
--     * the object's owner (the `${user_id}/` path prefix) must hold a CURRENT membership
--       row in a shared group (>= 2 seats), and
--     * the caller must hold a CURRENT membership row in that same group.
--   It is semantics-preserving for the app (same predicate as is_paired_with), and it
--   removes three latent risks: (1) the pair-era helper was written for a 2-member world
--   and was later relaxed from `count(*) = 2` to `>= 2`; (2) the helper is shared with the
--   pair feed policies (workouts/users/weekly_results), so a future pair-feature edit
--   could widen photo visibility without anyone noticing; (3) the inline
--   `split_part(name,'/',1)::uuid` cast raises inside policy evaluation for any object
--   whose prefix is not a uuid — the new predicate returns false for those (object stays
--   invisible) instead of erroring.
--   No write policy, bucket, table policy, or client behaviour changes.

create or replace function public.can_read_workout_photo(p_name text)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  owner_id uuid;
begin
  if auth.uid() is null then
    return false;
  end if;
  begin
    owner_id := split_part(p_name, '/', 1)::uuid;
  exception when others then
    return false;  -- not a `<user_id>/...` object key: no cross-user read
  end;
  return exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.group_id = mine.group_id
    where mine.user_id = auth.uid()
      and theirs.user_id = owner_id
      and mine.user_id <> theirs.user_id
      and (select count(*) from public.memberships m where m.group_id = mine.group_id) >= 2
  );
end
$fn$;

grant execute on function public.can_read_workout_photo(text) to anon, authenticated;

drop policy if exists "workouts_storage_read_group" on storage.objects;
create policy "workouts_storage_read_group" on storage.objects
  for select using (
    bucket_id = 'workouts'
    and auth.role() = 'authenticated'
    and public.can_read_workout_photo(name)
  );

revoke all on function public.can_read_workout_photo(text) from public;
grant execute on function public.can_read_workout_photo(text) to anon, authenticated;
