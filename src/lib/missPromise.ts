/**
 * Miss promise — optional personal accountability note (v1.1 Build #2, S slice).
 *
 * "If I miss, I owe you: ___" is a fill-in-the-blank note each member sets for
 * THEMSELVES, ≤80 chars, private to the pair. It is surfaced ONLY if that
 * member misses a week — it is a personal note, NOT a wager or enforcement
 * system, and is never described as one (no betting/stake/debt language).
 *
 * Storage mirrors naming.ts:
 *  - REAL mode: the caller's OWN membership row in the pair group
 *    (`memberships.miss_promise`, nullable; RLS keeps it own-row — the
 *    existing memberships_update_own / memberships_select_own policies already
 *    scope it, so the partner can never read or write your promise in this
 *    build). The user may belong to BOTH their solo "Personal" group and the
 *    pair group (2 members) — the pair group is the one the promise lives on.
 *  - DEV MOCK: a per-user AsyncStorage key through devMock, mirroring the same
 *    own-row isolation; cleared on unpairDev exactly like real unpair drops
 *    the pair membership rows.
 *
 * Reads needed for the own-miss line surface the promise inside
 * `fetchWeeklyContext` (workoutStore.ts → WeeklyContext.missLine); this file
 * owns persistence + the real-mode pair-group resolution for writes.
 */
import { devMock } from './mock';
import { getStoredSession, supabase } from './supabase';

/** Max length enforced both here and by the DB CHECK + TextInput maxLength. */
export const MISS_PROMISE_MAX = 80;

/**
 * Real mode: find the CURRENT user's pair group id — the 2-member group (their
 * solo "Personal" group has 1 member). Same detection used by fetchWeeklyContext
 * and naming.ts, so reads and writes always target the same group.
 */
async function findPairGroupId(): Promise<string | null> {
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
 * Read THIS user's own miss promise (''/null when unset or cleared). Only the
 * owner's own value: REAL mode reads their OWN membership row (own-row RLS);
 * DEV reads the per-user key. The partner's promise is never read in this
 * build (Build #2 S slice — partner MissCard comes later).
 */
export async function getMissPromise(userId?: string): Promise<string | null> {
  const session = userId ? null : await getStoredSession();
  const uid = userId ?? session?.user.id ?? '';
  if (!uid) return null;

  if (session?.isDevMode || !supabase || !session) {
    return devMock.getMissPromise(uid);
  }

  // REAL: own membership row only (RLS scopes to auth.uid()).
  try {
    const { data } = await supabase
      .from('memberships')
      .select('miss_promise')
      .eq('user_id', uid)
      .not('miss_promise', 'is', null)
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