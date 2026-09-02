/**
 * Onboarding settings persistence.
 *
 * In REAL mode these write to the Supabase `users` row (week_start_day,
 * timezone, name) + `memberships.weekly_goal` once the real project exists.
 * In DEV MOCK mode they go to AsyncStorage via devMock so the flow is fully
 * walkable without a backend.
 *
 * The commit happens ONLY on "Let's go" or "Skip for now" (per onboarding.md:
 * state is local until the final commit; a kill mid-onboarding re-enters the
 * same screen with nothing persisted).
 */
import type { Profile, WeekStartDay } from './mock';
import { devMock } from './mock';
import { getStoredSession, supabase } from './supabase';

export const WEEK_START_DAYS: WeekStartDay[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const DEFAULT_WEEKLY_GOAL = 3;
export const DEFAULT_WEEK_START: WeekStartDay = 'Mon';

export interface OnboardingSettings {
  weeklyGoal: number;
  weekStart: WeekStartDay;
}

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Week-start-aware day-of-week label for the goal micro-preview. */
export function completionDayLabel(goal: number, weekStart: WeekStartDay): string {
  const index = WEEK_START_DAYS.indexOf(weekStart);
  const day = WEEK_START_DAYS[(index + (goal - 1)) % 7];
  // "Thu" from "Thursday" — three-letter, capitalized.
  return day;
}

/**
 * Persist onboarding settings. Requires an active session (the single auth
 * path guarantees one — auth happens at welcome before step 2/3 commit).
 * Returns the persisted profile in dev mode, or null once real-mode writes exist.
 */
export async function commitOnboarding(settings: OnboardingSettings): Promise<{ ok: boolean; error?: string }> {
  const session = await getStoredSession();
  if (!session) {
    return { ok: false, error: 'No session found. Please sign in again.' };
  }

  if (!session.isDevMode) {
    // REAL mode — wired to the future real project. The schema (supabase/
    // schema.sql) is the seed; these upserts activate once env vars are set
    // and the schema is applied. Until then this branch is unreachable.
    try {
      const { error: userError } = await supabase!.from('users').upsert({
        id: session.user.id,
        name: session.user.email.split('@')[0],
        week_start_day: settings.weekStart,
        timezone: detectTimezone(),
      });
      if (userError) return { ok: false, error: userError.message };

      const { error: memberError } = await supabase!.from('memberships').upsert({
        user_id: session.user.id,
        weekly_goal: settings.weeklyGoal,
      });
      if (memberError) return { ok: false, error: memberError.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "Can't reach server. Try again." };
    }
  }

  // DEV MOCK
  const profile: Profile = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.email.split('@')[0] ?? 'Athlete',
    week_start_day: settings.weekStart,
    timezone: detectTimezone(),
    weekly_goal: settings.weeklyGoal,
    onboarded_at: new Date().toISOString(),
  };
  await devMock.saveProfile(profile);
  return { ok: true };
}