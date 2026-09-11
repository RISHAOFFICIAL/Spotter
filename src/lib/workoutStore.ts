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
  parseMyGroup,
  WORKOUT_BUCKET,
  type WorkoutLog,
  type WeeklyContext,
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
 * `baseName` distinguishes the selfie (`<workoutId>`) from the environment
 * shot (`<workoutId>-env`) — both live under the SAME per-user folder.
 */
async function storeDevPhoto(
  userId: string,
  baseName: string,
  sourceUri: string,
): Promise<DevPhoto> {
  const dir = await ensureDevDir(userId);
  const dest = dir.createFile(`${baseName}.jpg`, 'image/jpeg');
  await new File(sourceUri).copy(dest, { overwrite: true });
  return {
    id: baseName,
    userId,
    localUri: dest.uri,
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Row → display shape
// ---------------------------------------------------------------------------

function rowToLog(
  row: WorkoutRow,
  authorName: string,
  uris: { selfie: string; env: string },
): WorkoutLog {
  return {
    id: row.id,
    userId: row.user_id,
    photoPath: row.photo_path, // ALWAYS the storage path / dev file — never a URL
    photoEnv: row.photo_env ?? '', // '' = legacy row (pre dual-capture)
    loggedAt: row.logged_at,
    workoutType: row.workout_type,
    caption: row.caption ?? null,
    authorName,
    photoUri: uris.selfie,
    photoEnvUri: uris.env,
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
    // ---- DEV MOCK — same shape from async storage + local files. The group
    // is resolved from memberships (devMock.findSharedDevGroup — the dev mirror
    // of the real my_group() RPC), so the 2-person pair AND the seeded 3-person
    // demo group emit the exact same WeeklyContext shape as real mode: own logs
    // count for the ring; co-member logs merge into the feed.
    const shared = await devMock.findSharedDevGroup(session.user.id);
    const groupMembers = shared?.members ?? [];
    const memberIds = shared?.member_ids ?? [];
    // V1.1: finalize the previous fully-elapsed week (best-effort snapshot;
    // never fails the context fetch). Dev scope = the resolved group (the
    // pair group for a pair; the demo group for seeded 3-person demos).
    await maybeFinalizePreviousWeek(new Date(), weekStartDay, weeklyGoal, shared?.group_id ?? DEV_PAIR_GROUP_ID);

    const rows = await devMock.listWorkouts(session.user.id);
    const memberRows: WorkoutRow[] = [];
    for (const uid of memberIds) {
      memberRows.push(...(await devMock.listWorkouts(uid)));
    }
    const allRows = [...rows, ...memberRows];

    // Naming feature: per-member pet names (local-only map) + shared team name
    // scoped to the resolved group (mirrors real groups.team_name). Display
    // name = local pet name when set, else the member's real first name — the
    // same rule real mode applies.
    const petNames = await getPetNames();
    const teamName = shared ? await devMock.getTeamName(shared.group_id) : null;
    const members: GroupMemberInfo[] = [];
    for (const m of groupMembers) {
      if (m.user_id === session.user.id) continue;
      const firstName = ((await devMock.getDisplayName(m.user_id)) ?? 'Member').split(' ')[0];
      members.push({
        id: m.user_id,
        firstName,
        displayName: petNames[m.user_id]?.trim() || firstName,
        hasLogs: memberRows.some((r) => r.user_id === m.user_id),
      });
    }
    const memberAuthorById = new Map(members.map((m) => [m.id, m.displayName]));
    const authorName = (userId: string): string =>
      userId === session.user.id ? userName : (memberAuthorById.get(userId) ?? 'Member');

    const inWeek = (r: WorkoutRow) => {
      const t = new Date(r.logged_at);
      return !Number.isNaN(t.getTime()) && t >= weekStart && t < weekEnd;
    };
    const logs = allRows
      .filter(inWeek)
      .map((r) =>
        rowToLog(r, authorName(r.user_id), {
          // DEV: photo_path / photo_env are local file URIs — display directly
          selfie: r.photo_path,
          env: r.photo_env ?? '',
        }),
      )
      .sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : -1));
    // The member who STARTED the group: the admin seat (dev mirror of
    // groups.creator_id — the inviter on a pair, the seeding user on the demo).
    const creatorMembership = groupMembers.find((m) => m.role === 'admin');
    // M slice: partner MissCard — DEV "partner" = the single co-member of
    // a 2-person pair (the promise stays pair-private; in the 3-person demo
    // group the card is suppressed, mirroring real 3-person groups).
    const partner = members.length === 1 ? members[0] : null;
    const partnerProfile = partner ? await devMock.getProfile(partner.id) : null;
    return {
      ok: true,
      context: {
        weeklyGoal,
        weekStartDay,
        logs,
        members,
        teamName,
        groupCreatorId: creatorMembership?.user_id ?? null,
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
    .select('id, user_id, photo_path, photo_env, caption, logged_at, workout_type, created_at')
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

  // Naming feature: read the group's optional team_name + its creator
  // (group-scoped `groups_select_member` policy — any member can read; the
  // creator still writes). creator_id drives the Profile caption: only the
  // person who started the group can change its name.
  let teamName: string | null = null;
  let groupCreatorId: string | null = null;
  // M slice: partner MissCard inputs — the partner is the single co-member
  // of a 2-person group (the promise is pair-private; in 3-person groups the
  // card stays off, matching memberships_select_pair's count=2 scope). The
  // partner's goal comes from the pair-scoped membership read; their
  // week_start_day is intentionally NOT read from users (own-row RLS keeps
  // partner days private) — the helper falls back to 'Mon'/goal 3 and the
  // snapshot path (finalize-on-fetch) still decides real misses.
  let partnerId: string | null = null;
  let partnerWeekStartDay: string | null = null;
  let partnerGoal = 3;
  if (members.length === 1) {
    partnerId = members[0].id;
    const { data: partnerSettings } = await supabase
      .from('memberships')
      .select('weekly_goal')
      .eq('user_id', partnerId)
      .eq('group_id', group.group_id ?? '')
      .maybeSingle();
    if (partnerSettings?.weekly_goal && partnerSettings.weekly_goal >= 1 && partnerSettings.weekly_goal <= 7) {
      partnerGoal = partnerSettings.weekly_goal;
    }
  }
  // The group row read lands on OUR group's id (master's my_group shape).
  const pairGroupId = group.group_id ?? null;
  if (group.group_id) {
    const { data: groupRow } = await supabase
      .from('groups')
      .select('team_name, creator_id')
      .eq('id', group.group_id)
      .maybeSingle();
    teamName = groupRow?.team_name?.trim() || null;
    groupCreatorId =
      typeof groupRow?.creator_id === 'string'
        ? groupRow.creator_id
        : (group.creator_id ?? null); // defensive passthrough if a future my_group adds it
  }

  const memberAuthorById = new Map(members.map((m) => [m.id, m.displayName]));
  const authorName = (userId: string): string =>
    userId === session.user.id ? userName : (memberAuthorById.get(userId) ?? 'Member');

  const inWeek = (r: { logged_at: string }) => {
    const t = new Date(r.logged_at);
    return !Number.isNaN(t.getTime()) && t >= weekStart && t < weekEnd;
  };
  const weekRows = (rows ?? []).filter(inWeek);
  // Signed URLs for BOTH live shots in one batch (selfie + environment path).
  const photoPaths = weekRows.flatMap((r) =>
    [r.photo_path, r.photo_env].filter((p): p is string => typeof p === 'string' && p.length > 0),
  );
  const signed = await createSignedUrls(photoPaths);

  // V1.1: finalize the previous fully-elapsed week (best-effort snapshot;
  // never fails the context fetch). Real scope = the current group id
  // (group-scoped weekly_results rows, consistent with real snapshots).
  await maybeFinalizePreviousWeek(new Date(), weekStartDay, weeklyGoal, group.group_id);
  const ownWeek = (rows ?? []).filter((r) => r.user_id === session.user.id && inWeek(r));
  return {
    ok: true,
    context: {
      weeklyGoal,
      weekStartDay,
      logs: weekRows
        .map((r) =>
          rowToLog(r, authorName(r.user_id), {
            selfie: signed.get(r.photo_path) ?? '',
            env: r.photo_env ? (signed.get(r.photo_env) ?? '') : '',
          }),
        )
        .sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : -1)),
      members,
      teamName,
      groupCreatorId,
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
  /** Absolute URI of the captured SELFIE photo (from expo-camera; already
   * filter-baked by selfieBake.ts when a filter is active). */
  photoUri: string;
  /** Absolute URI of the captured ENVIRONMENT photo (2nd live shot — always
   * unfiltered). Required: the v1.0 dual-capture flow always captures both. */
  photoEnvUri: string;
  /** Optional caption — ≤140 chars (product cap; UI enforces at input, DB
   * check constraint enforces at insert in REAL mode). Trimmed to null. */
  caption?: string | null;
  workoutType?: WorkoutType | null;
}

export interface LogWorkoutResult {
  ok: boolean;
  log?: WorkoutLog;
  error?: string;
}

/**
 * Persist ONE workout proof (dual-capture: selfie + environment + optional
 * caption). Under-10s target: capture → (this) → Home.
 * REAL: upload both shots to `${user_id}/${workoutId}.jpg` and
 * `${user_id}/${workoutId}-env.jpg` with the auth token, then insert a
 * workouts row carrying both paths + caption; all scoped by RLS to auth.uid().
 * DEV: copy both photos to the per-user cache folder + record through devMock.
 */
export async function logWorkout(input: NewWorkout): Promise<LogWorkoutResult> {
  const session = await getStoredSession();
  if (!session) return { ok: false, error: 'No session. Sign in to log.' };

  const workoutId = newWorkoutId();
  const now = new Date().toISOString();
  const caption = input.caption?.trim() ? input.caption.trim().slice(0, 140) : null;

  if (session.isDevMode || !supabase) {
    try {
      const [photo, envPhoto] = await Promise.all([
        storeDevPhoto(session.user.id, workoutId, input.photoUri),
        storeDevPhoto(session.user.id, `${workoutId}-env`, input.photoEnvUri),
      ]);
      const profile = await devMock.getProfile(session.user.id);
      const row: WorkoutRow = {
        id: workoutId,
        user_id: session.user.id,
        // Mirror the real mode: workouts carry the pair group id so the
        // Realtime broadcast filter can key on it (dev mock has no
        // backend — this row shape matches the real table).
        group_id: DEV_PAIR_GROUP_ID,
        photo_path: photo.localUri,
        photo_env: envPhoto.localUri,
        caption,
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
          profile?.name ?? session.user.email.split('@')[0] ?? 'You',
          { selfie: photo.localUri, env: envPhoto.localUri },
        ),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not save log.' };
    }
  }

  // REAL mode — upload with the user's auth token; the storage policy
  // requires both objects to live under `${auth.uid()}/`.
  try {
    // Narrowed client for closures (TS doesn't carry the !supabase guard into
    // the async `upload` helper below).
    const client = supabase;
    const photoPath = `${session.user.id}/${workoutId}.jpg`;
    const envPath = `${session.user.id}/${workoutId}-env.jpg`;
    const upload = async (path: string, uri: string) => {
      const file = new File(uri);
      return client.storage
        .from(WORKOUT_BUCKET)
        .upload(path, file as unknown as Blob, { contentType: 'image/jpeg', cacheControl: '3600' });
    };
    const [selfieUpload, envUpload] = await Promise.all([upload(photoPath, input.photoUri), upload(envPath, input.photoEnvUri)]);
    if (selfieUpload.error) return { ok: false, error: selfieUpload.error.message };
    if (envUpload.error) return { ok: false, error: envUpload.error.message };

    const { data: row, error: insertError } = await supabase
      .from('workouts')
      .insert({
        user_id: session.user.id,
        photo_path: photoPath,
        photo_env: envPath,
        caption,
        workout_type: input.workoutType ?? null,
        logged_at: now,
      })
      .select('id, photo_path, photo_env, caption, logged_at, workout_type')
      .single();
    if (insertError) return { ok: false, error: insertError.message };

    const signed = await createSignedUrls([photoPath, envPath]);

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
          photo_env: row.photo_env,
          caption: row.caption,
          logged_at: row.logged_at,
          workout_type: row.workout_type,
          created_at: row.logged_at,
        },
        session.user.email.split('@')[0] ?? 'You',
        { selfie: signed.get(photoPath) ?? '', env: signed.get(envPath) ?? '' },
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
 * space + own photo files, so photo isolation is untouched either way).
 * Deletes BOTH live shots (selfie + environment).
 *
 * DEV: removes the row from `workouts:{userId}` and deletes the local photo
 * files (per-user cache folder) if the paths resolve to one.
 * REAL: deletes the storage objects then the row, both scoped by RLS to
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
    // Delete the local proof files if they live in this user's dev photo dir
    // (never touches another user's folder — isolation intact).
    const ownDir = `spotter-dev-mock-photos/${session.user.id}/`;
    for (const p of [row.photo_path, row.photo_env ?? '']) {
      if (p && p.includes(ownDir)) {
        try {
          const f = new File(p);
          if (f.exists) f.delete();
        } catch {
          // File already missing — row deletion still stands.
        }
      }
    }
    return { ok: true };
  }

  // REAL mode: delete the private-bucket objects (scoped to auth.uid() by the
  // storage policy) then the row (scoped by workouts RLS). Photo isolation is
  // preserved: both paths are always `${auth.uid()}/...`, so a partner can
  // only ever reach their OWN objects.
  try {
    const { data: row } = await supabase
      .from('workouts')
      .select('photo_path, photo_env')
      .eq('id', workoutId)
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (!row) return { ok: false, error: 'That log is already gone.' };
    const paths = [row.photo_path, row.photo_env ?? ''].filter((p) => p.length > 0);
    const { error: storageError } = await supabase.storage
      .from(WORKOUT_BUCKET)
      .remove(paths);
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