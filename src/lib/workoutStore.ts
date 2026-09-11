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
import { getPetNames } from './naming';
import { getStoredSession, supabase } from './supabase';
import { createSignedUrls } from './storage';
import { WEEK_START_DAYS } from './settings';
import {
  weekStartFor,
  parseMyGroup,
  WORKOUT_BUCKET,
  type WorkoutLog,
  type WeeklyContext,
  type PartnerInfo,
  type GroupMemberInfo,
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
    // two-user: own logs count for the ring; co-member logs merge into the feed).
    const pair = await devMock.getPairState(session.user.id);
    const rows = await devMock.listWorkouts(session.user.id);
    const memberRows = pair.partner ? await devMock.listWorkouts(pair.partner.id) : [];
    const allRows = [...rows, ...memberRows];

    // Naming feature: per-member pet names (local-only map) + shared team name
    // (dev pair group). Display name = local pet name when set, else the
    // member's real first name — the same rule real mode applies.
    const petNames = await getPetNames();
    const teamName = await devMock.getTeamName();
    const members: GroupMemberInfo[] = pair.partner
      ? [
          {
            id: pair.partner.id,
            firstName: (pair.partner.name ?? 'Partner').split(' ')[0],
            displayName:
              petNames[pair.partner.id]?.trim() || (pair.partner.name ?? 'Partner').split(' ')[0],
            hasLogs: memberRows.length > 0,
          },
        ]
      : [];
    const partner: PartnerInfo | null = members[0] ?? null;
    const partnerDisplayName = members[0]?.displayName ?? null;
    const authorName = (userId: string): string =>
      userId === session.user.id
        ? userName
        : (members.find((m) => m.id === userId)?.displayName ?? 'Member');

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
          authorName(r.user_id),
        ),
      )
      .sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : -1));
    return {
      ok: true,
      context: {
        weeklyGoal,
        weekStartDay,
        logs,
        hasPartner: members.length > 0,
        members,
        partner,
        partnerDisplayName,
        teamName,
        // DEV mock never "ends" a week — ring stays honest-volt, no red scare.
        weekEndedUnmet: false,
      },
    };
  }

  // REAL mode — rings count OWN logs only; the feed shows own + co-members'.
  // Photo isolation: every row resolves through RLS — own rows via the own
  // policies, co-member rows ONLY through the group-scoped read policies
  // (schema.sql workouts_select_group / users_select_group / groups_select_member
  // — membership-driven, additive to own-row RLS, never relaxing the bucket).
  // Discovery runs through the SECURITY DEFINER my_group() RPC — the app
  // cannot read co-members' membership rows directly (memberships RLS exposes
  // only own rows, which made raw-memberships counting see every group as
  // 1-member). my_group() resolves only auth.uid()'s own shared group, so
  // stranger isolation is unchanged. ONE IN-query per table (no N+1 per
  // member): the group-select policies evaluate per row.
  const { data: groupData, error: groupError } = await supabase.rpc('my_group');
  if (groupError) return { ok: false, error: groupError.message };
  const group = parseMyGroup(groupData);
  const memberIds = group.member_ids;
  const allUserIds = [session.user.id, ...memberIds];

  const { data: rows, error: rowsError } = await supabase
    .from('workouts')
    .select('id, user_id, photo_path, logged_at, workout_type, created_at')
    .in('user_id', allUserIds)
    .order('logged_at', { ascending: false });
  if (rowsError) return { ok: false, error: rowsError.message };

  // Co-member names are group-scoped via `users_select_group` (real first
  // names; pet names stay strictly local).
  const { data: userRows, error: usersError } = await supabase
    .from('users')
    .select('id, name')
    .in('id', allUserIds);
  if (usersError) return { ok: false, error: usersError.message };

  const realNameById = new Map((userRows ?? []).map((u) => [u.id, u.name ?? '']));
  const petNames = await getPetNames();
  const members: GroupMemberInfo[] = memberIds.map((id) => {
    const firstName = (realNameById.get(id) ?? 'Member').split(' ')[0];
    return {
      id,
      firstName,
      displayName: petNames[id]?.trim() || firstName,
      hasLogs: (rows ?? []).some((r) => r.user_id === id),
    };
  });
  const partner: PartnerInfo | null = members[0] ?? null;
  const partnerDisplayName = members[0]?.displayName ?? null;

  // Naming feature: read the group's optional team_name (group-scoped
  // `groups_select_member` policy — any member can read; creator still writes).
  let teamName: string | null = null;
  if (group.group_id) {
    const { data: groupRow } = await supabase
      .from('groups')
      .select('team_name')
      .eq('id', group.group_id)
      .maybeSingle();
    teamName = groupRow?.team_name?.trim() || null;
  }

  const memberAuthorById = new Map(members.map((m) => [m.id, m.displayName]));
  const authorName = (userId: string): string =>
    userId === session.user.id ? userName : (memberAuthorById.get(userId) ?? 'Member');

  const inWeek = (r: { logged_at: string }) => {
    const t = new Date(r.logged_at);
    return !Number.isNaN(t.getTime()) && t >= weekStart && t < weekEnd;
  };
  const weekRows = (rows ?? []).filter(inWeek);
  const signed = await createSignedUrls(weekRows.map((r) => r.photo_path));

  const ownWeek = (rows ?? []).filter((r) => r.user_id === session.user.id && inWeek(r));
  return {
    ok: true,
    context: {
      weeklyGoal,
      weekStartDay,
      logs: weekRows
        .map((r) => rowToLog(r, signed.get(r.photo_path) ?? '', authorName(r.user_id)))
        .sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : -1)),
      hasPartner: members.length > 0,
      members,
      partner,
      partnerDisplayName,
      teamName,
      weekEndedUnmet: now >= weekEnd && ownWeek.length < weeklyGoal,
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