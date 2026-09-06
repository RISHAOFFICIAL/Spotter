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
  /** Single path: creates (or re-uses by email) a clearly-labeled demo user.
   * v2: users are keyed BY EMAIL so a second dev user (the invitee) can exist
   * alongside the inviter — the two-user smoke flow needs both. The legacy
   * single 'user' key stays synced to the most recent user for old reads. */
  async createUser(email: string): Promise<SessionUser> {
    const byEmail = await readValue<SessionUser>(`user:${email}`);
    if (byEmail) {
      await writeValue('user', byEmail);
      return byEmail;
    }
    const legacy = await readValue<SessionUser>('user');
    if (legacy && legacy.email === email) return legacy;
    const user: SessionUser = {
      id: makeId(),
      email,
      createdAt: new Date().toISOString(),
    };
    await writeValue(`user:${email}`, user);
    await writeValue('user', user);
    return user;
  },
  /** Resolve a dev user by id (any user — two-user smoke flow). */
  async getUserById(userId: string): Promise<SessionUser | null> {
    const all = await this.listUsers();
    return all.find((u) => u.id === userId) ?? null;
  },
  /** All dev users (created via createUser / seeded partner). */
  async listUsers(): Promise<SessionUser[]> {
    const keys = await AsyncStorage.getAllKeys();
    const users: SessionUser[] = [];
    for (const key of keys ?? []) {
      if (!key.startsWith(`${STORE_PREFIX}user:`)) continue;
      if (key === `${STORE_PREFIX}user`) continue;
      const u = await readValue<SessionUser>(key.slice(STORE_PREFIX.length));
      if (u) users.push(u);
    }
    const partner = await readValue<SessionUser>('partnerUser');
    if (partner) users.push(partner);
    return users;
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
  /** Append (or replace by id) one workout row for a user. */
  async pushWorkout(userId: string, row: WorkoutRow): Promise<void> {
    const rows = (await readValue<WorkoutRow[]>(`workouts:${userId}`)) ?? [];
    const idx = rows.findIndex((r) => r.id === row.id);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    await writeValue(`workouts:${userId}`, rows);
  },

  // ---- SLICE C: two-user pairing --------------------------------

  /**
   * DEV MOCK pair state. Returns an object describing whether the current user
   * is paired (and with whom) in the dev mock. There is NO real backend here —
   * this is the honest dev stand-in for "my accepted partner" that real mode
   * gets from memberships. `partner` is null until accepted.
   */
  async getPairState(userId: string): Promise<{
    partner: { id: string; name: string } | null;
    /** True when an invite from this user exists and was accepted. */
    accepted: boolean;
  }> {
    const state = await readValue<{ partner: { id: string; name: string } | null; accepted: boolean }>(
      `pair:${userId}`,
    );
    return state ?? { partner: null, accepted: false };
  },

  async savePairState(
    userId: string,
    state: { partner: { id: string; name: string } | null; accepted: boolean },
  ): Promise<void> {
    await writeValue(`pair:${userId}`, state);
  },

  /**
   * Optional shared pair TEAM NAME (naming feature B). In dev mock there is a
   * single pair group (DEV_PAIR_GROUP_ID), so the team name is stored under a
   * group-scoped key — SHARED between both sides (mirrors the real `groups`
   * table row the pair shares). Null when unset (UI falls back to "Paired
   * with {partner}").
   */
  async getTeamName(): Promise<string | null> {
    return readValue<string>(`teamName:${DEV_PAIR_GROUP_ID}`);
  },
  async saveTeamName(name: string | null): Promise<void> {
    const trimmed = name?.trim() ?? '';
    if (trimmed) {
      await writeValue(`teamName:${DEV_PAIR_GROUP_ID}`, trimmed);
    } else {
      await AsyncStorage.removeItem(`${STORE_PREFIX}teamName:${DEV_PAIR_GROUP_ID}`);
    }
  },
  /** V1.1: dev-mock weekly result snapshots (mirror the weekly_results table). */
  async listResults(userId: string): Promise<WeeklyResultRow[]> {
    return (await readValue<WeeklyResultRow[]>(`results:${userId}`)) ?? [];
  },
  async saveResult(userId: string, row: WeeklyResultRow): Promise<void> {
    const rows = (await readValue<WeeklyResultRow[]>(`results:${userId}`)) ?? [];
    const idx = rows.findIndex(
      (r) => r.group_id === row.group_id && r.week_start_at === row.week_start_at,
    );
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    await writeValue(`results:${userId}`, rows);
  },
  /** V1.1: drop one user's result snapshots (smoke reset between finalize assertions). */
  async clearResults(userId: string): Promise<void> {
    await AsyncStorage.removeItem(`${STORE_PREFIX}results:${userId}`);
  },
  // ---- V1.1 BUILD #2 (S slice): miss promise ------------------------------

  /**
   * The member's OWN optional miss promise ("If I miss, I owe you: ___").
   * In the real schema the value lives on the member's OWN membership row in
   * the pair group (own-row RLS, never readable/writable by the partner in
   * this build); here it is stored per-user under its own key, mirroring that
   * own-row isolation. Empty string == cleared; null == never set.
   */
  async getMissPromise(userId: string): Promise<string | null> {
    const raw = await readValue<string>(`missPromise:${userId}`);
    const trimmed = raw?.trim() ?? '';
    return trimmed || null;
  },
  /** Save (trimmed) or clear (empty string) one user's miss promise. */
  async saveMissPromise(userId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed) {
      await writeValue(`missPromise:${userId}`, trimmed);
    } else {
      await AsyncStorage.removeItem(`${STORE_PREFIX}missPromise:${userId}`);
    }
  },
  /** Wipe ALL dev-mock state (smoke test / demo reset). Not used by the UI. */
  async clearAll(): Promise<void> {
    const keys = await AsyncStorage.getAllKeys();
    for (const key of keys ?? []) {
      if (key.startsWith(STORE_PREFIX) || key === 'spotter.invite:v1') {
        await AsyncStorage.removeItem(key);
      }
    }
  },

  /**
   * DELETE one dev user's account data (App Store 5.1.1(v) in-app account
   * deletion — called by accountDeletion.deleteAccount()). Removes ONLY keys
   * this user owns, so photo isolation stays intact:
   *   user:<email>, user (legacy — if it points at this user), profile:<id>,
   *   workouts:<id>, pair:<id>, memberships:<id>, invites:<id>,
   *   workouts:<partner...> is NEVER touched (partner's data is theirs).
   * The photo FILE itself is deleted by the caller (accountDeletion.ts dev
   * folder delete) — this removes the row + account-shape keys.
   */
  async deleteUserData(userId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const user = await this.getUserById(userId);
      const keys = await AsyncStorage.getAllKeys();
      const emailKey = user ? `${STORE_PREFIX}user:${user.email}` : null;
      const legacy = await readValue<SessionUser>('user');
      for (const key of keys ?? []) {
        const ownedKey =
          key === `${STORE_PREFIX}profile:${userId}` ||
          key === `${STORE_PREFIX}workouts:${userId}` ||
          key === `${STORE_PREFIX}pair:${userId}` ||
          key === `${STORE_PREFIX}memberships:${userId}` ||
          key === `${STORE_PREFIX}invites:${userId}` ||
          key === `${STORE_PREFIX}results:${userId}` ||
          key === `${STORE_PREFIX}missPromise:${userId}` ||
          (emailKey !== null && key === emailKey) ||
          (legacy?.id === userId && key === `${STORE_PREFIX}user`);
        if (ownedKey) {
          await AsyncStorage.removeItem(key);
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not delete account data.' };
    }
  },

  async listInvites(userId: string): Promise<DevInvite[]> {
    return (await readValue<DevInvite[]>(`invites:${userId}`)) ?? [];
  },

  async saveInvites(userId: string, rows: DevInvite[]): Promise<void> {
    await writeValue(`invites:${userId}`, rows);
  },

  /** Resolve a dev-mock code (accepts the "DEV-" prefix form or the raw token).
   * v2: scans EVERY user's invites store — the code belongs to whoever
   * generated it (pre-signup generation), and in the two-user smoke flow the
   * invitee resolves the inviter's code. Tokens are 8 random chars from a
   * 31-char alphabet, so collisions are not a practical concern. */
  async findInviteByCode(code: string): Promise<DevInvite | null> {
    const normalized = code.trim().replace(/^DEV-/i, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (!normalized) return null;
    const keys = await AsyncStorage.getAllKeys();
    for (const key of keys ?? []) {
      if (!key.startsWith(`${STORE_PREFIX}invites:`)) continue;
      const rows = await readValue<DevInvite[]>(key.slice(STORE_PREFIX.length));
      const hit = rows?.find(
        (r) => r.token.replace(/^DEV-/i, '').replace(/[^A-Z0-9]/gi, '').toUpperCase() === normalized,
      );
      if (hit) return hit;
    }
    return null;
  },

  /** Add a membership row for a dev user in a group (pair group). */
  async addDevMembership(membership: DevMembership): Promise<void> {
    const key = `memberships:${membership.user_id}`;
    const rows = (await readValue<DevMembership[]>(key)) ?? [];
    const existing = rows.find((m) => m.group_id === membership.group_id);
    if (existing) {
      Object.assign(existing, membership);
    } else {
      rows.push(membership);
    }
    await writeValue(key, rows);
  },

  async getDevMemberships(userId: string): Promise<DevMembership[]> {
    return (await readValue<DevMembership[]>(`memberships:${userId}`)) ?? [];
  },

  /**
   * Seed the DEV PARTNER account on first use: a fixed id (deterministic for
   * the demo), a few pre-created workout logs for today (labeled "Dev Partner
   * — preset demo logs"), and their half of the pair membership. Idempotent.
   */
  async getOrSeedPartner(): Promise<SessionUser> {
    const key = 'partnerUser';
    const existing = await readValue<SessionUser>(key);
    if (existing) return existing;
    const partner: SessionUser = {
      id: 'dev_partner',
      email: DEV_PARTNER_EMAIL,
      createdAt: new Date().toISOString(),
    };
    await writeValue(key, partner);
    // Preset pair-state on the partner side: paired with whoever the current
    // user is (reads the active user email from the session store).
    const self = await readValue<SessionUser>('user');
    const partnerSide = {
      partner: self ? { id: self.id, name: self.email.split('@')[0] } : null,
      accepted: true,
    };
    await writeValue(`pair:${partner.id}`, partnerSide);
    // A few "today" logs so the invitee's shared feed has partner history from
    // the very first render ("They're already logging. Your turn." is honest).
    const existingLogs = (await readValue<WorkoutRow[]>(`workouts:${partner.id}`)) ?? [];
    if (existingLogs.length === 0) {
      const now = Date.now();
      const seed: WorkoutRow[] = [
        {
          id: `dev_partner_w1`,
          user_id: partner.id,
          photo_path: 'mock://partner/run.jpg',
          logged_at: new Date(now - 5400_000).toISOString(),
          workout_type: 'Run',
          created_at: new Date(now - 5400_000).toISOString(),
        },
        {
          id: `dev_partner_w2`,
          user_id: partner.id,
          photo_path: 'mock://partner/lift.jpg',
          logged_at: new Date(now - 72 * 3600_000).toISOString(),
          workout_type: 'Lift',
          created_at: new Date(now - 72 * 3600_000).toISOString(),
        },
      ];
      await writeValue(`workouts:${partner.id}`, seed);
      // The preset partner also owns a PENDING invite for their fixed code so
      // the code shown in the demo resolves everywhere (including pre-signup).
      const partnerInvites = (await readValue<DevInvite[]>(`invites:${partner.id}`)) ?? [];
      if (!partnerInvites.some((r) => r.token === DEV_PARTNER_CODE)) {
        partnerInvites.push({
          id: 'dev_invite_partner',
          inviter_id: partner.id,
          token: DEV_PARTNER_CODE,
          invitee_email: null,
          status: 'pending',
          created_at: new Date(now).toISOString(),
          accepted_at: null,
        });
        await writeValue(`invites:${partner.id}`, partnerInvites);
      }
    }
    return partner;
  },

  /** Mark the current dev user as paired with the preset partner (both sides).
   * v2: the invitee is whoever resolves the inviter's code (not the 'user'
   * legacy key), so the pair name reads the invitee's own profile. */
  async acceptDevPair(userId: string): Promise<void> {
    const partner = await this.getOrSeedPartner();
    await this.acceptDevPairWith(userId, partner);
  },
  /** Pair an existing dev user with another existing dev user (two-user flow:
   * the invitee pairs with the INVITER of the code, not the preset partner).
   * Creates pair state + pair memberships on both sides (each side keeps its
   * own weekly goal). */
  async acceptDevPairWith(userId: string, partnerUser: SessionUser): Promise<void> {
    const selfProfile = await this.getProfile(userId);
    const selfUser =
      (await readValue<SessionUser>(`user:${selfProfile?.email ?? ''}`)) ??
      (await readValue<SessionUser>('user'));
    const selfName = selfProfile?.name ?? selfUser?.email.split('@')[0] ?? 'You';
    const partnerName = partnerUser.email.split('@')[0] ?? 'Partner';
    const partnerProfile = await this.getProfile(partnerUser.id);
    await this.savePairState(userId, { partner: { id: partnerUser.id, name: partnerName }, accepted: true });
    await this.savePairState(partnerUser.id, { partner: { id: userId, name: selfName }, accepted: true });
    // Pair membership on BOTH sides (inviter keeps their personal group too —
    // the feed reads the pair group; weekly goal stays per user).
    await this.addDevMembership({
      group_id: DEV_PAIR_GROUP_ID,
      user_id: userId,
      weekly_goal: selfProfile?.weekly_goal ?? 3,
      role: 'member',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await this.addDevMembership({
      group_id: DEV_PAIR_GROUP_ID,
      user_id: partnerUser.id,
      weekly_goal: partnerProfile?.weekly_goal ?? 3,
      role: 'member',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  },

  /**
   * UNPAIR (compliance: a user must be able to stop receiving partner UGC).
   * Detaches the current dev user from their partner — BOTH sides return to
   * solo. Removes the pair memberships (only the shared pair group, never any
   * other membership) and resets both pair states; KEEPS each user's workout
   * rows (photos stay per-user isolated); clears the shared team name.
   * Idempotent: already-solo → no-op.
   */
  async unpairDev(userId: string): Promise<void> {
    const state = await this.getPairState(userId);
    const partnerId = state.partner?.id ?? null;
    const both = partnerId ? [userId, partnerId] : [userId];
    for (const uid of both) {
      const memberships = await this.getDevMemberships(uid);
      const kept = memberships.filter((m) => m.group_id !== DEV_PAIR_GROUP_ID);
      await writeValue(`memberships:${uid}`, kept);
      await this.savePairState(uid, { partner: null, accepted: false });
      // V1.1 Build #2 (S slice): the miss promise lives on the pair membership
      // (real mode) — unpair drops that row, so the dev mirror clears it too.
      await this.saveMissPromise(uid, '');
    }
    await this.saveTeamName(null);
  },
};

/** So DEV MOCK and REAL have the same pickup point. Pairs with workouts rows. */
export interface WorkoutRow {
  id: string;
  user_id: string;
  /** Pair group id (mirrors the real workouts.group_id column; dev mock sets
   * DEV_PAIR_GROUP_ID so the row shape matches the real table). */
  group_id?: string | null;
  photo_path: string;
  logged_at: string;
  workout_type: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// SLICE C: dev-mock invites + pairing — a second mock user ("Dev Partner",
// dev_partner@spotter.test) + a pair group, so the two-user invite/accept/feed
// flow is walkable end-to-end with no backend. Clearly labeled; nothing here
// touches the network. Persisted shapes mirror the real `invites`, `groups`
// and `memberships` tables.
// ---------------------------------------------------------------------------

export interface DevInvite {
  id: string;
  inviter_id: string;
  token: string;
  invitee_email: string | null;
  status: 'pending' | 'accepted';
  created_at: string;
  accepted_at: string | null;
}

export interface DevMembership {
  group_id: string;
  user_id: string;
  weekly_goal: number;
  role: 'member' | 'admin';
  created_at: string;
  updated_at: string;
}

/** V1.1: dev-mock weekly result snapshot (mirrors weekly_results). */
export interface WeeklyResultRow {
  user_id: string;
  group_id: string;
  week_start_at: string;
  week_end_at: string;
  weekly_goal_snapshot: number;
  workout_count: number;
  completed: boolean;
  nudge_present: boolean;
}

export const DEV_PARTNER_EMAIL = 'dev_partner@spotter.test';

/** Devices/dev-demo: the preset partner's invite code, seeded with the SAME
 * display format the inviter sees (`DEV-XXXX-XXXX` — see invites.ts
 * formatDevInviteCode). Iterating here means the code shown in the demo
 * matches the code the accept flow resolves, on every device. */
const DEV_PARTNER_CODE = 'ABCD1234';

/** DEV MOCK display: ALWAYS `DEV-XXXX-XXXX`, no matter how the input is passed
 * (raw 8 chars or already `DEV-`-prefixed), so nobody mistakes it for a real
 * code and the 4+4 split always aligns with the REAL format. */
export function formatDevInviteCode(ref: string): string {
  const raw = ref.replace(/^DEV-/i, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const core = raw.slice(-8);
  return `DEV-${core.slice(0, 4)}-${core.slice(4, 8)}`;
}

/** In DEV MOCK, both ourselves and the preset partner share one pair group id,
 * so their logs (both pre-seeded here and captured in-app later) merge into
 * the same shared feed. Keeps the pair story honest without a backend. */
export const DEV_PAIR_GROUP_ID = 'dev-pair-group';