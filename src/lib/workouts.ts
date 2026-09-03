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

export interface PartnerInfo {
  id: string;
  firstName: string;
  /** True when the partner has logged at least one workout (feed card). */
  hasLogs: boolean;
}

export interface WeeklyContext {
  weeklyGoal: number;
  weekStartDay: string;
  /** Logs this week, newest first (drives the ring fill + badge + feed). */
  logs: WorkoutLog[];
  /** true when the user has an accepted partner (slice C wires this). */
  hasPartner: boolean;
  /** The accepted partner (null when solo). */
  partner: PartnerInfo | null;
  /** Week already ended AND goal missed (ring turns danger red only then). */
  weekEndedUnmet: boolean;
}

export function isWorkoutType(v: string | null | undefined): v is WorkoutType {
  return !!v && (WORKOUT_TYPES as readonly string[]).includes(v);
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

export function isInCurrentWeek(iso: string, now: Date, weekStartDay: string): boolean {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return false;
  const start = weekStartFor(now, weekStartDay);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return t >= start && t < end;
}

/** Relative timestamp per home-screen.md card anatomy: "2h", then "Mon 3:14p". */
export function relativeLogTime(iso: string, now: Date): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const diffMs = now.getTime() - t.getTime();
  if (diffMs < 0) return 'now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return mins <= 1 ? '1m' : `${mins}m`;
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