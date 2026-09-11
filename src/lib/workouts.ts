/**
 * Workout-logging types + helpers shared by REAL mode (Supabase) and DEV MOCK.
 *
 * Trust rule (non-negotiable): `photoPath` is ALWAYS the Storage object path
 * (e.g. `${user_id}/${workout_id}.jpg`) inside the PRIVATE `workouts` bucket —
 * never a public URL, never a signed URL persisted anywhere. Signed URLs are
 * generated on demand by `createSignedUrl` (src/lib/storage.ts) and are
 * short-lived.
 *
 * Week calculations use the user's `week_start_day` and local time. The ring
 * numeral + camera count badge + feed come from ONE weekly-context query
 * (home-screen.md §8) — see `fetchWeeklyContext` (src/lib/workoutStore.ts).
 */

export const WORKOUT_BUCKET = 'workouts';
export const WORKOUT_TYPES = ['Run', 'Lift', 'Cycle', 'Yoga', 'Other'] as const;
export type WorkoutType = (typeof WORKOUT_TYPES)[number];

/** A logged workout as Home / the feed needs it. */
export interface WorkoutLog {
  id: string;
  /** Author's user id (own or partner's) — the feed shows the name. */
  userId: string;
  /** Storage path inside the private bucket; NEVER a URL. */
  photoPath: string;
  /** ISO timestamp — server default now() in REAL mode. */
  loggedAt: string;
  workoutType: string | null;
  /** Author display name (own name in solo MVP). */
  authorName: string;
  /** Absolute URI this session can display (signed URL in REAL mode, local file in DEV MOCK). */
  photoUri: string;
}

/** One co-member of the user's shared group (excludes self). */
export interface GroupMemberInfo {
  id: string;
  /** Member's REAL first name (never the pet name) — used for the Profile
   * "Nickname for {firstName}" label. */
  firstName: string;
  /** The name THIS user sees for this member everywhere it renders — the
   * optional local per-member "pet name" when set, otherwise the member's
   * real first name. Local-only (never synced to the member). */
  displayName: string;
  /** True when this member has logged at least one workout (feed card). */
  hasLogs: boolean;
}

export interface WeeklyContext {
  weeklyGoal: number;
  weekStartDay: string;
  /** Logs this week, newest first (drives the ring fill + badge + feed). */
  logs: WorkoutLog[];
  /**
   * Co-members (excludes self), ordered by membership created_at asc
   * (`my_group`'s member_ids order). Empty when solo. The group feed is
   * exactly own logs + every member's logs. "In a group" ⇔ members.length > 0.
   */
  members: GroupMemberInfo[];
  /**
   * Optional shared group team name (e.g. "Team Us"). Null when unset OR solo.
   * When set, the feed header shows this instead of "With {names}".
   */
  teamName: string | null;
  /**
   * Id of the member who STARTED the group (real: `groups.creator_id`; dev:
   * the inviter/admin). Null when solo. Drives the Profile team-name caption
   * — only the creator can change the group name (groups-copy-spec §4).
   */
  groupCreatorId: string | null;
  /** Week already ended AND goal missed (ring turns danger red only then). */
  weekEndedUnmet: boolean;
}

/** Parsed shape of the SECURITY DEFINER `my_group()` RPC (schema.sql). */
export interface MyGroupResult {
  /** The caller's shared group id (>= 2 members), null when solo. */
  group_id: string | null;
  /** Co-member ids EXCLUDING self, ordered by membership created_at asc. */
  member_ids: string[];
  /** Number of co-members (0 when solo). */
  member_count: number;
  /** Group creator id — DEFENSIVE passthrough: the v1.0 `my_group()` return
   * does not include it (the store reads `groups.creator_id` directly), but a
   * future schema adding `creator` to the jsonb keeps this parsed. */
  creator_id?: string | null;
}

/**
 * Normalize the jsonb `my_group()` return (supabase-js can surface jsonb as a
 * parsed object or a JSON string depending on transport) into a typed shape.
 * Shared by workoutStore (feed discovery) and naming (team-name write target).
 */
export function parseMyGroup(data: unknown): MyGroupResult {
  const raw = (typeof data === 'string' ? (JSON.parse(data || '{}') as unknown) : data) as {
    group_id?: string | null;
    member_ids?: unknown;
    member_count?: number;
    creator?: string | null;
    creator_id?: string | null;
  } | null;
  const memberIds = Array.isArray(raw?.member_ids)
    ? raw.member_ids.filter((x): x is string => typeof x === 'string')
    : [];
  const creatorId = raw?.creator_id ?? raw?.creator ?? null;
  return {
    group_id: raw?.group_id ?? null,
    member_ids: memberIds,
    member_count: raw?.member_count ?? memberIds.length,
    ...(typeof creatorId === 'string' ? { creator_id: creatorId } : {}),
  };
}

const DAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Start-of-week boundary (local time, user's week_start_day).
 * Monday-backed (`Mon`) = classic Monday 00:00.
 */
export function weekStartFor(now: Date, weekStartDay: string): Date {
  const day = DAY_INDEX[weekStartDay] ?? 1;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // JS getDay(): Sun=0 … Sat=6 → index to target offset.
  const current = (d.getDay() + 6) % 7; // Mon-first isoish index
  const target = (day + 6) % 7; // same Mon-first index for the chosen start
  let delta = current - target;
  if (delta < 0) delta += 7;
  d.setDate(d.getDate() - delta);
  return d;
}

/** Relative timestamp per home-screen.md card anatomy: "Just now" / "2h" / "Mon 3:14p". */
export function relativeLogTime(iso: string, now: Date): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const diffMs = now.getTime() - t.getTime();
  if (diffMs < 60000) return 'Just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const day = t.toLocaleDateString(undefined, { weekday: 'short' });
  const time = t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} ${time}`;
}

/** Persisted dev-mode photo: keeps the live-camera capture local & shareable-able without Supabase. */
export interface DevPhoto {
  id: string;
  userId: string;
  /** Absolute file:// URI copied into the app cache by the dev store. */
  localUri: string;
  capturedAt: string;
}