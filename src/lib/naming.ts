/**
 * Naming feature — optional, non-mandatory display preferences (lead brief).
 *
 * A) PET NAME — what THIS user calls THEIR partner. Strictly LOCAL-ONLY: it is
 *    a private per-user display preference, stored in AsyncStorage keyed by the
 *    current user id, and NEVER synced to the partner or the server (no schema
 *    change). Empty/unset = current behavior (partner's real first name).
 *
 * B) TEAM NAME — optional shared label on the PAIR group (e.g. "Team Us",
 *    wedding-party name). This one IS shared: real mode reads/writes the new
 *    nullable `groups.team_name` column (schema.sql); dev mode stores it on the
 *    single dev pair group via devMock. Empty/unset = current header.
 *
 * Both fields are strictly optional with safe fallbacks. Reads that need the
 * resolved display values happen inside `fetchWeeklyContext` (workoutStore.ts);
 * this file owns the persistence + the real-mode pair-group resolution for the
 * team-name WRITE path.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { devMock, DEV_PAIR_GROUP_ID } from './mock';
import { getStoredSession, supabase } from './supabase';

/** Per-user local-only key for the pet name (never synced). */
const PET_NAME_PREFIX = 'spotter.petname:v1:';

// ---------------------------------------------------------------------------
// A) Pet name — local-only per-user preference
// ---------------------------------------------------------------------------

/** Read THIS user's saved pet name ('' when unset). Never touches the partner. */
export async function getPetName(): Promise<string | null> {
  const session = await getStoredSession();
  if (!session) return null;
  try {
    const raw = await AsyncStorage.getItem(`${PET_NAME_PREFIX}${session.user.id}`);
    const trimmed = raw?.trim() ?? '';
    return trimmed || null;
  } catch {
    return null;
  }
}

/** Save (or clear, when empty) THIS user's pet name. Local-only. */
export async function setPetName(name: string): Promise<void> {
  const session = await getStoredSession();
  if (!session) return;
  const trimmed = name.trim();
  try {
    if (trimmed) {
      await AsyncStorage.setItem(`${PET_NAME_PREFIX}${session.user.id}`, trimmed);
    } else {
      await AsyncStorage.removeItem(`${PET_NAME_PREFIX}${session.user.id}`);
    }
  } catch {
    // Best-effort local preference; fallbacks already cover a failed write.
  }
}

/** Remove THIS user's pet name (account deletion sweeps local preferences). */
export async function clearPetName(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(`${PET_NAME_PREFIX}${userId}`);
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// B) Team name — shared pair-group label
// ---------------------------------------------------------------------------

/**
 * Real mode: find the CURRENT user's PAIR group id — the group they belong to
 * that has EXACTLY 2 members (their solo "Personal" group has 1). Mirrors the
 * same detection used by `fetchWeeklyContext` so the write targets the same
 * group the feed reads from. Returns null when unpaired.
 *
 * Discovery runs through the SECURITY DEFINER my_pair() RPC (see workoutStore
 * fetchWeeklyContext): memberships RLS hides the partner's seat, so raw
 * memberships counting can never see a 2-member group in real mode.
 */
async function findPairGroupId(): Promise<string | null> {
  const session = await getStoredSession();
  if (!session || !supabase) return null;

  const { data, error } = await supabase.rpc('my_pair');
  if (error) return null;
  const pair =
    ((typeof data === 'string' ? (JSON.parse(data || '{}') as unknown) : data) as unknown) as {
      pair_group_id?: string | null;
    } | null;
  return pair?.pair_group_id ?? null;
}

/**
 * Save (or clear, when empty) the pair team name. REAL → update the nullable
 * `groups.team_name` on the pair group (RLS: only the group creator may write,
 * same as today). DEV → devMock's shared pair-group key. Returns ok/error so
 * the Profile UI can surface a truthful result.
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

  // REAL mode — write the pair group's team_name (additive nullable column).
  // NOTE: existing groups_update_own RLS only lets the group CREATOR (the
  // inviter) write; a paired invitee's update affects 0 rows. We detect that
  // and report honestly rather than claiming success. No policy changes here
  // (per the brief's additive-only constraint).
  try {
    const pairGroupId = await findPairGroupId();
    if (!pairGroupId) {
      return { ok: false, error: 'Pair up with a partner first, then name your team.' };
    }
    const { data, error } = await supabase
      .from('groups')
      .update({ team_name: trimmed || null })
      .eq('id', pairGroupId)
      .select('id')
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) {
      return { ok: false, error: 'Only the person who sent the invite can change the team name.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Can't reach server. Try again." };
  }
}

/** Re-export the dev pair group id so callers/tests read the same constant. */
export { DEV_PAIR_GROUP_ID };
