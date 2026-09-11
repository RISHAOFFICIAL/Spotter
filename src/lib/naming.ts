/**
 * Naming feature — optional, non-mandatory display preferences (lead brief).
 *
 * A) PET NAMES — what THIS user calls THEIR CO-MEMBERS. Strictly LOCAL-ONLY:
 *    one AsyncStorage JSON map keyed by the current user id, keyed per member
 *    user id (`spotter.petname:v1:{myId}` → `{ [memberUserId]: name }`), and
 *    NEVER synced to members or the server. Empty/unset = the member's real
 *    first name. The legacy single-string format (v1, one partner) still reads
 *    back: a plain string is treated as a `*` entry so old stored values
 *    survive; the v1 get/setPetName pair remain as the single-primary-member
 *    bridge (used by the current Profile field + dev-mock harness) until S4
 *    moves the Profile to one row per member.
 *
 * B) TEAM NAME — optional shared label on the GROUP (e.g. "Team Us"). This one
 *    IS shared: real mode reads/writes the nullable `groups.team_name` column
 *    (schema.sql `groups_select_member` — any member reads, creator writes);
 *    dev mode stores it on the single dev pair group via devMock.
 *
 * Discovery for the team-name write target (and for the v1 pet-name bridge)
 * runs through the SECURITY DEFINER `my_group()` RPC: memberships RLS exposes
 * only own rows, so raw memberships counting can never see co-members in real
 * mode. my_group resolves only the caller's own shared group (>= 2 members),
 * so stranger isolation is unchanged.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { devMock, DEV_PAIR_GROUP_ID } from './mock';
import { getStoredSession, supabase } from './supabase';
import { parseMyGroup } from './workouts';

/** Per-user local-only key for the pet-name map (never synced). */
const PET_NAME_PREFIX = 'spotter.petname:v1:';

// ---------------------------------------------------------------------------
// A) Pet names — local-only per-member map
// ---------------------------------------------------------------------------

/** Read THIS user's whole pet-name map ({ memberUserId: name }). Never touches members. */
export async function getPetNames(): Promise<Record<string, string>> {
  const session = await getStoredSession();
  if (!session) return {};
  return readPetNameMap(session.user.id);
}

/** Read THIS user's pet name for ONE member ('' when unset). Never touches the member. */
export async function getPetNameFor(memberUserId: string): Promise<string | null> {
  const session = await getStoredSession();
  if (!session) return null;
  const map = await readPetNameMap(session.user.id);
  return map[memberUserId] ?? null;
}

/** Save (or clear, when name is empty) THIS user's pet name for ONE member. Local-only. */
export async function setPetNameFor(memberUserId: string, name: string): Promise<void> {
  const session = await getStoredSession();
  if (!session) return;
  const trimmed = name.trim();
  const map = await readPetNameMap(session.user.id);
  if (trimmed) {
    map[memberUserId] = trimmed;
  } else {
    delete map[memberUserId];
  }
  await writePetNameMap(session.user.id, map);
}

/** Internal map read with v1 plain-string fallback (legacy single-partner era). */
async function readPetNameMap(userId: string): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(`${PET_NAME_PREFIX}${userId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      return out;
    }
    // v1 legacy: the stored value was a bare string (one partner, no id).
    const legacy = (typeof parsed === 'string' ? parsed : raw).trim();
    return legacy ? { '*': legacy } : {};
  } catch {
    return {};
  }
}

async function writePetNameMap(userId: string, map: Record<string, string>): Promise<void> {
  try {
    const keys = Object.keys(map);
    if (keys.length === 0) {
      await AsyncStorage.removeItem(`${PET_NAME_PREFIX}${userId}`);
    } else {
      await AsyncStorage.setItem(`${PET_NAME_PREFIX}${userId}`, JSON.stringify(map));
    }
  } catch {
    // Best-effort local preference; fallbacks already cover a failed write.
  }
}

/**
 * V1 bridge — THIS user's pet name for their PRIMARY co-member (the first of
 * `my_group`'s member_ids; dev: the pair partner). Used by the current single
 * Profile field and the dev-mock harness; S4 moves the UI onto getPetNameFor
 * per member. Returns null when unset.
 */
export async function getPetName(): Promise<string | null> {
  const session = await getStoredSession();
  if (!session) return null;
  const map = await readPetNameMap(session.user.id);
  const primary = await resolvePrimaryPartnerId(session);
  if (primary && map[primary]) return map[primary];
  const values = Object.values(map);
  return values[0] ?? null;
}

/** V1 bridge — save (or clear) THIS user's pet name for the primary co-member. */
export async function setPetName(name: string): Promise<void> {
  const session = await getStoredSession();
  if (!session) return;
  const primary = await resolvePrimaryPartnerId(session);
  if (primary) {
    await setPetNameFor(primary, name);
    return;
  }
  // No co-member yet (solo): preserve the legacy single-string storage so the
  // value round-trips through getPetName and survives a later pairing.
  const trimmed = name.trim();
  try {
    if (trimmed) {
      await AsyncStorage.setItem(`${PET_NAME_PREFIX}${session.user.id}`, trimmed);
    } else {
      await AsyncStorage.removeItem(`${PET_NAME_PREFIX}${session.user.id}`);
    }
  } catch {
    // Best-effort.
  }
}

/** Remove THIS user's pet-name map (account deletion sweeps local preferences). */
export async function clearPetName(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(`${PET_NAME_PREFIX}${userId}`);
  } catch {
    // Best-effort.
  }
}

/** The user's first co-member id (real: my_group.member_ids[0]; dev: pair partner). */
async function resolvePrimaryPartnerId(
  session: Awaited<ReturnType<typeof getStoredSession>>,
): Promise<string | null> {
  if (!session) return null;
  if (session.isDevMode || !supabase) {
    const pair = await devMock.getPairState(session.user.id);
    return pair.partner?.id ?? null;
  }
  const { data, error } = await supabase.rpc('my_group');
  if (error) return null;
  return parseMyGroup(data).member_ids[0] ?? null;
}

// ---------------------------------------------------------------------------
// B) Team name — shared group label
// ---------------------------------------------------------------------------

/**
 * Real mode: find the CURRENT user's SHARED group id (>= 2 members) — the
 * group the feed reads from — so the write targets the same row. Mirrors the
 * same detection used by `fetchWeeklyContext`. Returns null when solo.
 *
 * Discovery runs through the SECURITY DEFINER my_group() RPC (see workoutStore
 * fetchWeeklyContext): memberships RLS hides co-members' seats, so raw
 * memberships counting can never see a shared group in real mode.
 */
async function findSharedGroupId(): Promise<string | null> {
  const session = await getStoredSession();
  if (!session || !supabase) return null;

  const { data, error } = await supabase.rpc('my_group');
  if (error) return null;
  return parseMyGroup(data).group_id;
}

/**
 * Save (or clear, when empty) the group team name. REAL → update the nullable
 * `groups.team_name` on the shared group (RLS: any member reads, only the
 * group creator may write, same as today). DEV → devMock's shared pair-group
 * key. Returns ok/error so the Profile UI can surface a truthful result.
 */
export async function setTeamName(name: string): Promise<{ ok: boolean; error?: string }> {
  const session = await getStoredSession();
  if (!session) return { ok: false, error: 'Sign in first.' };
  const trimmed = name.trim();

  if (session.isDevMode || !supabase) {
    // DEV MOCK — shared pair-group key (mirrors the real groups.team_name).
    await devMock.saveTeamName(trimmed || null);
    return { ok: true };
  }

  // REAL mode — write the group's team_name. RLS only lets the group CREATOR
  // (whoever started the group) write; a non-creator member's update affects 0
  // rows. We detect that and report honestly rather than claiming success.
  try {
    const groupId = await findSharedGroupId();
    if (!groupId) {
      return { ok: false, error: 'Start a group first, then name it.' };
    }
    const { data, error } = await supabase
      .from('groups')
      .update({ team_name: trimmed || null })
      .eq('id', groupId)
      .select('id')
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) {
      return { ok: false, error: 'Only the person who started the group can change its name.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Can't reach server. Try again." };
  }
}

/** Re-export the dev pair group id so callers/tests read the same constant. */
export { DEV_PAIR_GROUP_ID };