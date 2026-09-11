/**
 * Week recap card (v1.1 Build #4) — ONE card at week rollover.
 *
 * "You: 3 of 3 — Week complete / Alex: 2 of 3" style: personal results only,
 * NO history tab, no browsing, no past-weeks list. Tone is warm/celebrating
 * effort, never shaming — a missed week reads plain ("You: 1 of 3") with one
 * gentle forward line ("New week, fresh ring."), and the partner's count is
 * stated plainly with no commentary. No streak language, no comparison.
 *
 * READ-ONLY: this module NEVER writes snapshots — finalize stays in Build #1's
 * path (weeklyResults.ts, finalize-on-fetch). Reads:
 *  - DEV: devMock listResults (same UNIQUE shape) + listWorkouts fallback.
 *  - REAL: weekly_results via own-row select (own) + the pair-scoped
 *    `weekly_results_select_pair` policy (partner — read-only mirror of
 *    workouts_select_pair, same 2-member shape); computed fallbacks count that
 *    user's workouts rows in the elapsed range (partner rows visible through
 *    workouts_select_pair, own rows through workouts_select_own).
 *
 * "No data" rule (when null is returned): the previous week is not fully
 * elapsed yet, there is no session, OR the week left zero recorded evidence —
 * no snapshot for either side AND zero counted logs for both. A brand-new user
 * (or a quiet week with no logs and no finalize yet) therefore gets no card,
 * never a crash and never a confusing "0 of 3" for a week they weren't here.
 * A finalized missed week (snapshot 0/goal, completed=false) IS evidence, so
 * the gentle missed-week card still shows.
 *
 * Dismissal persists per user+week in AsyncStorage — a new completed week has
 * a new week_start_at key, so the card re-arms automatically.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { devMock, DEV_PAIR_GROUP_ID, type WorkoutRow } from './mock';
import { getStoredSession, supabase } from './supabase';
import { previousWeekRange, countInRange } from './weeklyResults';
import type { RecapSide, WeekRecap } from './workouts';

export type { RecapSide, WeekRecap };

/** Per-user+week dismissal flag (local-only, mirrors the naming.ts pattern). */
const DISMISS_PREFIX = 'spotter.recap:dismissed:v1:';

/** Gentle forward line shown ONLY when the own week was missed. */
export const RECAP_FORWARD_LINE = 'New week, fresh ring.';

/** Headline: "Week of Aug 25" from the week's ISO start. */
export function recapHeadline(weekStartAt: string): string {
  const d = new Date(weekStartAt);
  if (Number.isNaN(d.getTime())) return 'Last week';
  return `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/**
 * Own result line, exactly the plan's shape: completed →
 * "You: 3 of 3 — Week complete 🎉", else plain "You: 1 of 3".
 */
export function recapOwnLine(own: RecapSide): string {
  return own.completed
    ? `You: ${own.count} of ${own.goal} — Week complete 🎉`
    : `You: ${own.count} of ${own.goal}`;
}

/** Partner result line, plain counts only: "Alex: 2 of 3". */
export function recapPartnerLine(name: string, side: RecapSide): string {
  return `${name}: ${side.count} of ${side.goal}`;
}

function clampGoal(g: unknown): number {
  return Math.min(7, Math.max(1, Math.round(typeof g === 'number' ? g : 3) || 3));
}

function sideFromSnapshot(count: number, goal: number): RecapSide {
  const g = clampGoal(goal);
  return { count: Math.max(0, count), goal: g, completed: count >= g };
}

/**
 * The most recently FULLY-elapsed week's recap for the current user, or null
 * when the week isn't fully elapsed yet or there is no data (see header).
 * Never throws — Home must never break over a summary card.
 */
export async function getRecapForLastCompletedWeek(now: Date = new Date()): Promise<WeekRecap | null> {
  try {
    const session = await getStoredSession();
    if (!session) return null;
    if (session.isDevMode || !supabase) return getRecapDev(session.user.id, now);
    return getRecapReal(session.user.id, now);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DEV MOCK
// ---------------------------------------------------------------------------

async function getRecapDev(userId: string, now: Date): Promise<WeekRecap | null> {
  const profile = await devMock.getProfile(userId).catch(() => null);
  const weekStartDay = profile?.week_start_day ?? 'Mon';
  const goal = clampGoal(profile?.weekly_goal ?? 3);

  const range = previousWeekRange(now, weekStartDay);
  if (!range || now < range.end) return null;
  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();

  // Own side: snapshot preferred (finalized = authoritative), else count the
  // user's logs in the elapsed range — the same computation the ring uses.
  const results = await devMock.listResults(userId).catch(() => []);
  const ownSnap = results.find((r) => r.group_id === DEV_PAIR_GROUP_ID && r.week_start_at === startIso);
  let own: RecapSide;
  let ownEvidence = false;
  if (ownSnap) {
    own = sideFromSnapshot(ownSnap.workout_count, ownSnap.weekly_goal_snapshot);
    ownEvidence = true;
  } else {
    const rows = await devMock.listWorkouts(userId).catch(() => [] as WorkoutRow[]);
    const count = countInRange(rows, range.start, range.end);
    own = { count, goal, completed: count >= goal };
    ownEvidence = count > 0;
  }

  // Partner side: the partner's snapshot for the same week (their OWN
  // week-start day drives their range when known — same convention as the
  // MissCard miss check), else their computed counts. Null when solo.
  const pair = await devMock.getPairState(userId).catch(() => ({ partner: null as null, accepted: false }));
  let partner: RecapSide | null = null;
  let partnerId: string | null = null;
  let partnerFirstName: string | null = null;
  let partnerEvidence = false;
  if (pair.partner) {
    partnerId = pair.partner.id;
    partnerFirstName = (pair.partner.name ?? 'Partner').split(' ')[0] || 'Partner';
    const pProfile = await devMock.getProfile(partnerId).catch(() => null);
    const pDay = pProfile?.week_start_day ?? weekStartDay;
    const pGoal = clampGoal(pProfile?.weekly_goal ?? 3);
    const pRange = previousWeekRange(now, pDay);
    if (pRange && now >= pRange.end) {
      const pStartIso = pRange.start.toISOString();
      const pResults = await devMock.listResults(partnerId).catch(() => []);
      const pSnap = pResults.find((r) => r.group_id === DEV_PAIR_GROUP_ID && r.week_start_at === pStartIso);
      if (pSnap) {
        partner = sideFromSnapshot(pSnap.workout_count, pSnap.weekly_goal_snapshot);
        partnerEvidence = true;
      } else {
        const pRows = await devMock.listWorkouts(partnerId).catch(() => [] as WorkoutRow[]);
        const count = countInRange(pRows, pRange.start, pRange.end);
        partner = { count, goal: pGoal, completed: count >= pGoal };
        partnerEvidence = count > 0;
      }
    } else {
      partner = { count: 0, goal: pGoal, completed: false };
    }
  }

  if (!ownEvidence && !partnerEvidence) return null;
  return { weekStartAt: startIso, weekEndAt: endIso, own, partner, partnerId, partnerFirstName };
}

// ---------------------------------------------------------------------------
// REAL (Supabase)
// ---------------------------------------------------------------------------

/** The other seat of the caller's 2-member pair group (null when solo). */
async function findPartner(userId: string): Promise<{ partnerId: string; pairGroupId: string } | null> {
  if (!supabase) return null;
  const { data: myMemberships } = await supabase.from('memberships').select('group_id').eq('user_id', userId);
  const myGroupIds = (myMemberships ?? []).map((m) => m.group_id);
  if (myGroupIds.length === 0) return null;
  const { data: groupMems } = await supabase
    .from('memberships')
    .select('group_id, user_id')
    .in('group_id', myGroupIds);
  const byGroup = new Map<string, string[]>();
  for (const m of groupMems ?? []) {
    const list = byGroup.get(m.group_id) ?? [];
    list.push(m.user_id);
    byGroup.set(m.group_id, list);
  }
  for (const [groupId, userIds] of byGroup.entries()) {
    if (userIds.length !== 2) continue;
    const other = userIds.find((u) => u !== userId);
    if (other) return { partnerId: other, pairGroupId: groupId };
  }
  return null;
}

async function getRecapReal(userId: string, now: Date): Promise<WeekRecap | null> {
  if (!supabase) return null;

  const { data: settings } = await supabase
    .from('memberships')
    .select('weekly_goal')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const goal = clampGoal(settings?.weekly_goal ?? 3);
  const { data: userRow } = await supabase.from('users').select('week_start_day').eq('id', userId).maybeSingle();
  const weekStartDay = userRow?.week_start_day ?? 'Mon';

  const range = previousWeekRange(now, weekStartDay);
  if (!range || now < range.end) return null;
  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();

  // Own side: snapshot preferred, else count own logs in the elapsed range.
  const { data: ownSnaps } = await supabase
    .from('weekly_results')
    .select('workout_count, weekly_goal_snapshot')
    .eq('user_id', userId)
    .eq('week_start_at', startIso)
    .limit(1);
  let own: RecapSide;
  let ownEvidence = false;
  const ownSnap = (ownSnaps ?? [])[0];
  if (ownSnap) {
    own = sideFromSnapshot(ownSnap.workout_count, ownSnap.weekly_goal_snapshot);
    ownEvidence = true;
  } else {
    const { data: rows, error } = await supabase
      .from('workouts')
      .select('id')
      .eq('user_id', userId)
      .gte('logged_at', startIso)
      .lt('logged_at', endIso);
    if (error) return null;
    const count = (rows ?? []).length;
    own = { count, goal, completed: count >= goal };
    ownEvidence = count > 0;
  }

  // Partner side: snapshot for the same week via the pair-scoped read policy,
  // else their computed counts. Null when solo. The partner's week-start day
  // and goal come from the pair-scoped memberships read — NEVER from users
  // (users_select_own is strictly own-row; the partner's users row, including
  // their name, is NOT readable). The shared range is driven by the caller's
  // own day, matching both sides whenever both use the default (the same
  // convention documented in workoutStore.ts for the MissCard).
  const found = await findPartner(userId);
  let partner: RecapSide | null = null;
  let partnerId: string | null = null;
  let partnerFirstName: string | null = null;
  let partnerEvidence = false;
  if (found) {
    partnerId = found.partnerId;
    partnerFirstName = 'Partner'; // UI prefers the local pet-name display name.
    const { data: partnerSettings } = await supabase
      .from('memberships')
      .select('weekly_goal')
      .eq('user_id', partnerId)
      .eq('group_id', found.pairGroupId)
      .maybeSingle();
    const pGoal = clampGoal(partnerSettings?.weekly_goal ?? 3);
    const { data: pSnaps } = await supabase
      .from('weekly_results')
      .select('workout_count, weekly_goal_snapshot')
      .eq('user_id', partnerId)
      .eq('group_id', found.pairGroupId)
      .eq('week_start_at', startIso)
      .limit(1);
    const pSnap = (pSnaps ?? [])[0];
    if (pSnap) {
      partner = sideFromSnapshot(pSnap.workout_count, pSnap.weekly_goal_snapshot);
      partnerEvidence = true;
    } else {
      const { data: pRows, error: pError } = await supabase
        .from('workouts')
        .select('id')
        .eq('user_id', partnerId)
        .gte('logged_at', startIso)
        .lt('logged_at', endIso);
      if (pError) return null;
      const count = (pRows ?? []).length;
      partner = { count, goal: pGoal, completed: count >= pGoal };
      partnerEvidence = count > 0;
    }
  }

  if (!ownEvidence && !partnerEvidence) return null;
  return { weekStartAt: startIso, weekEndAt: endIso, own, partner, partnerId, partnerFirstName };
}

// ---------------------------------------------------------------------------
// Dismissal (once per completed week; a new week re-arms automatically)
// ---------------------------------------------------------------------------

/** True when the current user already dismissed this week's recap. */
export async function isRecapDismissed(weekStartAt: string): Promise<boolean> {
  const session = await getStoredSession().catch(() => null);
  if (!session) return true;
  try {
    return (await AsyncStorage.getItem(`${DISMISS_PREFIX}${session.user.id}:${weekStartAt}`)) === '1';
  } catch {
    return true; // Storage failure → fail silent, never nag.
  }
}

/** Dismiss this week's recap for the current user (best-effort local flag). */
export async function dismissRecap(weekStartAt: string): Promise<void> {
  try {
    const session = await getStoredSession().catch(() => null);
    if (session) await AsyncStorage.setItem(`${DISMISS_PREFIX}${session.user.id}:${weekStartAt}`, '1');
  } catch {
    // Best-effort local flag; the card is optional either way.
  }
}

/**
 * The recap to SHOW (null when none exists or this week's was dismissed).
 * Home renders this — one muted card, once per completed week.
 */
export async function getVisibleRecap(now: Date = new Date()): Promise<WeekRecap | null> {
  const recap = await getRecapForLastCompletedWeek(now);
  if (!recap) return null;
  return (await isRecapDismissed(recap.weekStartAt)) ? null : recap;
}
