/**
 * Missed-week → Promises ledger rollover (v1.0 fix, 2026-09-23).
 *
 * THE GAP THIS CLOSES: `record_missed_promise` (schema.sql) and its client
 * wrapper (`promises.ts` → `recordMissedPromise`) existed and were documented as
 * "client calls at week rollover when the maker missed", but NO production
 * caller existed — so the Treats/Promises ledger stayed empty forever and the
 * populated Open / Kept / Let-it-go ledger the listing promises was unreachable.
 * This module is that caller, wired into the ONE genuine rollover point
 * (`fetchWeeklyContext` in workoutStore.ts, immediately after the existing
 * finalize-on-fetch snapshot — see `weeklyResults.ts`).
 *
 * WHY THIS POINT: `fetchWeeklyContext` is where the app already resolves "the
 * previous FULLY-elapsed week" for every user (finalize-on-fetch, the recap
 * card, the own-miss line). Recording the promise anywhere else would either
 * miss weeks (a screen nobody opens) or fire on a read-only summary path
 * (weekRecap.ts is read-only BY CONTRACT and stays that way).
 *
 * EXACTLY ONCE PER WEEK (the owner's requirement): a completed week is
 * processed at most once per device, because the user may reopen the app many
 * times after a week ends.
 *  1. A local per-user+week flag (`spotter.promiserollover:v1:<uid>:<weekISO>`)
 *     is written after a DEFINITIVE server answer (ok:true — created either
 *     way). Later opens then short-circuit without touching the network, so the
 *     RPC is never hammered.
 *  2. The server is the real guarantee: the RPC is idempotent
 *     (UNIQUE (membership_id, week_start)), so even a lost flag (fresh install,
 *     second device, two concurrent fetches) can never produce a second entry.
 *  3. A response we do NOT get (offline, transient read failure) leaves the flag
 *     unwritten, so the NEXT app open retries. That is the only retry path: one
 *     attempt per app open, never a loop.
 * Consequence, stated plainly: once a week has been processed with a definitive
 * answer, a note set AFTER that week's rollover does not retrofit an entry for
 * it — the ledger records the promise that was in place when the week ended.
 *
 * SEMANTICS THIS RESPECTS (nothing here re-implements policy):
 *  - The RPC owns the note/witness rules: no note set → no-op
 *    (`{ok:true, created:false}`, never shaming); the witness must be a CURRENT
 *    co-member ≠ self (re-validated inside the SECURITY DEFINER function).
 *    This module never inserts, never widens RLS and never reads another user's
 *    promise: the ledger stays pair-private (maker + the one snapshotted
 *    witness), at any group size.
 *  - "Missed" uses the app's existing definition for a completed week: the
 *    finalize-on-fetch snapshot when it exists (authoritative), else the same
 *    counted own logs < goal comparison the weekly ring uses. A week whose
 *    reads could not be resolved is left UNTOUCHED (no entry, no flag) rather
 *    than guessed at.
 *  - A completed week is only a MISS for someone who was actually there for it
 *    (added 2026-09-23, below). `record_missed_promise` (schema.sql) checks the
 *    caller's voice (a note), their group and their witness — it never compares
 *    the week to when the caller JOINED. Without this guard a brand-new member
 *    is handed the week before they installed the app as an Open miss their
 *    partner can see: a false entry that shames someone for a week they never
 *    had. Stated plainly, this is a CLIENT-side skip and not a schema change:
 *    the launch window keeps supabase/schema.sql frozen, and the shipped build
 *    has to be honest even if the database is never touched.
 *
 * NOTE ON THE IMPORT CYCLE: promises.ts already imports workoutStore (for the
 * ledger's member-name map), so wiring this into workoutStore makes
 * promises ⇄ workoutStore a cycle however it is arranged. It is safe because
 * every cross-module reference is used INSIDE a function body, never at module
 * evaluation time (verified by the rollover guard, which loads the modules in
 * the app's own order and drives the real fetchWeeklyContext).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { devMock } from './mock';
import { recordMissedPromise } from './promises';
import { getStoredSession, supabase } from './supabase';
import { countInRange, previousWeekRange } from './weeklyResults';

/** Per-user + per-week once-flag (local-only, mirrors the recap/once patterns). */
const ROLLOVER_PREFIX = 'spotter.promiserollover:v1:';

export type RolloverReason =
  | 'recorded' // the RPC ran and answered
  | 'not_recorded' // the RPC ran and answered, but made no entry (no note / already there)
  | 'no_session'
  | 'no_completed_week' // previous week not fully elapsed (defensive; see below)
  | 'goal_met' // the completed week MET the goal — nothing to record
  | 'already_processed' // this week was recorded on an earlier open (local flag)
  | 'before_membership' // the week STARTED before this member joined the group — not their miss
  | 'no_shared_group' // nobody to record against (the RPC would no-op) — nothing to do
  | 'unavailable'; // reads failed — retry on the next open, never guess

export interface RolloverOutcome {
  /** True only when the RPC was actually invoked this call. */
  ran: boolean;
  /** True only when the RPC created a NEW ledger entry. */
  created: boolean;
  weekStartAt?: string;
  reason: RolloverReason;
  error?: string;
}

/** Local once-flag key for one user + one completed week. Exported for the smoke
 * guard (which clears it to prove the server-side idempotency layer). */
export function promiseRolloverKey(userId: string, weekStartAt: string): string {
  return `${ROLLOVER_PREFIX}${userId}:${weekStartAt}`;
}

/** Has this user's completed week already been processed on this device? A
 * storage failure reads as "not processed" (we would rather retry a cheap,
 * idempotent call than silently never record the promise). */
export async function isPromiseRolloverProcessed(userId: string, weekStartAt: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(promiseRolloverKey(userId, weekStartAt))) === '1';
  } catch {
    return false;
  }
}

/** Mark (or clear, for tests) this user's completed week as processed. */
export async function markPromiseRolloverProcessed(userId: string, weekStartAt: string): Promise<void> {
  try {
    await AsyncStorage.setItem(promiseRolloverKey(userId, weekStartAt), '1');
  } catch {
    // Best-effort local flag: without it the next open simply asks again, and
    // the RPC is idempotent — never a duplicate entry.
  }
}

export async function clearPromiseRolloverFlag(userId: string, weekStartAt: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(promiseRolloverKey(userId, weekStartAt));
  } catch {
    // Best-effort (test hook).
  }
}

/** Did the maker MISS the completed week [start, end)? Snapshot first (the
 * finalize-on-fetch row is authoritative), else the ring's own-log count.
 * 'unresolved' = a read failed → caller records nothing and retries later. */
async function ownCompletedWeekMissed(
  userId: string,
  useDevLocal: boolean,
  start: Date,
  end: Date,
  goal: number,
): Promise<'missed' | 'met' | 'unresolved'> {
  const startIso = start.toISOString();
  if (useDevLocal || !supabase) {
    try {
      const results = await devMock.listResults(userId);
      const snap = results.find((r) => r.week_start_at === startIso);
      if (snap) return snap.completed ? 'met' : 'missed';
      const count = countInRange(await devMock.listWorkouts(userId), start, end);
      return count < goal ? 'missed' : 'met';
    } catch {
      return 'unresolved';
    }
  }

  // REAL: the previous week's snapshot (any group of mine — the count/completed
  // pair is computed from my own logs + goal either way), else a ranged count.
  // (No `.maybeSingle()`: a user can hold a snapshot for more than one group.)
  const { data: snaps, error: snapError } = await supabase
    .from('weekly_results')
    .select('completed')
    .eq('user_id', userId)
    .eq('week_start_at', startIso)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!snapError) {
    const snap = (snaps ?? [])[0];
    if (snap) return snap.completed ? 'met' : 'missed';
  }
  const { data: rows, error: rowsError } = await supabase
    .from('workouts')
    .select('id')
    .eq('user_id', userId)
    .gte('logged_at', startIso)
    .lt('logged_at', end.toISOString());
  if (rowsError) return 'unresolved';
  return (rows ?? []).length < goal ? 'missed' : 'met';
}

/**
 * When did this user join the group the rollover would record against?
 * Returns an ISO timestamp, `null` when they hold no shared group at all (the
 * RPC would no-op, so there is nothing to record), or `'unavailable'` when it
 * cannot be established — the caller then records NOTHING rather than risk a
 * false miss (a possible false miss is worse than a delayed true one).
 *
 * The membership read follows the RPC's own rule (`record_missed_promise`
 * resolves the caller's most recent membership in a group with >= 2 members),
 * via `my_group()` — the same SECURITY DEFINER helper Home already uses. The
 * client can read ONLY its own membership row (`memberships_select_own`), which
 * is exactly the row in question; no other member's row is touched, and the
 * pair-private read path is untouched.
 */
async function myMembershipJoinedAt(userId: string, useDevLocal: boolean): Promise<string | null | 'unavailable'> {
  try {
    if (useDevLocal || !supabase) {
      const shared = await devMock.findSharedDevGroup(userId); // dev mirror of my_group()
      if (!shared) return null;
      const mine = shared.members.find((m) => m.user_id === userId);
      return typeof mine?.created_at === 'string' ? mine.created_at : 'unavailable';
    }
    const { data: groupData, error: groupError } = await supabase.rpc('my_group');
    if (groupError) return 'unavailable';
    const groupId = (groupData as { group_id?: unknown } | null)?.group_id;
    if (typeof groupId !== 'string' || groupId.length === 0) return null;
    const { data: mine, error: memberError } = await supabase
      .from('memberships')
      .select('created_at')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .maybeSingle();
    if (memberError) return 'unavailable';
    return typeof mine?.created_at === 'string' ? mine.created_at : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Record the previous fully-elapsed week as a promise entry when the maker
 * missed it and a promise is set. Safe to call on every weekly-context fetch:
 * it is idempotent per user+week per device, and it never records for a week
 * that met the goal or was already processed.
 *
 * @param now injectable clock (the guard time-travels; production passes new Date()).
 * @param weekStartDay the user's week-start label (already resolved by the caller).
 * @param weeklyGoal the user's CURRENT goal — the same value the ring and the
 *   finalize-on-fetch snapshot use (see weeklyResults.ts header).
 */
export async function recordMissedPromiseForCompletedWeek(
  now: Date,
  weekStartDay: string,
  weeklyGoal: number,
): Promise<RolloverOutcome> {
  const session = await getStoredSession();
  if (!session) return { ran: false, created: false, reason: 'no_session' };
  const useDevLocal = session.isDevMode || !supabase;

  const range = previousWeekRange(now, weekStartDay);
  if (!range || now < range.end) return { ran: false, created: false, reason: 'no_completed_week' };
  const weekStartAt = range.start.toISOString();

  const goal = Math.min(7, Math.max(1, Math.round(weeklyGoal) || 3));
  const missed = await ownCompletedWeekMissed(session.user.id, useDevLocal, range.start, range.end, goal);
  if (missed === 'met') return { ran: false, created: false, weekStartAt, reason: 'goal_met' };
  if (missed === 'unresolved') return { ran: false, created: false, weekStartAt, reason: 'unavailable' };

  if (await isPromiseRolloverProcessed(session.user.id, weekStartAt)) {
    return { ran: false, created: false, weekStartAt, reason: 'already_processed' };
  }

  // Presence: a completed week that STARTED before this member joined the group
  // is not a miss. Mid-week joiners are skipped for that week too — they never
  // had the full week to hit the goal. On an unknown join time we record
  // nothing and retry on the next open (no flag written), because a false miss
  // is worse than a late one.
  const joinedAt = await myMembershipJoinedAt(session.user.id, useDevLocal);
  if (joinedAt === 'unavailable') return { ran: false, created: false, weekStartAt, reason: 'unavailable' };
  if (joinedAt === null) return { ran: false, created: false, weekStartAt, reason: 'no_shared_group' };
  const joinedMs = new Date(joinedAt).getTime();
  const weekStartMs = range.start.getTime();
  if (Number.isNaN(joinedMs)) return { ran: false, created: false, weekStartAt, reason: 'unavailable' };
  if (weekStartMs < joinedMs) return { ran: false, created: false, weekStartAt, reason: 'before_membership' };

  const res = await recordMissedPromise(weekStartAt);
  if (res.ok) {
    await markPromiseRolloverProcessed(session.user.id, weekStartAt);
    return { ran: true, created: res.created, weekStartAt, reason: res.created ? 'recorded' : 'not_recorded' };
  }
  // No definitive answer: leave the flag unwritten so the next app open retries.
  return { ran: true, created: false, weekStartAt, reason: 'unavailable', error: res.error };
}

/**
 * Best-effort rollover hook for the weekly-context fetch: a ledger entry is a
 * whisper, never a reason for Home to fail. Never throws.
 */
export async function maybeRecordMissedPromise(
  now: Date,
  weekStartDay: string,
  weeklyGoal: number,
): Promise<void> {
  try {
    await recordMissedPromiseForCompletedWeek(now, weekStartDay, weeklyGoal);
  } catch {
    // Swallowed: the ledger entry retries on the next open (no flag written).
  }
}
