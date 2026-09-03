/**
 * DEV MODE MOCK — clearly labeled, no network, no real Supabase.
 *
 * This is the fallback backend when EXPO_PUBLIC_SUPABASE_URL /
 * EXPO_PUBLIC_SUPABASE_ANON_KEY are absent. It lets the whole onboarding flow
 * run end-to-end locally (auth + session + a stub user + persisted onboarding
 * settings) so the app is walkable without a Supabase project.
 *
 * Everything produced here is visibly fake: the welcome screen labels the
 * session "DEV DEMO — local mock", and nothing here ever touches the network.
 * When real env vars are present, supabase.ts routes to the real client and
 * this file is unused.
 *
 * Persistence: AsyncStorage (device/web) stored under `spotter.devmock:v1`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORE_PREFIX = 'spotter.devmock:v1:';

export type WeekStartDay = 'Sun'|'Mon'|'Tue'|'Wed'|'Thu'|'Fri'|'Sat';

export interface MockSession {
  user: SessionUser;
  devMode: true;
}

export interface SessionUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface Profile {
  id: string;
  email: string;
  name: string;
  week_start_day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
  timezone: string;
  weekly_goal: number;
  onboarded_at: string;
}

function makeId(): string {
  return `dev_${Math.random().toString(36).slice(2, 10)}`;
}

async function readValue<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(STORE_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeValue<T>(key: string, value: T): Promise<void> {
  await AsyncStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
}

export const devMock = {
  /** Single path: creates (or re-uses by email) a clearly-labeled demo user. */
  async createUser(email: string): Promise<SessionUser> {
    const existing = await readValue<SessionUser>('user');
    if (existing && existing.email === email) return existing;
    const user: SessionUser = {
      id: makeId(),
      email,
      createdAt: new Date().toISOString(),
    };
    await writeValue('user', user);
    return user;
  },

  async getProfile(userId: string): Promise<Profile | null> {
    return readValue<Profile>(`profile:${userId}`);
  },

  async saveProfile(profile: Profile): Promise<Profile> {
    await writeValue(`profile:${profile.id}`, profile);
    return profile;
  },

  /**
   * SLICE B: dev workouts (per-user key). The SHAPE mirrors the real
   * `workouts` table row (photo_path = local file path standing in for the
   * storage path; logged_at = now()). Keeps the camera-tap → log flow fully
   * walkable without Supabase.
   */
  async listWorkouts(userId: string): Promise<WorkoutRow[]> {
    const rows = await readValue<WorkoutRow[]>(`workouts:${userId}`);
    return rows ?? [];
  },
  async saveWorkouts(userId: string, rows: WorkoutRow[]): Promise<void> {
    await writeValue(`workouts:${userId}`, rows);
  },
};

/** So DEV MOCK and REAL have the same pickup point. Pairs with workouts rows. */
export interface WorkoutRow {
  id: string;
  user_id: string;
  photo_path: string;
  logged_at: string;
  workout_type: string | null;
  created_at: string;
}