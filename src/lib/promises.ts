/**
 * Treats/Promises ledger client (owner decision 2026-09-11, rev 13 —
 * pair-private). THE locked rule: every promise entry is visible ONLY to the
 * promise-maker and their ONE snapshotted witness — never the whole group, at
 * any group size. Real mode enforces this server-side (promise_entries RLS =
 * a single pair-column select policy + RPC-only writes); the dev mock mirrors
 * the same semantics on the local store.
 *
 * - recordMissedPromise(weekStart): called at week rollover when the maker
 *   missed (idempotent; silent no-op when no note is set — never shaming).
 * - resolvePromise(entryId, state): maker-only settle (witness is passive).
 * - fetchLedger(): pair-scoped read, newest week first, names resolved from
 *   the weekly context's member map ("A member" fallback — never crashes).
 * - getOpenPromiseCount(): badges = open entries where I am maker OR witness
 *   (maker ≠ witness always, so no double count).
 *
 * COPY (verbatim — §4 of the build spec; curly apostrophes, no "partner", no
 * monetary language). Exported here so the screen, the Profile row and the
 * smoke harness all read the EXACT string from one place.
 */
import { getStoredSession, supabase } from './supabase';
import { devMock, type DevPromiseEntry } from './mock';
import { fetchWeeklyContext } from './workoutStore';

export type PromiseState = 'open' | 'kept' | 'let_go';

/** A ledger row as the UI renders it (names resolved, snake→camel). */
export interface LedgerEntry {
  id: string;
  /** The promise-maker (the member who missed the week). */
  makerId: string;
  /** The snapshotted witness (the person the promise is "to"). */
  witnessId: string;
  promiseText: string;
  weekStart: string;
  state: PromiseState;
  createdAt: string;
  updatedAt: string;
  makerName: string;
  witnessName: string;
}

// §4 verbatim copy strings — single source for the screen + Profile row.
export const PROMISES_SCREEN_TITLE = 'Promises';
export const PROMISES_SCREEN_SUBTITLE =
  'Only you and the person it\u2019s to can see a promise — no one else in your group.';
export const LEDGER_FRAMING_LINE =
  'Promises, not payments — SPOTTER doesn\u2019t collect money or enforce anything.';
export const LEDGER_PAIR_LINE = 'Only you and the person it\u2019s to see this.';
export const LEDGER_EMPTY1_TITLE = 'No promises yet.';
export const LEDGER_EMPTY1_BODY_WITH_NOTE =
  'Miss a week and your note lands here — in your own words, seen only by you and {witnessFirstName}.';
export const LEDGER_EMPTY2_TITLE = 'All caught up.';
export const LEDGER_EMPTY2_BODY =
  'Every promise is settled. Miss a week and a new one lands here — just for you and the person it\u2019s to.';
export const LEDGER_EMPTY1_BODY_NO_NOTE =
  'Set one in Profile — just for you and someone you choose.';
// §4 Profile row.
export const PROFILE_PROMISES_CAPTION =
  'Promises between you and the person you made them to — open, kept, or let go.';
export const PROFILE_MISS_CAPTION =
  'Only you and the person you choose can see it — and only if you miss. No one else in your group sees it.';
// §4 MissSetupSheet.
export const MISSSET_2P_BODY =
  'Leave a note for {firstName}. They\u2019ll only see it if you actually miss the week — and no one else will. Totally optional.';
export const MISSSET_3P_BODY =
  'Only you and the person you pick will see it — and only if you actually miss the week. Totally optional.';
export const MISSSET_PICKER_LABEL = 'Who\u2019s it to?';
export const MISSSET_TO_ROW_LABEL = 'To: {Name}';
// §4 onboarding stakes preview: the pair-private line + the verbatim framing line.
export const STAKES_PREVIEW_PAIR_LINE =
  'Only you and the person you choose will ever see it — and only if you miss a week.';
// §4 "Visible only to you and {firstName} — and only after you miss a week."
// (replaces every prior "Private until you miss" line).
export function visibleOnlyToLine(firstName: string): string {
  return `Visible only to you and ${firstName} — and only after you miss a week.`;
}
export const SOLO_PAIR_UP_FIRST = 'Pair up first';

const NAME_FALLBACK = 'A member';

/** Name map from the weekly context (my_group member map): own name + each
 * co-member's display name. Unresolvable ids fall back to "A member". */
async function buildNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const session = await getStoredSession();
  if (!session) return map;
  map.set(session.user.id, session.user.email.split('@')[0] || 'You');
  const ctx = await fetchWeeklyContext();
  if (ctx.ok && ctx.context) {
    for (const m of ctx.context.members) {
      if (!map.has(m.id)) map.set(m.id, m.displayName);
    }
  }
  return map;
}

/** Record a missed week as a promise entry (week rollover; idempotent). */
export async function recordMissedPromise(
  weekStart: string,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const session = await getStoredSession();
  if (!session) return { ok: false, created: false, error: 'Sign in first.' };

  if (session.isDevMode || !supabase) {
    try {
      return await devMock.recordMissedPromise(session.user.id, weekStart);
    } catch (e) {
      return { ok: false, created: false, error: e instanceof Error ? e.message : 'Could not create the promise.' };
    }
  }

  try {
    const { data, error } = await supabase.rpc('record_missed_promise', { p_week_start: weekStart });
    if (error) return { ok: false, created: false, error: error.message };
    const created = Boolean((data as { created?: boolean } | null)?.created);
    return { ok: true, created };
  } catch {
    return { ok: false, created: false, error: "Can't reach server. Try again." };
  }
}

/** Settle an entry — promise-maker ONLY (the witness gets no resolve tap). */
export async function resolvePromise(
  entryId: string,
  state: 'kept' | 'let_go',
): Promise<{ ok: boolean; error?: string }> {
  const session = await getStoredSession();
  if (!session) return { ok: false, error: 'Sign in first.' };

  if (session.isDevMode || !supabase) {
    try {
      await devMock.resolvePromise(session.user.id, entryId, state);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not settle the promise.' };
    }
  }

  try {
    const { error } = await supabase.rpc('resolve_promise', { p_entry_id: entryId, p_state: state });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch {
    return { ok: false, error: "Can't reach server. Try again." };
  }
}

/** Pair-scoped ledger read: only rows where I am the maker OR the witness,
 * newest week first, no pagination. Names from the member map, "A member"
 * fallback, never crashes. */
export async function fetchLedger(): Promise<LedgerEntry[]> {
  const session = await getStoredSession();
  if (!session) return [];

  const names = await buildNameMap();
  const resolveName = (id: string): string => names.get(id)?.trim() || NAME_FALLBACK;

  let rows: DevPromiseEntry[];
  if (session.isDevMode || !supabase) {
    rows = await devMock.listLedgerFor(session.user.id);
  } else {
    const { data, error } = await supabase
      .from('promise_entries')
      .select('id, user_id, witness_id, promise_text, week_start, state, created_at, updated_at')
      .or(`user_id.eq.${session.user.id},witness_id.eq.${session.user.id}`)
      .order('week_start', { ascending: false });
    if (error || !data) return [];
    rows = data as unknown as DevPromiseEntry[];
  }

  return rows.map((r) => ({
    id: r.id,
    makerId: r.user_id,
    witnessId: r.witness_id,
    promiseText: r.promise_text,
    weekStart: r.week_start,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    makerName: resolveName(r.user_id),
    witnessName: resolveName(r.witness_id),
  }));
}

/** Profile-row badge: count of OPEN entries where I am maker OR witness
 * (maker ≠ witness always, so summing open rows never double counts). */
export async function getOpenPromiseCount(): Promise<number> {
  const entries = await fetchLedger();
  return entries.filter((e) => e.state === 'open').length;
}