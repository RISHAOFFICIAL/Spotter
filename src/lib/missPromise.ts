/**
 * Miss promise — optional personal accountability note (v1.1 Build #2).
 *
 * "If I miss, I owe you: ___" is a fill-in-the-blank note each member sets for
 * THEMSELVES, ≤80 chars, private to the pair. It is surfaced ONLY if that
 * member misses a week — it is a personal note, NOT a wager or enforcement
 * system, and is never described as one (no betting/stake/debt language).
 *
 * Storage mirrors naming.ts:
 *  - REAL mode: the member's membership row in the pair group
 *    (`memberships.miss_promise`, nullable). OWN row: own-row RLS. PARTNER's
 *    row: the pair-scoped `memberships_select_pair` policy (schema.sql —
 *    mirrors workouts_select_pair; read-only, same 2-member shape), which is
 *    what powers the partner MissCard (M slice). Writes stay strictly own-row:
 *    memberships_update_own requires auth.uid() = user_id, so nobody can ever
 *    write their partner's promise.
 *  - DEV MOCK: a per-user AsyncStorage key through devMock, mirroring the same
 *    shape; the partner's key is readable through getPartnerMissPromise (dev
 *    parity for the pair-scoped read). Cleared on unpairDev exactly like real
 *    unpair drops the pair membership rows.
 *
 * Reads needed for the own-miss line + partner MissCard surface inside
 * `fetchWeeklyContext` (workoutStore.ts → WeeklyContext.missLine /
 * partnerMissCard); this file owns persistence + promise accessors.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { devMock } from './mock';
import { getStoredSession, supabase } from './supabase';

/** Max length enforced both here and by the DB CHECK + TextInput maxLength. */
export const MISS_PROMISE_MAX = 80;

/**
 * Pairing-time sheet once-flag (M slice). The setup prompt ("If you miss a
 * week…") is offered once per user — right after pairing completes — and Save
 * OR Skip both count as "seen", so it never re-asks. Stored per user in
 * AsyncStorage (NOT the memberships table): it is a LOCAL prompted-once flag,
 * identical in dev and real mode (no network, no RLS involvement).
 *
 * Exported from the lib (not only the sheet) so the smoke harness can prove
 * the skip-flow: flag unset → prompt allowed; flagged → re-show suppressed;
 * cleared → re-armed (dev parity for re-runs).
 */
const PROMPTED_PREFIX = 'spotter.missprompt:v1:';

/** True when this user has already seen the pairing-time sheet (either path). */
export async function hasSeenMissPrompt(): Promise<boolean> {
  const session = await getStoredSession().catch(() => null);
  if (!session) return true; // No session → don't prompt; a signed-in check owns this.
  try {
    return (await AsyncStorage.getItem(`${PROMPTED_PREFIX}${session.user.id}`)) === '1';
  } catch {
    return true; // Storage failure → fail silent, never nag.
  }
}

/** Mark the sheet as shown for the current user (Save OR Skip both count). */
export async function markMissPromptSeen(): Promise<void> {
  try {
    const session = await getStoredSession().catch(() => null);
    if (session) await AsyncStorage.setItem(`${PROMPTED_PREFIX}${session.user.id}`, '1');
  } catch {
    // Best-effort local flag; the sheet is optional either way.
  }
}

/** Test hook: clear the once-flag for the current user (smoke skip-flow). */
export async function clearMissPromptSeen(): Promise<void> {
  try {
    const session = await getStoredSession().catch(() => null);
    if (session) await AsyncStorage.removeItem(`${PROMPTED_PREFIX}${session.user.id}`);
  } catch {
    // Best-effort.
  }
}

/**
 * Real mode: find the CURRENT user's pair group id — the 2-member group (their
 * solo "Personal" group has 1 member). Same detection used by fetchWeeklyContext
 * and naming.ts, so reads and writes always target the same group. Exported
 * for the MissCard read path (the partner row lives in the same pair group).
 */
export async function findPairGroupId(): Promise<string | null> {
  const session = await getStoredSession();
  if (!session || !supabase) return null;

  const { data: myMemberships } = await supabase
    .from('memberships')
    .select('group_id')
    .eq('user_id', session.user.id);
  const myGroupIds = (myMemberships ?? []).map((m) => m.group_id);
  if (myGroupIds.length === 0) return null;

  const { data: groupMems } = await supabase
    .from('memberships')
    .select('group_id, user_id')
    .in('group_id', myGroupIds);
  const byGroup = new Map<string, string[]>();
  for (const m of groupMems ?? []) {
    const list = byGroup.get(m.group_id) ?? [];
    list.push(m.user_id);
    byGroup.set(m.group_id, list);
  }
  for (const [groupId, userIds] of byGroup.entries()) {
    if (userIds.length === 2) return groupId;
  }
  return null;
}

/**
 * Read the CURRENT user's own miss promise (''/null when unset or cleared).
 * Session-scoped like the other lib accessors (naming.ts): REAL mode reads the
 * caller's OWN membership row (own-row RLS); DEV reads the per-user key.
 */
export async function getMissPromise(): Promise<string | null> {
  const session = await getStoredSession();
  if (!session) return null;
  const uid = session.user.id;

  if (session.isDevMode || !supabase) {
    return devMock.getMissPromise(uid);
  }

  // REAL: own membership row only (RLS scopes to auth.uid()).
  try {
    const { data } = await supabase
      .from('memberships')
      .select('miss_promise')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const trimmed = data?.miss_promise?.trim() ?? '';
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Save (or clear, when empty) THIS user's own miss promise. Trim, enforce
 * ≤80 chars (over-length → error, nothing persisted), empty → clear.
 *
 * REAL: update ONLY the current user's OWN membership row of the pair group
 * (the existing memberships_update_own RLS requires auth.uid() = user_id, so
 * this can never touch the partner's row). Unlike team_name, BOTH members may
 * write their own promise — no creator-only quirk. Returns ok/error so the
 * Profile UI can surface a truthful result.
 */
export async function setMissPromise(text: string): Promise<{ ok: boolean; error?: string }> {
  const session = await getStoredSession();
  if (!session) return { ok: false, error: 'Sign in first.' };
  const trimmed = text.trim();
  if (trimmed.length > MISS_PROMISE_MAX) {
    return { ok: false, error: `Keep it under ${MISS_PROMISE_MAX} characters.` };
  }

  if (session.isDevMode || !supabase) {
    // DEV MOCK — per-user key (mirrors the real membership column).
    await devMock.saveMissPromise(session.user.id, trimmed);
    return { ok: true };
  }

  // REAL: update my own row in the pair group. null clears (empty string is
  // stored as null to match "cleared"); the pair-group id is required because
  // the promise lives on the pair membership, never the solo "Personal" one.
  try {
    const pairGroupId = await findPairGroupId();
    if (!pairGroupId) {
      return { ok: false, error: 'Pair up with a partner first — the miss note belongs to your pair.' };
    }
    const { error } = await supabase
      .from('memberships')
      .update({ miss_promise: trimmed || null })
      .eq('user_id', session.user.id)
      .eq('group_id', pairGroupId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch {
    return { ok: false, error: "Can't reach server. Try again." };
  }
}

/**
 * Read the PARTNER's miss promise (null when unset, cleared, or unpaired).
 * V1.1 Build #2 (M slice) — the MissCard read path: the promise is the
 * partner's OWN note, surfaced to the caller ONLY when the partner missed a
 * week (the caller in workoutStore checks that condition separately).
 *
 * REAL: reads the partner's membership row in the shared pair group via the
 * pair-scoped `memberships_select_pair` RLS policy (read-only mirror of
 * workouts_select_pair — same 2-member shape). The row belongs to the pair
 * group, never the solo "Personal" group. Writes stay strictly own-row, so
 * this accessor can never modify the partner's promise.
 * DEV: reads the partner's per-user devMock key (parity for the pair read;
 * the dev pair group is shared between both sides by construction).
 */
export async function getPartnerMissPromise(partnerId: string, pairGroupId: string | null): Promise<string | null> {
  const session = await getStoredSession();
  if (!session || !partnerId) return null;

  if (session.isDevMode || !supabase) {
    // DEV MOCK — the partner's own key (mirrors the pair-scoped membership
    // read; the dev pair is one shared group, so no group scoping is needed).
    return devMock.getMissPromise(partnerId);
  }

  if (!pairGroupId) return null;
  try {
    const { data } = await supabase
      .from('memberships')
      .select('miss_promise')
      .eq('user_id', partnerId)
      .eq('group_id', pairGroupId)
      .maybeSingle();
    const trimmed = data?.miss_promise?.trim() ?? '';
    return trimmed || null;
  } catch {
    return null;
  }
}