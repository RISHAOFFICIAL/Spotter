-- SPOTTER — 2026-09-27 — first-open measurement: anon INSERT on analytics_events.
--
-- DEFECT (audit 2026-09-26): analytics_events had only `analytics_events_insert_own`
-- (`for insert to authenticated`), so RLS default-DENIED the pre-signup inserts the
-- app already makes. `app_opened` fires at AuthProvider mount (before any session is
-- restored) and the invite-screen `pair_action` verbs fire pre-auth — the FIRST-OPEN
-- event is rejected before signup, so the north-star metric's denominator
-- ("activated groups per 100 first opens") is uncomputable and there is no install
-- record to reconstruct it from. The client code was already correct
-- (src/lib/analytics.ts: user_id: null + anonymous_install_id); only the DB was wrong.
--
-- WHAT THIS POLICY PERMITS (exactly):
--   role `anon` (no session) may INSERT a row only when BOTH hold:
--     1. user_id IS NULL — an anonymous row cannot be attributed to any real user,
--        so it cannot pollute a per-user funnel or impersonate a member; and
--     2. event_name is one the client actually emits pre-auth:
--          app_opened
--          pair_action with action in (invite_created, share_tapped, code_copied)
--   Every other event family (signup_completed, workout_logged, invite_accepted,
--   unpaired, nudge_*, notification_*, recap_viewed) is still refused to anon, so
--   the north-star's activation inputs cannot be forged from an anonymous client.
--
-- WHAT IT DOES NOT PERMIT: SELECT, UPDATE or DELETE for anon (no such policy exists,
-- and this migration adds none) — reads stay service-role only. It does not widen
-- anything for `authenticated`; `analytics_events_insert_own` is untouched.
--
-- RESIDUAL RISK, STATED PLAINLY — NOT AIRTIGHT. The anon key ships in the client and
-- is extractable, so anyone holding it can spam rows under the two permitted names:
-- unbounded volume, arbitrary properties/group_id/source_id/occurred_at (including
-- backdated), any anonymous_install_id. A per-install throttle is not a real defence
-- because that id is attacker-controlled. This is the same posture the project
-- already accepts on app_diagnostics (`for insert to anon, authenticated with check
-- (true)`, 2026-09-19, because a crash can fire before sign-in) — and it is strictly
-- narrower than that precedent: this policy pins user_id IS NULL, the event name and
-- the pair-action verb. The table remains append-only and unreadable from the client,
-- so the damage of spam is bounded to noise in a dashboard, never a leak.
--
-- MAINTENANCE NOTE: the event-name/verb lists mirror today's pre-auth call sites. A
-- NEW event emitted before sign-in is refused silently (track() swallows the error),
-- so pairing a new pre-auth event with an edit here is required — the failure mode is
-- a missing row, not an error message.
--
-- Idempotent: drop-then-create, so re-running this file is safe. `to anon` is explicit
-- (never PUBLIC); no other table's policy is touched.
drop policy if exists "analytics_events_insert_anon_preauth" on public.analytics_events;
create policy "analytics_events_insert_anon_preauth" on public.analytics_events
  for insert to anon
  with check (
    user_id is null
    and (
      event_name = 'app_opened'
      or (
        event_name = 'pair_action'
        and action in ('invite_created', 'share_tapped', 'code_copied')
      )
    )
  );
