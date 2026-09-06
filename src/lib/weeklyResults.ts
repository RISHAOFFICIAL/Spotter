/**
 * V1.1 MEASUREMENT FOUNDATION (Build #1) — weekly result snapshots.
 *
 * When a week FULLY elapses, finalize one immutable row per (user, group,
 * week) into public.weekly_results so retention/completion funnels are computed
 * from data, not instinct. Called from fetchWeeklyContext (workoutStore.ts) —
 * finalize-on-fetch keeps it serverless: no cron, no background job.
 *
 * SNAPSHOT APPROACH (honest limitation, per the brief): weekly_goal_snapshot
 * is the goal AT FINALIZE TIME (the user's current membership goal), NOT the
 * historical goal that was active during that week. Rationale: MVP has no
 * membership-history table (goal edits overwrite the row), so true historical
 * accuracy would need a goal-change log that is out of scope for v1.1 Build #1.
 * Documented consequence: if a user changes their goal mid-week, the snapshot
 * records the NEW goal against the OLD week's workouts. Acceptable for v1.1
 * (goals rarely change; direction of error is known); revisit with a
 * goal-history table if goal edits become frequent.
 *
 * DEV MOCK: snapshots live in AsyncStorage (`results:<userId>`) through
 * devMock list/save helpers, same UNIQUE shape (user, group, week_start).
 */
import { devMock, DEV_PAIR_GROUP_ID, type WorkoutRow } from './mock';
import { getStoredSession, supabase } from './supabase';
import { weekStartFor } from './workouts';

export interface WeeklyResult {
  user_id: string;
  group_id: string;
  week_start_at: string;
  week_end_at: string;
  weekly_goal_snapshot: number;
  workout_count: number;
  completed: boolean;
  nudge_present: boolean;
}

export interface FinalizeResult {
  ok: boolean;
  /** True when a NEW snapshot row was written this call. */
  finalized: boolean;
  result?: WeeklyResult;
  error?: string;
}

const DAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Previous fully-elapsed week [start, end) for a week_start_day, or null when
 * the current week is still the user's first (no complete prior week exists). */
export function previousWeekRange(now: Date, weekStartDay: string): { start: Date; end: Date } | null {
  const day = DAY_INDEX[weekStartDay] ?? 1;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const current = (d.getDay() + 6) % 7;
  const target = (day + 6) % 7;
  let delta = current - target;
  if (delta < 0) delta += 7;
  d.setDate(d.getDate() - delta);
  const thisStart = d;
  // A previous complete week exists only if at least one full week has elapsed
  // since the epoch of tracking — always true in practice (weeks are calendar
  // facts, not account facts): previous = [thisStart - 7d, thisStart).
  const end = new Date(thisStart);
  const start = new Date(thisStart);
  start.setDate(start.getDate() - 7);
  return { start, end };
}

export function countInRange(rows: WorkoutRow[], start: Date, end: Date): number {
  let n = 0;
  for (const r of rows) {
    const t = new Date(r.logged_at);
    if (!Number.isNaN(t.getTime()) && t >= start && t < end) n += 1;
  }
  return n;
}

/**
 * Finalize the previous fully-elapsed week for the CURRENT user (idempotent:
 * UNIQUE(user_id, group_id, week_start_at) + pre-check — a second call for an
 * already-finalized week returns finalized:false).
 *
 * @param now injectable clock (smoke test time-travels past week end).
 * @param weekStartDay the user's week-start label (from the weekly context).
 * @param weeklyGoal the user's CURRENT goal = snapshot value (see header).
 * @param groupId the group this snapshot belongs to (pair group when paired,
 *   else the user's personal scope — dev mock uses DEV_PAIR_GROUP_ID).
 */
export async function finalizePreviousWeek(
  now: Date,
  weekStartDay: string,
  weeklyGoal: number,
  groupId: string | null,
): Promise<FinalizeResult> {
  const session = await getStoredSession();
  if (!session) return { ok: false, finalized: false, error: 'No session.' };
  const goal = Math.min(7, Math.max(1, Math.round(weeklyGoal) || 3));
  // No group to attribute the snapshot to: dev mock falls back to a
  // per-user 'personal' scope; REAL mode refuses (group_id is uuid NOT NULL —
  // a sentinel string would violate the FK shape, so skip and retry later).
  if (!groupId && supabase && !session.isDevMode) {
    return { ok: false, finalized: false, error: 'No group for snapshot.' };
  }
  const gid = groupId ?? 'personal';

  // Only finalize when the previous week is FULLY elapsed: now >= its end.
  const range = previousWeekRange(now, weekStartDay);
  if (!range) return { ok: false, finalized: false, error: 'No complete prior week.' };
  if (now < range.end) return { ok: false, finalized: false, error: 'Previous week not elapsed.' };

  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();

  if (session.isDevMode || !supabase) {
    const existing = await devMock.listResults(session.user.id);
    if (existing.some((r) => r.group_id === gid && r.week_start_at === startIso)) {
      return { ok: true, finalized: false };
    }
    const rows = await devMock.listWorkouts(session.user.id);
    const count = countInRange(rows, range.start, range.end);
    const result: WeeklyResult = {
      user_id: session.user.id,
      group_id: gid,
      week_start_at: startIso,
      week_end_at: endIso,
      weekly_goal_snapshot: goal,
      workout_count: count,
      completed: count >= goal,
      nudge_present: false,
    };
    await devMock.saveResult(session.user.id, result);
    return { ok: true, finalized: true, result };
  }

  // REAL: pre-check (idempotency without relying on error parsing), count via a
  // ranged select, upsert with onConflict on the UNIQUE triple.
  try {
    const { data: existing } = await supabase
      .from('weekly_results')
      .select('id')
      .eq('user_id', session.user.id)
      .eq('group_id', gid)
      .eq('week_start_at', startIso)
      .maybeSingle();
    if (existing) return { ok: true, finalized: false };

    const { data: rows, error: countError } = await supabase
      .from('workouts')
      .select('logged_at')
      .eq('user_id', session.user.id)
      .gte('logged_at', startIso)
      .lt('logged_at', endIso);
    if (countError) return { ok: false, finalized: false, error: countError.message };
    const count = (rows ?? []).length;

    const { error: upsertError } = await supabase.from('weekly_results').upsert(
      {
        user_id: session.user.id,
        group_id: gid,
        week_start_at: startIso,
        week_end_at: endIso,
        weekly_goal_snapshot: goal,
        workout_count: count,
        completed: count >= goal,
        nudge_present: false,
      },
      { onConflict: 'user_id,group_id,week_start_at' },
    );
    if (upsertError) return { ok: false, finalized: false, error: upsertError.message };
    return {
      ok: true,
      finalized: true,
      result: {
        user_id: session.user.id,
        group_id: gid,
        week_start_at: startIso,
        week_end_at: endIso,
        weekly_goal_snapshot: goal,
        workout_count: count,
        completed: count >= goal,
        nudge_present: false,
      },
    };
  } catch (e) {
    return { ok: false, finalized: false, error: e instanceof Error ? e.message : 'Could not finalize.' };
  }
}

/**
 * Best-effort hook called from fetchWeeklyContext: finalize the previous week
 * when it has elapsed. Never throws, never fails the context fetch (a missed
 * snapshot is a data gap, not a user-facing error — next fetch retries).
 */
export async function maybeFinalizePreviousWeek(
  now: Date,
  weekStartDay: string,
  weeklyGoal: number,
  groupId: string | null,
): Promise<void> {
  try {
    await finalizePreviousWeek(now, weekStartDay, weeklyGoal, groupId);
  } catch {
    // Swallowed: snapshots are observability, not the core loop.
  }
}
