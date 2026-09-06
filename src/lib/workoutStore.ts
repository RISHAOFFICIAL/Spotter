/**
 * Workout store — the single place Home reads its weekly context from and the
 * only place workouts are written. Two backends behind one interface:
 *
 *  - REAL:   Supabase `workouts` table + private Storage bucket (per-user RLS).
 *  - DEV:    AsyncStorage via devMock (same `spotter.devmock:v1:` prefix,
 *            WorkoutRow shape mirrors the real table) + local photo files
 *            under a per-user cache folder — so the whole camera-tap → log
 *            flow verifiably works with no backend.
 *
 * Everything Home renders comes from ONE `fetchWeeklyContext` query
 * (home-screen.md §8): weeklyGoal + weekStartDay + logs + partner presence →
 * ring numeral, camera badge and feed all derive from it. No second fetch.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import { devMock, type WorkoutRow, type DevMembership, DEV_PAIR_GROUP_ID } from './mock';
import { track } from './analytics';
import { maybeFinalizePreviousWeek, previousWeekRange, countInRange } from './weeklyResults';
import { getPetName } from './naming';
import { getMissPromise, getPartnerMissPromise } from './missPromise';
import { getRecapForLastCompletedWeek, isRecapDismissed } from './weekRecap';
import { getStoredSession, supabase } from './supabase';
import { createSignedUrls } from './storage';
import { notifyPartnerLogged } from './pushDispatch';
import { WEEK_START_DAYS } from './settings';
import {
  weekStartFor,
  WORKOUT_BUCKET,
  type WorkoutLog,
  type WeeklyContext,
  type PartnerInfo,
  type WorkoutType,
  type DevPhoto,
} from './workouts';

/** Cache dir for dev-mode proof photos (one folder per dev user). */
export const DEVMOCK_PHOTOS_DIR = 'spotter-dev-mock-photos';

// ---------------------------------------------------------------------------
// IDs + dev photo files
// ---------------------------------------------------------------------------

export function newWorkoutId(): string {
  return Crypto.randomUUID();
}

/** Cache dir for dev-mode proof photos (one folder per dev user). */
function devPhotosDir(userId: string): Directory {
  return new Directory(Paths.cache, DEVMOCK_PHOTOS_DIR, userId);
}

async function ensureDevDir(userId: string): Promise<Directory> {
  const dir = devPhotosDir(userId);
  if (!dir.exists) dir.create(); // create() makes intermediates by default
  return dir;
}

/**
 * DEV MODE: persist a captured live-camera photo as a local file in a
 * per-user cache folder (mirrors the `${user_id}/` storage prefix so the
 * isolation shape is exercised even offline). Returns the stored photo.
 */
async function storeDevPhoto(
  userId: string,
  workoutId: string,
  sourceUri: string,
): Promise<DevPhoto> {
  const dir = await ensureDevDir(userId);
  const dest = dir.createFile(`${workoutId}.jpg`, 'image/jpeg');
  await new File(sourceUri).copy(dest, { overwrite: true });
  return {
    id: workoutId,
    userId,
    localUri: dest.uri,
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Row → display shape
// ---------------------------------------------------------------------------

function rowToLog(row: WorkoutRow, photoUri: string, authorName: string): WorkoutLog {
  return {
    id: row.id,
    userId: row.user_id,
    photoPath: row.photo_path, // ALWAYS the storage path / dev file — never a URL
    loggedAt: row.logged_at,
    workoutType: row.workout_type,
    authorName,
    photoUri,
  };
}

// ---------------------------------------------------------------------------
// Own-miss line (v1.1 Build #2, S slice)
// ---------------------------------------------------------------------------

/**
 * Does the CURRENT user have a miss promise whose previous week was missed, and
 * what is the promise text to show? Reads only the caller's OWN promise.
 */
async function computeOwnMissLine(userId: string): Promise<{ kind: 'ownMiss'; promise: string } | null> {
  try {
    const promise = await getMissPromise();
    const missed = await wasPreviousWeekMissed(userId);
    if (missed && promise) return { kind: 'ownMiss', promise };
  } catch {
    // Never fail the weekly context over a promise line — it's a whisper.
  }
  return null;
}

/**
 * Partner MissCard state (v1.1 Build #2, M slice): when the PARTNER missed
 * their previous fully-elapsed week AND their miss promise exists, Home
 * renders one muted card at the top of the feed — nothing else. Null when
 * either condition is false (or unpaired). No push, no badge, no shaming.
 *
 * Miss detection reuses the same snapshot-preferred, computed-fallback logic
 * as the own-miss line — but with the PARTNER's week-start day and the
 * PARTNER's goal, so the check reflects their week, not ours.
 */
async function computePartnerMissCard(
  partnerId: string | null,
  pairGroupId: string | null,
  partnerWeekStartDay: string | null,
  partnerGoal: number,
): Promise<{ kind: 'partnerMiss'; promise: string } | null> {
  if (!partnerId) return null;
  try {
    const promise = await getPartnerMissPromise(partnerId, pairGroupId);
    if (!promise) return null;
    const missed = await wasPreviousWeekMissedFor(partnerId, partnerWeekStartDay, partnerGoal);
    if (!missed) return null;
    return { kind: 'partnerMiss', promise };
  } catch {
    // Never fail the weekly context over a MissCard — it's a whisper.
  }
  return null;
}

/**
 * Whether a given user's PREVIOUS fully-elapsed week was missed. Reuses the
 * Build #1 weekly-results snapshot when one exists (the finalized row is the
 * source of truth after finalize-on-fetch); before/without a snapshot, falls
 * back to counting that user's workout logs inside the previous week range —
 * the same computation the ring uses, so it stays honest.
 *
 * @param userId whose week to check (self or partner).
 * @param weekStartDayOverride the user's week-start label when already known
 *   (partner path); falls back to that user's stored profile/row.
 * @param goalOverride the user's goal when already known (partner path);
 *   falls back to that user's stored profile/row.
 */
async function wasPreviousWeekMissedFor(
  userId: string,
  weekStartDayOverride?: string | null,
  goalOverride?: number,
): Promise<boolean> {
  const session = await getStoredSession();
  if (!session) return false;
  // The user's OWN stored week-start (profile in dev, users row in real) wins
  // unless the caller already resolved it for the partner path. Unlike the
  // original self-only helper, 'Mon' is only the last-resort default.
  const storedDay = session.isDevMode
    ? (await devMock.getProfile(userId))?.week_start_day
    : (await supabase!.from('users').select('week_start_day').eq('id', userId).maybeSingle()).data
        ?.week_start_day;
  const weekStartDay = weekStartDayOverride ?? storedDay ?? 'Mon';
  // Same for the goal: the caller's resolved partner goal wins; otherwise read
  // that user's own stored goal (dev profile / latest real membership row).
  const storedGoal = session.isDevMode
    ? (await devMock.getProfile(userId))?.weekly_goal
    : (
        await supabase!
          .from('memberships')
          .select('weekly_goal')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      ).data?.weekly_goal;
  const goal =
    typeof goalOverride === 'number' && goalOverride >= 1 && goalOverride <= 7
      ? goalOverride
      : (storedGoal && storedGoal >= 1 && storedGoal <= 7 ? storedGoal : 3);

  // Try the Build #1 snapshot first (finalized = authoritative).
  if (session.isDevMode || !supabase) {
    const results = await devMock.listResults(userId);
    const prev = previousWeekRange(new Date(), weekStartDay);
    const snap = prev
      ? results.find((r) => r.group_id === DEV_PAIR_GROUP_ID && r.week_start_at === prev.start.toISOString())
      : undefined;
    if (snap) return !snap.completed;
    // No snapshot: count logs in the previous week (ring-style fallback).
    const rows = await devMock.listWorkouts(userId);
    const count = prev ? countInRange(rows, prev.start, prev.end) : 0;
    return count < goal;
  }

  try {
    const { data: results } = await supabase
      .from('weekly_results')
      .select('completed')
      .eq('user_id', userId)
      .order('week_start_at', { ascending: false })
      .limit(1);
    const snap = (results ?? [])[0];
    if (snap) return !snap.completed;
    // No snapshot yet: count that user's logs in the previous week via ranged
    // select. (Partner rows are visible through workouts_select_pair; own rows
    // through workouts_select_own.)
    const prev = previousWeekRange(new Date(), weekStartDay);
    const { data: rows, error } = prev
      ? await supabase
          .from('workouts')
          .select('id')
          .eq('user_id', userId)
          .gte('logged_at', prev.start.toISOString())
          .lt('logged_at', prev.end.toISOString())
      : ({ data: null, error: null } as const);
    if (error) return false;
    return (rows ?? []).length < goal;
  } catch {
    return false;
  }
}

/**
 * Thin self-only wrapper kept for the own-miss line call site (no overrides).
 */
async function wasPreviousWeekMissed(userId: string): Promise<boolean> {
  return wasPreviousWeekMissedFor(userId);
}

/**
 * Week recap state (v1.1 Build #4): the most recent FULLY-elapsed week's
 * snapshot-preferred, computed-fallback counts for self (+ partner when
 * paired). Suppressed when this user+week was dismissed. Never fails the
 * weekly context — a summary card must never break Home.
 */
async function computeWeekRecap(): Promise<WeeklyContext['weekRecap']> {
  try {
    const recap = await getRecapForLastCompletedWeek(new Date());
    if (!recap) return null;
    if (await isRecapDismissed(recap.weekStartAt)) return null;
    return recap;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Weekly context (the single query — home-screen.md §8)
// ---------------------------------------------------------------------------

export interface WeeklyContextResult {
  ok: boolean;
  context?: WeeklyContext;
  error?: string;
}

/**
 * One fetch → the whole Home screen. REAL mode reads the `workouts` table
 * (RLS-scoped to auth.uid()) and pins signed URLs for this week's photos;
 * DEV mode reads devMock + local files through the same shape.
 */
export async function fetchWeeklyContext(): Promise<WeeklyContextResult> {
  const session = await getStoredSession();
  if (!session) return { ok: false, error: 'No session. Sign in to log.' };

  // Defaults match onboarding presets (goal 3, week starts Mon).
  let weeklyGoal = 3;
  let weekStartDay = 'Mon';
  let partner: PartnerInfo | null = null;
  const userName = session.user.email.split('@')[0] ?? 'You';

  if (session.isDevMode) {
    const profile = await devMock.getProfile(session.user.id);
    if (profile) {
      weeklyGoal = profile.weekly_goal;
      weekStartDay = profile.week_start_day;
    }
  } else if (supabase) {
    // A user has ONE membership per group, and after pairing they belong to
    // BOTH their solo "Personal" group AND the pair group — so this query can
    // return 2 rows. `.maybeSingle()` would then error (PGRST116) and, with the
    // error ignored below, silently reset the goal to the default. Take the
    // most recent membership instead: onboarding writes the personal group
    // first, accept_invite creates the pair membership later, so the latest
    // row always carries the user's current goal in MVP.
    const { data: settings } = await supabase
      .from('memberships')
      .select('weekly_goal')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (settings?.weekly_goal && settings.weekly_goal >= 1 && settings.weekly_goal <= 7) {
      weeklyGoal = settings.weekly_goal;
    }
    const { data: userRow } = await supabase
      .from('users')
      .select('week_start_day')
      .eq('id', session.user.id)
      .maybeSingle();
    if (userRow?.week_start_day) weekStartDay = userRow.week_start_day;
  }

  const now = new Date();
  const weekStart = weekStartFor(now, weekStartDay);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  if (session.isDevMode || !supabase) {
    // ---- DEV MOCK — same shape from async storage + local files (slice C:
    // two-user: own logs count for the ring; partner logs merge into the feed).
    const pair = await devMock.getPairState(session.user.id);
    partner = pair.partner
      ? {
          id: pair.partner.id,
          firstName: (pair.partner.name ?? 'Partner').split(' ')[0],
          hasLogs: (await devMock.listWorkouts(pair.partner.id)).length > 0,
        }
      : null;

    // V1.1: finalize the previous fully-elapsed week (best-effort snapshot;
    // never fails the context fetch). Dev pair scope = the shared pair group.
    await maybeFinalizePreviousWeek(new Date(), weekStartDay, weeklyGoal, DEV_PAIR_GROUP_ID);

    // Naming feature: pet name (local-only) + shared team name (dev pair group).
    const petName = await getPetName();
    const teamName = await devMock.getTeamName();
    const partnerDisplayName = partner ? (petName || partner.firstName) : null;

    const rows = await devMock.listWorkouts(session.user.id);
    const partnerRows = partner ? await devMock.listWorkouts(partner.id) : [];
    const allRows = [...rows, ...partnerRows];
    const inWeek = (r: WorkoutRow) => {
      const t = new Date(r.logged_at);
      return !Number.isNaN(t.getTime()) && t >= weekStart && t < weekEnd;
    };
    const logs = allRows
      .filter(inWeek)
      .map((r) =>
        rowToLog(
          r,
          r.photo_path, // DEV: photo_path is a local file URI — display directly
          r.user_id === session.user.id ? userName : (partnerDisplayName ?? 'Partner'),
        ),
      )
      .sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : -1));
    // M slice: partner MissCard — the partner's OWN stored day/goal drive the
    // miss check (their week, not ours); their promise comes from the
    // pair-scoped read. Null profile fields fall back inside the helper.
    const partnerProfile = partner ? await devMock.getProfile(partner.id) : null;
    return {
      ok: true,
      context: {
        weeklyGoal,
        weekStartDay,
        logs,
        hasPartner: !!partner,
        partner,
        partnerDisplayName,
        teamName,
        // DEV mock never "ends" a week — ring stays honest-volt, no red scare.
        weekEndedUnmet: false,
        missLine: await computeOwnMissLine(session.user.id),
        partnerMissCard: await computePartnerMissCard(
          partner?.id ?? null,
          DEV_PAIR_GROUP_ID,
          partnerProfile?.week_start_day ?? null,
          partnerProfile?.weekly_goal ?? 3,
        ),
        weekRecap: await computeWeekRecap(),
      },
    };
  }

  // REAL mode — rings count OWN logs only; the feed shows own + partner's.
  // Photo isolation: own rows via `workouts` RLS; partner rows ONLY through
  // the pair-scoped read policy (schema.sql `workouts_select_pair` — a single
  // accepted partner, additive to own-row RLS, never relaxing the bucket).
  const { data: ownRows, error: ownError } = await supabase
    .from('workouts')
    .select('id, user_id, photo_path, logged_at, workout_type, created_at')
    .eq('user_id', session.user.id)
    .order('logged_at', { ascending: false });
  if (ownError) return { ok: false, error: ownError.message };

  // My accepted partner: the OTHER member of my pair group. A paired user
  // belongs to TWO groups — their solo "Personal" group (1 member) and the
  // pair group (2 members). Taking `memberships[0]` is arbitrary, so instead
  // find the group I'm in that has EXACTLY 2 members and read its other seat.
  const { data: myMemberships } = await supabase
    .from('memberships')
    .select('group_id')
    .eq('user_id', session.user.id);
  const myGroupIds = (myMemberships ?? []).map((m) => m.group_id);
  let partnerId: string | null = null;
  let partnerName = 'Partner';
  let teamName: string | null = null;
  let pairGroupId: string | null = null;
  if (myGroupIds.length > 0) {
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
      const other = userIds.find((u) => u !== session.user.id);
      if (other) {
        partnerId = other;
        pairGroupId = groupId;
        break;
      }
    }
  }
  // M slice: partner MissCard inputs — the partner's OWN stored week-start
  // day and pair-group goal drive the miss check (their week, not ours); their
  // promise comes from the pair-scoped membership read. The name read uses the
  // same accepted-partner shape as before; week_start_day is intentionally NOT
  // read from users (own-row RLS keeps partner names/day private) — the helper
  // falls back to 'Mon' and goal 3 when the pair-scoped read can't resolve
  // them, and the snapshot path (finalize-on-fetch) still decides real misses.
  let partnerWeekStartDay: string | null = null;
  let partnerGoal = 3;
  if (partnerId) {
    const { data: partnerUser } = await supabase
      .from('users')
      .select('name')
      .eq('id', partnerId)
      .maybeSingle();
    if (partnerUser?.name) partnerName = partnerUser.name.split(' ')[0];
    const { data: partnerSettings } = await supabase
      .from('memberships')
      .select('weekly_goal')
      .eq('user_id', partnerId)
      .eq('group_id', pairGroupId ?? '')
      .maybeSingle();
    if (
      partnerSettings?.weekly_goal &&
      partnerSettings.weekly_goal >= 1 &&
      partnerSettings.weekly_goal <= 7
    ) {
      partnerGoal = partnerSettings.weekly_goal;
    }
  }
  // Naming feature: read the pair group's optional team_name (same RLS-scoped
  // read pattern — no new tables/policies; the pair group row is visible to
  // its members via the existing memberships-scoped select used above).
  if (pairGroupId) {
    const { data: groupRow } = await supabase
      .from('groups')
      .select('team_name')
      .eq('id', pairGroupId)
      .maybeSingle();
    teamName = groupRow?.team_name?.trim() || null;
  }
  partner = partnerId ? { id: partnerId, firstName: partnerName, hasLogs: true } : null;
  // Pet name is LOCAL-ONLY (never synced): this user's private display name
  // for their partner, otherwise the partner's real first name.
  const petName = await getPetName();
  const partnerDisplayName = partner ? (petName || partnerName) : null;

  // Partner rows are visible through the pair-scope policy; fetch the last
  // 50 (the whole partner journal is out of MVP scope — feed = weekly context).
  const { data: partnerRows, error: partnerError } = partnerId
    ? await supabase
        .from('workouts')
        .select('id, user_id, photo_path, logged_at, workout_type, created_at')
        .eq('user_id', partnerId)
        .order('logged_at', { ascending: false })
        .limit(50)
    : ({ data: null, error: null } as const);
  if (partnerError) return { ok: false, error: partnerError.message };

  const inWeek = (r: { logged_at: string }) => {
    const t = new Date(r.logged_at);
    return !Number.isNaN(t.getTime()) && t >= weekStart && t < weekEnd;
  };
  const weekRows = [...(ownRows ?? []), ...(partnerRows ?? [])].filter(inWeek);
  const signed = await createSignedUrls(weekRows.map((r) => r.photo_path));

  // V1.1: finalize the previous fully-elapsed week (best-effort snapshot;
  // never fails the context fetch). Real pair scope = the pair group id.
  await maybeFinalizePreviousWeek(new Date(), weekStartDay, weeklyGoal, pairGroupId);

  const ownWeek = (ownRows ?? []).filter(inWeek);
  return {
    ok: true,
    context: {
      weeklyGoal,
      weekStartDay,
      logs: weekRows
        .map((r) => rowToLog(r, signed.get(r.photo_path) ?? '', r.user_id === session.user.id ? userName : (partnerDisplayName ?? partnerName)))
        .sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : -1)),
      hasPartner: !!partner,
      partner,
      partnerDisplayName,
      teamName,
      weekEndedUnmet: now >= weekEnd && ownWeek.length < weeklyGoal,
      missLine: await computeOwnMissLine(session.user.id),
      partnerMissCard: await computePartnerMissCard(partnerId, pairGroupId, partnerWeekStartDay, partnerGoal),
      weekRecap: await computeWeekRecap(),
    },
  };
}

// ---------------------------------------------------------------------------
// Log a workout
// ---------------------------------------------------------------------------

export interface NewWorkout {
  /** Absolute URI of the captured photo (from expo-camera). */
  photoUri: string;
  workoutType?: WorkoutType | null;
}

export interface LogWorkoutResult {
  ok: boolean;
  log?: WorkoutLog;
  error?: string;
}

/**
 * Persist ONE workout proof. Under-10s target: capture → (this) → Home.
 * REAL: upload to `${user_id}/${workout_id}.jpg` with the auth token, then
 * insert a workouts row; both are scoped by RLS to auth.uid().
 * DEV: copy photo to per-user cache folder + record through devMock.
 */
export async function logWorkout(input: NewWorkout): Promise<LogWorkoutResult> {
  const session = await getStoredSession();
  if (!session) return { ok: false, error: 'No session. Sign in to log.' };

  const workoutId = newWorkoutId();
  const now = new Date().toISOString();

  if (session.isDevMode || !supabase) {
    try {
      const photo = await storeDevPhoto(session.user.id, workoutId, input.photoUri);
      const profile = await devMock.getProfile(session.user.id);
      const row: WorkoutRow = {
        id: workoutId,
        user_id: session.user.id,
        // Mirror the real mode: workouts carry the pair group id so the
        // Realtime broadcast filter can key on it (dev mock has no
        // backend — this row shape matches the real table).
        group_id: DEV_PAIR_GROUP_ID,
        photo_path: photo.localUri,
        logged_at: now,
        workout_type: input.workoutType ?? null,
        created_at: now,
      };
      await devMock.pushWorkout(session.user.id, row);
      // V1.1: workout_logged — references the workout id only + the weekly
      // count (no photo path, no names — privacy guardrail).
      void track('workout_logged', {
        sourceId: workoutId,
        groupId: DEV_PAIR_GROUP_ID,
        props: { week_count: (await devMock.listWorkouts(session.user.id)).length },
      });
      // V1.1 Build #3 slice 2: partner_logged push — AFTER commit, never
      // blocks the log (fire-and-forget, try/catch inside).
      void notifyPartnerLogged(workoutId, input.workoutType ?? null);
      return {
        ok: true,
        log: rowToLog(
          row,
          photo.localUri,
          profile?.name ?? session.user.email.split('@')[0] ?? 'You',
        ),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not save log.' };
    }
  }

  // REAL mode — upload with the user's auth token; the storage policy
  // requires the object to live under `${auth.uid()}/`.
  try {
    const photoPath = `${session.user.id}/${workoutId}.jpg`;
    const file = new File(input.photoUri);
    const { error: uploadError } = await supabase.storage
      .from(WORKOUT_BUCKET)
      .upload(photoPath, file as unknown as Blob, { contentType: 'image/jpeg', cacheControl: '3600' });
    if (uploadError) return { ok: false, error: uploadError.message };

    const { data: row, error: insertError } = await supabase
      .from('workouts')
      .insert({
        user_id: session.user.id,
        photo_path: photoPath,
        workout_type: input.workoutType ?? null,
        logged_at: now,
      })
      .select('id, photo_path, logged_at, workout_type')
      .single();
    if (insertError) return { ok: false, error: insertError.message };

    const signedUrl = (await supabase.storage.from(WORKOUT_BUCKET).createSignedUrl(photoPath, 3600))
      .data?.signedUrl ?? '';

    // V1.1: workout_logged — references the workout id only (no photo path).
    void track('workout_logged', { sourceId: row.id });
    // V1.1 Build #3 slice 2: partner_logged push — AFTER commit, never
    // blocks the log (fire-and-forget, try/catch inside).
    void notifyPartnerLogged(row.id, input.workoutType ?? null);
    return {
      ok: true,
      log: rowToLog(
        {
          id: row.id,
          user_id: session.user.id,
          photo_path: row.photo_path,
          logged_at: row.logged_at,
          workout_type: row.workout_type,
          created_at: row.logged_at,
        },
        signedUrl,
        session.user.email.split('@')[0] ?? 'You',
      ),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Upload failed. Try again.' };
  }
}

// ---------------------------------------------------------------------------
// Remove one workout (UGC control, compliance brief #2 §5)
// ---------------------------------------------------------------------------

export interface RemoveWorkoutResult {
  ok: boolean;
  error?: string;
}

/**
 * Delete ONE workout proof — OWNER ONLY, hard requirement: the caller must be
 * the workout's author (auth-uid matching is enforced in REAL mode by RLS on
 * the `workouts` table; the DEV mock deletes only from the user's OWN key
 * space + own photo file, so photo isolation is untouched either way).
 *
 * DEV: removes the row from `workouts:{userId}` and deletes the local photo
 * file (per-user cache folder) if the path resolves to one.
 * REAL: deletes the storage object then the row, both scoped by RLS to
 * auth.uid() — a partner can never delete someone else's photo.
 */
export async function removeWorkout(workoutId: string): Promise<RemoveWorkoutResult> {
  const session = await getStoredSession();
  if (!session) return { ok: false, error: 'No session. Sign in first.' };

  if (session.isDevMode || !supabase) {
    const rows = await devMock.listWorkouts(session.user.id);
    const idx = rows.findIndex((r) => r.id === workoutId);
    if (idx < 0) return { ok: false, error: 'That log is already gone.' };
    const row = rows[idx];
    rows.splice(idx, 1);
    await devMock.saveWorkouts(session.user.id, rows);
    // Delete the local proof file if it lives in this user's dev photo dir
    // (never touches another user's folder — isolation intact).
    if (row.photo_path && row.photo_path.includes(`spotter-dev-mock-photos/${session.user.id}/`)) {
      try {
        const f = new File(row.photo_path);
        if (f.exists) f.delete();
      } catch {
        // File already missing — row deletion still stands.
      }
    }
    return { ok: true };
  }

  // REAL mode: delete the private-bucket object (scoped to auth.uid() by the
  // storage policy) then the row (scoped by workouts RLS). Photo isolation is
  // preserved: the path is always `${auth.uid()}/...`, so a partner can only
  // ever reach their OWN objects.
  try {
    const { data: row } = await supabase
      .from('workouts')
      .select('photo_path')
      .eq('id', workoutId)
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (!row) return { ok: false, error: 'That log is already gone.' };
    const { error: storageError } = await supabase.storage
      .from(WORKOUT_BUCKET)
      .remove([row.photo_path]);
    if (storageError) return { ok: false, error: storageError.message };
    const { error: deleteError } = await supabase
      .from('workouts')
      .delete()
      .eq('id', workoutId)
      .eq('user_id', session.user.id);
    if (deleteError) return { ok: false, error: deleteError.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not remove the log.' };
  }
}

// ---------------------------------------------------------------------------
// Small helpers for the log sheet / camera screen
// ---------------------------------------------------------------------------

/** Week-start day labels for the header chip (slice C owns the edit sheet). */
export const WEEK_START_LABELS = WEEK_START_DAYS;