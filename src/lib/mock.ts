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
    // S5: the designated 3-person demo account seeds its full group on first
    // signup so dev mode can walk a real 3-member group end-to-end. Idempotent
    // (and a no-op for every other email — the solo/pair paths stay untouched).
    if (email === DEV_GROUP_DEMO_EMAIL) {
      await this.getOrSeedDemoGroup(user.id);
    }
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
   * Optional shared group TEAM NAME (naming feature B). Scoped by group id —
   * mirrors the real `groups.team_name` column, so the 2-person pair group
   * (DEV_PAIR_GROUP_ID) and the seeded 3-person demo group (DEV_DEMO_GROUP_ID)
   * each carry their own name. Null when unset (UI falls back to the member
   * names). The no-arg call keeps the legacy pair-group default so existing
   * callers/tests read the pair key without changes.
   */
  async getTeamName(groupId: string = DEV_PAIR_GROUP_ID): Promise<string | null> {
    return readValue<string>(`teamName:${groupId}`);
  },
  async saveTeamName(name: string | null, groupId: string = DEV_PAIR_GROUP_ID): Promise<void> {
    const trimmed = name?.trim() ?? '';
    if (trimmed) {
      await writeValue(`teamName:${groupId}`, trimmed);
    } else {
      await AsyncStorage.removeItem(`${STORE_PREFIX}teamName:${groupId}`);
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
  /**
   * Treats/Promises ledger: the note is "to" this witness (the dev mirror of
   * memberships.miss_witness_id; null = not chosen yet).
   */
  async getMissWitnessId(userId: string): Promise<string | null> {
    return readValue<string>(`missWitness:${userId}`);
  },
  async saveMissWitness(userId: string, witnessId: string | null): Promise<void> {
    if (witnessId) {
      await writeValue(`missWitness:${userId}`, witnessId);
    } else {
      await AsyncStorage.removeItem(`${STORE_PREFIX}missWitness:${userId}`);
    }
  },
  /**
   * Treats/Promises ledger note-set write path — the dev mirror of the REAL
   * `set_miss_note` RPC (same validation/raise semantics, and the error
   * strings VERBATIM from the RPC raises so dev/real behave identically):
   *   - trim + <=80 (over-length -> 'keep it under 80 characters');
   *   - empty -> clears BOTH the note and the witness, returns ok;
   *   - exactly 2 members -> the witness AUTO-RESOLVES to the other member
   *     (any passed witnessId is ignored);
   *   - 3+ members -> the witnessId must be a current co-member != self
   *     (else 'choose who this promise is to');
   *   - solo -> 'pair up with someone first' — the ledger entry point is
   *     hidden for solo users anyway.
   */
  async saveMissNote(
    userId: string,
    text: string,
    witnessId: string | null,
  ): Promise<{ ok: boolean; error?: string; witnessId?: string | null }> {
    const trimmed = text.trim();
    if (trimmed.length > 80) {
      return { ok: false, error: 'keep it under 80 characters' };
    }
    if (!trimmed) {
      await this.saveMissPromise(userId, '');
      await this.saveMissWitness(userId, null);
      return { ok: true, witnessId: null };
    }
    const shared = await this.findSharedDevGroup(userId);
    if (!shared) {
      return { ok: false, error: 'pair up with someone first' };
    }
    let witness: string;
    if (shared.members.length <= 2) {
      // Exactly 2 members -> the other member (auto-resolve; ignore input).
      witness = shared.member_ids[0];
    } else {
      if (!witnessId || witnessId === userId || !shared.member_ids.includes(witnessId)) {
        return { ok: false, error: 'choose who this promise is to' };
      }
      witness = witnessId;
    }
    await this.saveMissPromise(userId, trimmed);
    await this.saveMissWitness(userId, witness);
    return { ok: true, witnessId: witness };
  },
  // ---- Treats/Promises ledger store (pair-private, dev mirror of the REAL
  //      promise_entries table + record_missed_promise / resolve_promise RPCs).

  /** RAW store accessor — harness/parity hook ONLY; the app lib never calls it. */
  async listPromiseEntries(): Promise<DevPromiseEntry[]> {
    return (await readValue<DevPromiseEntry[]>('promiseEntries')) ?? [];
  },
  async savePromiseEntries(rows: DevPromiseEntry[]): Promise<void> {
    await writeValue('promiseEntries', rows);
  },
  /** Pair-scoped ledger read (mirror of the RLS pair-column select policy): a
   * user sees ONLY rows where they are the maker OR the witness. */
  async listLedgerFor(userId: string): Promise<DevPromiseEntry[]> {
    const rows = await this.listPromiseEntries();
    return rows
      .filter((r) => r.user_id === userId || r.witness_id === userId)
      .sort((a, b) => (a.week_start < b.week_start ? 1 : a.week_start > b.week_start ? -1 : 0));
  },
  /**
   * Dev mirror of the REAL record_missed_promise RPC:
   *   - solo / no shared group -> {ok, created:false} (silent, never shaming);
   *   - no note set -> {ok, created:false};
   *   - witness unset OR stale (no longer a co-member) OR a stranger ->
   *     THROWS 're-pick who your promise is to' and creates NOTHING;
   *   - unique (membership_id, week_start) -> second call for the same week
   *     is a no-op ({ok, created:false}).
   */
  async recordMissedPromise(userId: string, weekStart: string): Promise<{ ok: true; created: boolean }> {
    const shared = await this.findSharedDevGroup(userId);
    if (!shared) return { ok: true, created: false };
    const note = await this.getMissPromise(userId);
    const witness = await this.getMissWitnessId(userId);
    if (!note || !witness) return { ok: true, created: false };
    // Re-validate the witness is a CURRENT co-member != self (security-definer
    // read in real mode; this closes the stranger-witness leak vector).
    if (witness === userId || !shared.member_ids.includes(witness)) {
      throw new Error('re-pick who your promise is to');
    }
    const rows = await this.listPromiseEntries();
    const membershipId = `${shared.group_id}:${userId}`;
    if (rows.some((r) => r.membership_id === membershipId && r.week_start === weekStart)) {
      return { ok: true, created: false };
    }
    const nowIso = new Date().toISOString();
    rows.push({
      id: `prom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      membership_id: membershipId,
      user_id: userId,
      witness_id: witness,
      promise_text: note,
      week_start: weekStart,
      state: 'open',
      created_at: nowIso,
      updated_at: nowIso,
    });
    await this.savePromiseEntries(rows);
    return { ok: true, created: true };
  },
  /**
   * Dev mirror of the REAL resolve_promise RPC — promise-MAKER ONLY (the
   * witness gets NO resolve tap; a witness calling on the maker's entry throws
   * the maker-only error). Only open -> kept / let_go; anything else throws.
   */
  async resolvePromise(userId: string, entryId: string, state: 'kept' | 'let_go'): Promise<{ ok: true }> {
    const rows = await this.listPromiseEntries();
    const entry = rows.find((r) => r.id === entryId);
    // Non-existent id is indistinguishable from someone else's entry (privacy).
    if (!entry || entry.user_id !== userId) {
      throw new Error('only the person who made this promise can settle it');
    }
    if (state !== 'kept' && state !== 'let_go') {
      throw new Error('invalid settle state');
    }
    if (entry.state !== 'open') {
      throw new Error('already settled');
    }
    entry.state = state;
    entry.updated_at = new Date().toISOString();
    await this.savePromiseEntries(rows);
    return { ok: true };
  },
  // ---- V1.1 BUILD #3 (slice 1): notification preferences + push devices ----

  /**
   * Read one user's notification preferences. Mirrors the real
   * `notification_preferences` row (one per user, lazily created). When the
   * row does not exist yet, the schema defaults apply (master + invite_accepted
   * + partner_logged + pending_invite ON, missed_week OFF) — identical to the
   * real table defaults, so reads are consistent before a row is written.
   */
  async getNotificationPrefs(
    userId: string,
  ): Promise<NotificationPrefsRow> {
    const stored = await readValue<Partial<NotificationPrefsRow>>(`notifPrefs:${userId}`);
    const base: NotificationPrefsRow = {
      user_id: userId,
      master_enabled: true,
      invite_accepted_enabled: true,
      partner_logged_enabled: true,
      missed_week_enabled: false,
      pending_invite_enabled: true,
      updated_at: stored?.updated_at ?? new Date().toISOString(),
    };
    return { ...base, ...stored, user_id: userId };
  },
  /** Persist one user's notification preferences (lazy-create on first write). */
  async saveNotificationPrefs(userId: string, prefs: NotificationPrefsRow): Promise<void> {
    await writeValue(`notifPrefs:${userId}`, { ...prefs, user_id: userId, updated_at: new Date().toISOString() });
  },
  /** List the push devices registered for one user (mirrors push_devices). */
  async listPushDevices(userId: string): Promise<DevPushDevice[]> {
    return (await readValue<DevPushDevice[]>(`pushDevices:${userId}`)) ?? [];
  },
  /**
   * Register (or refresh) one push device. Mirrors the REAL upsert semantics:
   * `expo_push_token` is globally UNIQUE and the row is upserted onConflict
   * token with user_id attached — re-registering the same token on the same
   * user is IDEMPOTENT (row replaced, last_seen_at refreshed), never a dup.
   */
  async upsertPushDevice(userId: string, device: DevPushDevice): Promise<void> {
    const rows = (await readValue<DevPushDevice[]>(`pushDevices:${userId}`)) ?? [];
    const idx = rows.findIndex((r) => r.expo_push_token === device.expo_push_token);
    if (idx >= 0) {
      // Idempotent re-register: preserve `created_at` (mirrors the REAL upsert,
      // which omits created_at on conflict so the DB default survives — only
      // last_seen_at + the other fields refresh). Without this the dev mock
      // rewrites created_at each call, making step n's "created_at stable"
      // assertion race on the millisecond boundary.
      device.created_at = rows[idx].created_at;
      rows[idx] = device;
    } else {
      rows.push(device);
    }
    await writeValue(`pushDevices:${userId}`, rows);
  },
  // ---- V1.1 BUILD #3 (slice 2): dev-mock push_deliveries log ---------------

  /**
   * Dev-mock delivery log (mirrors the REAL push_deliveries table — shape +
   * UNIQUE dedupe_key semantics; stored per RECIPIENT user, so the smoke
   * harness can drive cross-user sends exactly like the real per-user keys).
   */
  async listPushDeliveries(userId: string): Promise<DevPushDelivery[]> {
    return (await readValue<DevPushDelivery[]>(`pushDeliveries:${userId}`)) ?? [];
  },
  async savePushDeliveries(userId: string, rows: DevPushDelivery[]): Promise<void> {
    await writeValue(`pushDeliveries:${userId}`, rows);
  },
  /** Clear one user's delivery log (smoke reset between phases). */
  async clearPushDeliveries(userId: string): Promise<void> {
    await AsyncStorage.removeItem(`${STORE_PREFIX}pushDeliveries:${userId}`);
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
          key === `${STORE_PREFIX}notifPrefs:${userId}` ||
          key === `${STORE_PREFIX}pushDevices:${userId}` ||
          key === `${STORE_PREFIX}pushDeliveries:${userId}` ||
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
   * All membership rows across EVERY dev user for one group (the dev stand-in
   * for the real memberships table's group-scoped reads — RLS in real mode
   * keeps this server-side; the dev store scans the per-user keys).
   */
  async getGroupMembers(groupId: string): Promise<DevMembership[]> {
    const keys = await AsyncStorage.getAllKeys();
    const rows: DevMembership[] = [];
    for (const key of keys ?? []) {
      if (!key.startsWith(`${STORE_PREFIX}memberships:`)) continue;
      const userRows = (await readValue<DevMembership[]>(key.slice(STORE_PREFIX.length))) ?? [];
      for (const r of userRows) {
        if (r.group_id === groupId) rows.push(r);
      }
    }
    return rows;
  },

  /**
   * Resolve the CURRENT user's shared dev group (>= 2 members) — the dev mirror
   * of the real `my_group()` RPC (same "most recent membership wins" rule, so a
   * user with a leftover personal membership still resolves their pair/group).
   * Returns the group id, co-member ids in membership order (excludes self) and
   * ALL membership rows (members, sorted by created_at asc); null when solo.
   */
  async findSharedDevGroup(userId: string): Promise<{
    group_id: string;
    member_ids: string[];
    member_count: number;
    members: DevMembership[];
  } | null> {
    const mine = await this.getDevMemberships(userId);
    const sorted = [...mine].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    for (const m of sorted) {
      const members = (await this.getGroupMembers(m.group_id)).sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
      );
      if (members.length >= 2) {
        const co = members.filter((x) => x.user_id !== userId);
        return {
          group_id: m.group_id,
          member_ids: co.map((x) => x.user_id),
          member_count: co.length,
          members,
        };
      }
    }
    return null;
  },

  /**
   * A dev user's display name — their local profile name when set, else their
   * email prefix (the dev stand-in for `users.name`: the REAL first name, never
   * a pet name). Used wherever real mode reads users.name (found-screen
   * inviter name, seed member names). Null when the user does not exist.
   */
  async getDisplayName(userId: string): Promise<string | null> {
    const profile = await this.getProfile(userId);
    if (profile?.name?.trim()) return profile.name.trim();
    const user = await this.getUserById(userId);
    if (!user) return null;
    return user.email.split('@')[0] || null;
  },

  /**
   * S5 multi-member seed: a full 3-person DEV group — you + two fixed co-members
   * with distinct real first names, a team name, and a realistic workout
   * history (you 2, Maya 1, Jules 0) so every feed/ring/Profile state is
   * distinguishable. The seeding user is the group creator (role 'admin',
   * mirroring groups.creator_id = whoever started the group). The creating
   * user's local pet-name map is pre-seeded so the pet-name rows render
   * pre-filled in Profile. Idempotent: once the group exists, re-runs are
   * no-ops (a user who left the group stays solo — their leave is respected).
   * The switch is the designated demo email (DEV_GROUP_DEMO_EMAIL) at signup
   * OR an explicit call by the harness (S6) — every other dev user still gets
   * the solo/pair paths unchanged.
   */
  async getOrSeedDemoGroup(userId: string): Promise<void> {
    const existing = await this.getGroupMembers(DEV_DEMO_GROUP_ID);
    if (existing.length > 0) return;
    const nowMs = Date.now();
    const iso = (offsetMs: number) => new Date(nowMs - offsetMs).toISOString();
    const self = await this.getUserById(userId);

    // Two fixed co-members, stored as real dev users so a tester can also sign
    // in as them (`maya@spotter.test` / `jules@spotter.test`) and see the
    // non-creator view.
    const memberB = DEV_DEMO_MEMBER_B;
    const memberC = DEV_DEMO_MEMBER_C;
    for (const member of [memberB, memberC]) {
      await writeValue(`user:${member.email}`, {
        id: member.id,
        email: member.email,
        createdAt: iso(3 * 3600_000),
      });
      await writeValue(`profile:${member.id}`, {
        id: member.id,
        email: member.email,
        name: member.name,
        week_start_day: 'Mon',
        timezone: 'UTC',
        weekly_goal: 3,
        onboarded_at: iso(3 * 3600_000),
      });
    }

    // Memberships: creator (you) oldest, then Maya, then Jules — membership
    // order drives Profile rows + "waiting on…" copy (same as my_group's order).
    await this.addDevMembership({
      group_id: DEV_DEMO_GROUP_ID,
      user_id: userId,
      weekly_goal: 3,
      role: 'admin',
      created_at: iso(3 * 3600_000),
      updated_at: iso(3 * 3600_000),
    });
    for (const member of [memberB, memberC]) {
      await this.addDevMembership({
        group_id: DEV_DEMO_GROUP_ID,
        user_id: member.id,
        weekly_goal: 3,
        role: 'member',
        created_at: iso(2 * 3600_000),
        updated_at: iso(2 * 3600_000),
      });
    }

    // Workout history: you 2, Maya 1, Jules 0 — all < 24h old so every seeded
    // log is inside the current week for any week-start day (ring/feed states
    // are distinguishable from the first render). Rows carry the dual-capture
    // shape (selfie + environment + caption) so the new feed card renders its
    // two-thumb layout from the very first render.
    const seededLog = (id: string, uid: string, photo: string, offsetMs: number, workoutType: string | null, caption: string | null = null) => {
      const t = iso(offsetMs);
      return { id, user_id: uid, group_id: DEV_DEMO_GROUP_ID, photo_path: photo, photo_env: photo.replace('.jpg', '-env.jpg'), caption, logged_at: t, workout_type: workoutType, created_at: t };
    };
    await this.saveWorkouts(userId, [
      seededLog('dev_demo_self_w1', userId, 'mock://dev/run.jpg', 2 * 3600_000, 'Run', 'Mile repeats done'),
      seededLog('dev_demo_self_w2', userId, 'mock://dev/lift.jpg', 20 * 3600_000, 'Lift'),
    ]);
    await this.saveWorkouts(memberB.id, [
      seededLog('dev_demo_maya_w1', memberB.id, 'mock://dev/maya-cycle.jpg', 5 * 3600_000, 'Cycle', 'Leg day \u2014 Ouch'),
    ]);

    // Shared team name + the creating user's local pet names for both members
    // (same keys naming.ts reads, so they render immediately).
    await this.saveTeamName(DEV_DEMO_TEAM_NAME, DEV_DEMO_GROUP_ID);
    if (self) {
      try {
        await AsyncStorage.setItem(
          `spotter.petname:v1:${self.id}`,
          JSON.stringify({ [memberB.id]: memberB.petName, [memberC.id]: memberC.petName }),
        );
      } catch {
        // Best-effort local preference.
      }
    }
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
          photo_env: 'mock://partner/run-env.jpg',
          caption: 'Lungs felt great today',
          logged_at: new Date(now - 5400_000).toISOString(),
          workout_type: 'Run',
          created_at: new Date(now - 5400_000).toISOString(),
        },
        {
          id: `dev_partner_w2`,
          user_id: partner.id,
          photo_path: 'mock://partner/lift.jpg',
          photo_env: 'mock://partner/lift-env.jpg',
          caption: null,
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
    // the feed reads the pair group; weekly goal stays per user). The INVITER
    // is the group creator (role 'admin', mirroring groups.creator_id — real
    // join_group seats the joiner in the inviter's group, creator unchanged);
    // the acceptor joins as a member.
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
      role: 'admin',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  },

  /**
   * UNPAIR / LEAVE GROUP (compliance: a user must be able to stop receiving
   * member UGC). Resolves the user's CURRENT shared dev group (the same
   * membership-driven discovery the store uses — a 2-person pair OR the seeded
   * 3-person demo group) and removes their seat:
   *   - 2-member group → dissolves (both sides return to solo, memberships +
   *     pair state removed, the shared team name clears) — mirrors real
   *     leave_group's dissolve-at-2 rule.
   *   - ≥3-member group → the group survives; only the leaver's membership +
   *     pair state go (creator/reassignment handled server-side in real mode;
   *     the dev group keeps its admin row). Team name survives with the group.
   * KEEPS the user's own workout rows (photos stay per-user isolated).
   * Idempotent: already-solo → no-op.
   */
  async unpairDev(userId: string): Promise<void> {
    const shared = await this.findSharedDevGroup(userId);
    if (!shared) return;
    const groupId = shared.group_id;
    const removeMembership = async (uid: string) => {
      const memberships = await this.getDevMemberships(uid);
      await writeValue(`memberships:${uid}`, memberships.filter((m) => m.group_id !== groupId));
      // V1.1 Build #2 (S slice): the miss promise lives on the membership row
      // (real mode) — leave_group/unpair drops that row, so the dev mirror
      // clears it for every affected user too.
      await this.saveMissPromise(uid, '');
      // Treats/Promises ledger: the note's "to" witness rides the same row —
      // cleared with it. Entries the user MADE in this group cascade with
      // their membership row (real FK: promise_entries.membership_id ON DELETE
      // CASCADE); entries where they were only the WITNESS stay intact and
      // selectable (snapshot semantics — assumption 4).
      await this.saveMissWitness(uid, null);
      const ledgerRows = await this.listPromiseEntries();
      await this.savePromiseEntries(ledgerRows.filter((r) => r.membership_id !== `${groupId}:${uid}`));
    };
    if (shared.members.length <= 2) {
      // Dissolve: both members return to solo.
      const both = [userId, ...shared.members.filter((m) => m.user_id !== userId).map((m) => m.user_id)];
      for (const uid of both) {
        await removeMembership(uid);
        await this.savePairState(uid, { partner: null, accepted: false });
      }
      await this.saveTeamName(null, groupId);
    } else {
      // Group survives: only the leaver's seat + pair state go.
      await removeMembership(userId);
      await this.savePairState(userId, { partner: null, accepted: false });
    }
  },
};

/** So DEV MOCK and REAL have the same pickup point. Pairs with workouts rows. */
export interface WorkoutRow {
  id: string;
  user_id: string;
  /** Pair group id (mirrors the real workouts.group_id column; dev mock sets
   * DEV_PAIR_GROUP_ID so the row shape matches the real table). */
  group_id?: string | null;
  /** Selfie proof path (local file in dev, storage path in real). */
  photo_path: string;
  /** Environment-shot path (v1.0 dual-capture, always UNFILTERED). Null on
   * legacy/seed rows that predate dual-capture — mirrors real photo_env. */
  photo_env?: string | null;
  /** Optional caption (≤140 chars, product cap) — mirrors real caption. */
  caption?: string | null;
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

/**
 * Treats/Promises ledger: dev-mock promise entry (mirrors the REAL
 * `promise_entries` table — same columns + the pair-column visibility rule:
 * a row is readable ONLY by user_id (maker) or witness_id (snapshotted
 * witness), never the whole group). Writes are RPC-only in the real schema;
 * the dev mock exposes no direct insert path through the lib (the raw
 * `listPromiseEntries` accessor exists ONLY as a harness/parity check hook).
 */
export interface DevPromiseEntry {
  id: string;
  membership_id: string;
  user_id: string;
  witness_id: string;
  promise_text: string;
  week_start: string;
  state: 'open' | 'kept' | 'let_go';
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

/**
 * V1.1 Build #3: dev-mock notification preferences row (mirrors the REAL
 * `notification_preferences` table — same columns + schema defaults).
 */
export interface NotificationPrefsRow {
  user_id: string;
  master_enabled: boolean;
  invite_accepted_enabled: boolean;
  partner_logged_enabled: boolean;
  missed_week_enabled: boolean;
  pending_invite_enabled: boolean;
  updated_at: string;
}

/** V1.1 Build #3: dev-mock push-device row (mirrors the REAL `push_devices`
 * table — token is globally unique, user owns the row). */
export interface DevPushDevice {
  user_id: string;
  expo_push_token: string;
  platform: string;
  app_version: string;
  last_seen_at: string;
  created_at: string;
}

/** V1.1 Build #3 (slice 2): dev-mock push_deliveries row (mirrors the REAL
 * `push_deliveries` table — dedupe_key UNIQUE per recipient user store). */
export interface DevPushDelivery {
  id: string;
  user_id: string;
  dedupe_key: string;
  kind: string;
  status: string;
  suppressed_reason: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
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

// ---------------------------------------------------------------------------
// S5: the multi-member DEV demo group — a full 3-person group (you + 2 fixed
// co-members) so dev mode behaves like a real group end-to-end. Seeded by
// `devMock.getOrSeedDemoGroup(userId)`, which the designated demo email
// (`crew@spotter.test`) triggers at signup; every other dev email keeps the
// solo/pair paths unchanged. See the method doc for the full shape.
// ---------------------------------------------------------------------------

/** The 3-person demo group's id (distinct from the 2-person pair group). */
export const DEV_DEMO_GROUP_ID = 'dev-demo-group';

/** Signing up with this email in dev mode seeds the full 3-person demo group
 * (the switch — "separate dev user"). */
export const DEV_GROUP_DEMO_EMAIL = 'crew@spotter.test';

/** Seeded co-members: real first names Maya & Jules, distinct pet names for the
 * creating user's local map. Fixed ids (like the preset partner) so the demo is
 * deterministic; both are stored as real dev users, so signing in as
 * `maya@spotter.test` / `jules@spotter.test` shows the co-member (non-creator)
 * view. */
const DEV_DEMO_MEMBER_B = { id: 'dev_member_maya', email: 'maya@spotter.test', name: 'Maya', petName: 'Coach' };
const DEV_DEMO_MEMBER_C = { id: 'dev_member_jules', email: 'jules@spotter.test', name: 'Jules', petName: 'Stretch' };

/** The seeded demo group's shared team name (feed header + Profile). */
export const DEV_DEMO_TEAM_NAME = 'Crew Volt';