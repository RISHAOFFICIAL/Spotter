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

import { devMock, type WorkoutRow } from './mock';
import { getStoredSession, supabase } from './supabase';
import { createSignedUrls } from './storage';
import { WEEK_START_DAYS } from './settings';
import {
  weekStartFor,
  relativeLogTime,
  WORKOUT_BUCKET,
  type WorkoutLog,
  type WeeklyContext,
  type WorkoutType,
  type DevPhoto,
} from './workouts';

const DEVMOCK_PHOTOS_DIR = 'spotter-dev-mock-photos';

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
  let hasPartner = false;
  const userName = session.user.email.split('@')[0] ?? 'You';

  if (session.isDevMode) {
    const profile = await devMock.getProfile(session.user.id);
    if (profile) {
      weeklyGoal = profile.weekly_goal;
      weekStartDay = profile.week_start_day;
    }
  } else if (supabase) {
    const { data: settings } = await supabase
      .from('memberships')
      .select('weekly_goal')
      .eq('user_id', session.user.id)
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
    // DEV MOCK — same shape from async storage + local files.
    const rows = await devMock.listWorkouts(session.user.id);
    const logs: WorkoutLog[] = [];
    for (const row of rows) {
      const t = new Date(row.logged_at);
      if (Number.isNaN(t.getTime())) continue;
      if (t < weekStart || t >= weekEnd) continue;
      logs.push(rowToLog(row, row.photo_path, row.user_id === session.user.id ? userName : 'Partner'));
    }
    logs.sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : -1));
    return {
      ok: true,
      context: {
        weeklyGoal,
        weekStartDay,
        logs,
        hasPartner,
        // DEV mock never "ends" a week — ring stays honest-volt, no red scare.
        weekEndedUnmet: false,
      },
    };
  }

  // REAL mode — RLS guarantees only this user's rows are visible.
  const { data: workoutRows, error: rowsError } = await supabase
    .from('workouts')
    .select('id, user_id, photo_path, logged_at, workout_type, created_at')
    .eq('user_id', session.user.id)
    .order('logged_at', { ascending: false });
  if (rowsError) return { ok: false, error: rowsError.message };

  const inWeek = (workoutRows ?? []).filter((r) => {
    const t = new Date(r.logged_at);
    return !Number.isNaN(t.getTime()) && t >= weekStart && t < weekEnd;
  });

  const signed = await createSignedUrls(inWeek.map((r) => r.photo_path));

  return {
    ok: true,
    context: {
      weeklyGoal,
      weekStartDay,
      logs: inWeek.map((r) => rowToLog(r, signed.get(r.photo_path) ?? '', userName)),
      hasPartner, // slice C wires partners in
      weekEndedUnmet: now >= weekEnd && inWeek.length < weeklyGoal,
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
      const rows = await devMock.listWorkouts(session.user.id);
      const row: WorkoutRow = {
        id: workoutId,
        user_id: session.user.id,
        photo_path: photo.localUri,
        logged_at: now,
        workout_type: input.workoutType ?? null,
        created_at: now,
      };
      rows.push(row);
      await devMock.saveWorkouts(session.user.id, rows);
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
// Small helpers for the log sheet / camera screen
// ---------------------------------------------------------------------------

/** Week-start day labels for the header chip (slice C owns the edit sheet). */
export const WEEK_START_LABELS = WEEK_START_DAYS;