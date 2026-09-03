/**
 * Invites + pairing (slice C).
 *
 * One interface, two backends (same pattern as workoutStore):
 *  - REAL:  Supabase `invites` table (inviter-scoped RLS) + `get_invite` /
 *           `accept_invite` RPCs (schema.sql). accept_invite REQUIRES auth —
 *           the security decision for slice C: a code alone can never mutate
 *           invite rows; the invitee creates their account first, then accepts
 *           with their own JWT. The code is a capability that can only pair
 *           YOUR account with the inviter.
 *  - DEV:   devMock AsyncStorage two-user setup (self + "Dev Partner").
 *
 * Token: 8 chars, readable alphabet (no 0/O/1/I/L), no expiry in MVP.
 * Display code format: real `ABCD-EFGH`; dev mock `DEV-ABCD-EFGH` (mock keeps
 * an extra human cue plus the DEV prefix so nobody mistakes it for real).
 * Matching is case-insensitive on the 8 chars (single "code entry" affordance;
 * dev mode additionally tolerates the DEV- prefix).
 */
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { devMock, type DevInvite } from './mock';
import { getStoredSession, supabase } from './supabase';

export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface InviteInfo {
  /** Display code (with dash). */
  displayCode: string;
  /** The 8-char raw capability token (real mode only; dev returns the same raw). */
  token: string;
  /** In dev mock the code is prefixed DEV- so nobody can mistake it for real. */
  isDev: boolean;
}

export function generateInviteToken(): string {
  const bytes = Crypto.getRandomBytes(8);
  let token = '';
  for (let i = 0; i < 8; i += 1) {
    token += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
  }
  return token;
}

export function formatInviteCode(token: string): string {
  const t = token.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  // DEV mock passes a prefixed token: `DEV-` + raw → keep `DEV-ABCD-EFGH`.
  // Real passes the raw token → `ABCD-EFGH`. Splitting on the LAST 8 chars
  // guarantees both forms are always 8-char after the prefix.
  const core = t.slice(-8);
  const prefix = t.slice(0, -8);
  return `${prefix}${core.slice(0, 4)}-${core.slice(4, 8)}`;
}

export function normalizeInviteCode(input: string): string {
  return input.trim().replace(/^DEV-/i, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

/** Persistent handle so the SAME invite (and its display code) is reused for a
 * user across sessions — the Welcome-row pre-generate stays attachable to the
 * account (invite-flow.md §1). REAL stores the instance id; DEV stores the id
 * too (the token lives in the dev invites store). */
const INVITE_KEY = 'spotter.invite:v1';

export interface StoredInviteRef {
  /** invites row/DevInvite id (real: uuid; dev: dev_* id). */
  id: string;
  /** The 8-char token for real mode. */
  token: string;
}

async function readStoredInviteRef(): Promise<StoredInviteRef | null> {
  try {
    const raw = await AsyncStorage.getItem(INVITE_KEY);
    return raw ? (JSON.parse(raw) as StoredInviteRef) : null;
  } catch {
    return null;
  }
}

async function writeStoredInviteRef(ref: StoredInviteRef): Promise<void> {
  try {
    await AsyncStorage.setItem(INVITE_KEY, JSON.stringify(ref));
  } catch {}
}

/** Code the UI shows right now (up to the pre-signup Welcome row and the
 * Profile/invite sheet). In dev, seeding the partner is what makes the mock
 * two-user story exist; real mode persists an invites row (the row id is kept
 * so "Link sent — waiting" survives restarts). No expiry in MVP. */
export async function getOrCreateInviteCode(): Promise<InviteInfo> {
  const session = await getStoredSession();

  if (session?.isDevMode || !supabase) {
    // Dev: a pending invite always exists on the user side; partner pre-seeded.
    const stored = await readStoredInviteRef();
    let token = stored?.token ?? '';
    if (!token) {
      token = generateInviteToken();
      await writeStoredInviteRef({ id: `dev_invite_${token}`, token });
    }
    // Make sure an invites row exists so the accept screen can resolve it.
    const userId = session?.user.id;
    if (userId) {
      const rows = await devMock.listInvites(userId);
      if (!rows.some((r) => r.token === token)) {
        rows.push({
          id: `dev_invite_${token}`,
          inviter_id: userId,
          token,
          invitee_email: null,
          status: 'pending',
          created_at: new Date().toISOString(),
          accepted_at: null,
        });
        await devMock.saveInvites(userId, rows);
      }
    }
    await devMock.getOrSeedPartner();
    return { displayCode: formatInviteCode(`DEV-${token}`), token, isDev: true };
  }

  // REAL mode: one invite row per user+token, idempotent.
  const sessionReal = await getStoredSession();
  if (!sessionReal?.user.id) return { displayCode: '', token: '', isDev: false };
  const stored = await readStoredInviteRef();
  if (stored?.token) {
    return { displayCode: formatInviteCode(stored.token), token: stored.token, isDev: false };
  }
  const token = generateInviteToken();
  const { data, error } = await supabase!
    .from('invites')
    .insert({ inviter_id: sessionReal.user.id, token })
    .select('id')
    .single();
  if (error || !data) {
    // RLS violation or offline — still hand back a code so the Welcome row
    // pre-generate works; persistence to the invites table happens on retry.
    return { displayCode: formatInviteCode(token), token, isDev: false };
  }
  await writeStoredInviteRef({ id: data.id, token });
  return { displayCode: formatInviteCode(token), token, isDev: false };
}

export interface PendingInviteInfo {
  found: boolean;
  /** Inviter first name (from their users.name). */
  inviterName: string;
  /** Whether the inviter has logged anything yet (drives Accept-screen copy). */
  inviterHasLogs: boolean;
}

/** Public, unauthenticated lookup of a code for the Accept landing screen. */
export async function lookupInvite(code: string): Promise<PendingInviteInfo> {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return { found: false, inviterName: '', inviterHasLogs: false };

  if (supabase) {
    const { data, error } = await supabase.rpc('get_invite', { p_token: normalized });
    if (!error && data) {
      const parsed = (
        typeof data === 'string' ? (JSON.parse(data) as unknown) : data
      ) as Partial<PendingInviteInfo>;
      if (parsed?.found) {
        return {
          found: true,
          inviterName: parsed.inviterName ?? 'Your partner',
          inviterHasLogs: parsed.inviterHasLogs ?? false,
        };
      }
    }
    return { found: false, inviterName: '', inviterHasLogs: false };
  }

  // DEV MOCK — resolve against the dev invites stores (any user's — the code
  // belongs to whoever generated it pre-signup).
  const invite = await devMock.findInviteByCode(code);
  if (!invite || invite.status !== 'pending') {
    return { found: false, inviterName: '', inviterHasLogs: false };
  }
  const inviter = await devMock.getUserById(invite.inviter_id);
  return {
    found: true,
    inviterName: inviter?.email.split('@')[0] ?? 'Dev Partner',
    inviterHasLogs: (await devMock.listWorkouts(invite.inviter_id)).length > 0,
  };
}

export interface AcceptInviteResult {
  ok: boolean;
  error?: string;
  /** Real mode: the new pair group id. */
  groupId?: string;
  /** Inviter first name (for the in-app welcome toast). */
  inviterName?: string;
}

/**
 * Authenticated accept: pairs the CURRENT user with the inviter of this code.
 * REAL → accept_invite RPC (transactional: creates the pair group + both
 * memberships, flips the invite to accepted). DEV → pair with the demo partner.
 */
export async function acceptInvite(code: string): Promise<AcceptInviteResult> {
  const session = await getStoredSession();
  if (!session) return { ok: false, error: 'Sign in first, then accept.' };
  const normalized = normalizeInviteCode(code);
  if (!normalized) return { ok: false, error: 'Enter a valid code.' };

  if (session.isDevMode || !supabase) {
    // Dev mock: resolve the code across all dev users (v2 two-user flow: the
    // invitee pairs with the INVITER; the single-user demo path pairs with
    // the preset partner when accepting your own self-generated code).
    const invite = await devMock.findInviteByCode(normalized);
    if (!invite) {
      return {
        ok: false,
        error: "That's not a valid SPOTTER code. In this demo, use the code shown on the invite screen (DEV-…).",
      };
    }
    const inviter = await devMock.getUserById(invite.inviter_id);
    if (inviter && inviter.id !== session.user.id) {
      // Real two-user accept: pair the current user with the inviter.
      await devMock.acceptDevPairWith(session.user.id, inviter);
      return { ok: true, inviterName: inviter.email.split('@')[0] ?? 'Partner' };
    }
    // Self-accept keeps the slice-C single-user demo story: pairs with the
    // preset demo partner so the shared feed renders without a real person.
    await devMock.acceptDevPair(session.user.id);
    return { ok: true, inviterName: 'Dev Partner' };
  }

  const { data, error } = await supabase.rpc('accept_invite', { p_token: normalized });
  if (error) return { ok: false, error: error.message };
  const parsed = (typeof data === 'string' ? (JSON.parse(data || '{}') as unknown) : data) as Record<
    string,
    string | boolean | number | null | undefined
  >;
  return {
    ok: true,
    groupId: typeof parsed?.group_id === 'string' ? parsed.group_id : undefined,
    inviterName: typeof parsed?.inviter_name === 'string' ? parsed.inviter_name : undefined,
  };
}

/** Human message template for the share sheet (invite-flow.md §1, one line). */
export function inviteMessageTemplate(code: string): string {
  const part = code ? ` Code: ${code}` : '';
  return `I'm in SPOTTER — work out together, each of us logs photo proof, the ring fills. Join me.${part}`;
}

export type { DevInvite };