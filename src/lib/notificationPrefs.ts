/**
 * Notification preferences — per-user push switches (v1.1 Build #3, slice 1).
 *
 * The four push types (plan rev 5, owner-ratified 2026-09-06):
 *   invite_accepted — "someone accepted your invite"           (default ON)
 *   partner_logged  — "your partner logged a workout"          (default ON, rate-limited)
 *   pending_invite  — "your invite is still waiting" reminder  (default ON, inviter-only,
 *                    ~48h, capped, NEVER notifies the invitee)
 *   missed_week     — "you missed the week" alert              (default OFF until recap
 *                    behavior is verified — the toggle EXISTS and is truthful;
 *                    slice 2 just must not send while it is off)
 *
 * Storage mirrors naming.ts:
 *  - REAL mode: the `notification_preferences` table (one row per user, lazily
 *    created with schema defaults; own-row RLS). Reads before a row exists are
 *    served from the schema defaults so the UI never shows a phantom "off".
 *    Writes upsert the row (onConflict user_id) — a toggle flip never destroys
 *    the other toggles, and `updated_at` refreshes with each write.
 *  - DEV MOCK: a per-user AsyncStorage key through devMock, mirroring the same
 *    shape + defaults; parity for the smoke harness and the walkable demo.
 *
 * The four types also live in a typed list so UI + smoke iterate the SAME set —
 * a fifth type cannot silently diverge between the sheet, the Profile toggles
 * and the test.
 */
import { devMock, type NotificationPrefsRow } from './mock';
import { getStoredSession, supabase } from './supabase';

/** The four push types, in stable order (UI renders this order). */
export type NotificationType = 'invite_accepted' | 'partner_logged' | 'pending_invite' | 'missed_week';

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'invite_accepted',
  'partner_logged',
  'pending_invite',
  'missed_week',
];

/** Column name on the REAL table for each type (own metadata lives here). */
export const NOTIFICATION_COLUMNS: Record<NotificationType, string> = {
  invite_accepted: 'invite_accepted_enabled',
  partner_logged: 'partner_logged_enabled',
  pending_invite: 'pending_invite_enabled',
  missed_week: 'missed_week_enabled',
};

/** Schema defaults (kept in sync with supabase/schema.sql by review). */
export const NOTIFICATION_DEFAULTS: Record<NotificationType, boolean> = {
  invite_accepted: true,
  partner_logged: true,
  pending_invite: true,
  missed_week: false,
};

/** Human label + one-line caption for the Profile toggles (honest copy). */
export const NOTIFICATION_META: Record<
  NotificationType,
  { label: string; caption: string }
> = {
  invite_accepted: {
    label: 'Invite accepted',
    caption: 'When someone you invited pairs up.',
  },
  partner_logged: {
    label: 'Partner logged',
    caption: 'When your partner logs a workout.',
  },
  pending_invite: {
    label: 'Invite still waiting',
    caption: 'A gentle nudge if your invite hasn\u2019t been accepted yet.',
  },
  missed_week: {
    label: 'Missed week',
    caption: 'When you miss your weekly goal. Off until you turn it on.',
  },
};

export type NotificationPrefs = Record<NotificationType, boolean>;

/** Fresh defaults map (independent copy per call — never shared mutable). */
export function defaultNotificationPrefs(): NotificationPrefs {
  return { ...NOTIFICATION_DEFAULTS };
}

/** Map a real table row (or the devMock row) → the 4-type boolean map. */
function toPrefsMap(row: NotificationPrefsRow | null | undefined): NotificationPrefs {
  const out = defaultNotificationPrefs();
  if (!row) return out;
  out.invite_accepted = row.invite_accepted_enabled;
  out.partner_logged = row.partner_logged_enabled;
  out.pending_invite = row.pending_invite_enabled;
  out.missed_week = row.missed_week_enabled;
  return out;
}

/**
 * Read the current user's notification preferences. Requires a session;
 * returns null when signed out (UI hides the section). When the real row has
 * not been created yet the schema defaults are returned — served from the
 * devMock in dev mode, and from the empty-read fallback in real mode, so the
 * Profile toggles always render the TRUE defaults, never phantom "off" rows.
 */
export async function getNotificationPrefs(): Promise<NotificationPrefs | null> {
  const session = await getStoredSession();
  if (!session) return null;

  if (session.isDevMode || !supabase) {
    const row = await devMock.getNotificationPrefs(session.user.id);
    return toPrefsMap(row);
  }

  try {
    const { data } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (data) return toPrefsMap(data);
    // Row not created yet → schema defaults (truthful: the row would default
    // identically on first write).
    return defaultNotificationPrefs();
  } catch {
    // Network/read failure: fall back to defaults — never block the Profile.
    return defaultNotificationPrefs();
  }
}

/**
 * Set ONE preference for the current user (the Profile toggles call this per
 * toggle). Lazily creates the row with the OTHER toggles at their defaults;
 * refreshing `updated_at` on every write. Returns ok/error so the Profile can
 * report a truthful failure (network/RLS) instead of a silent phantom flip.
 */
export async function setNotificationPref(
  type: NotificationType,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getStoredSession();
  if (!session) return { ok: false, error: 'Sign in first.' };

  if (session.isDevMode || !supabase) {
    const row = await devMock.getNotificationPrefs(session.user.id);
    await devMock.saveNotificationPrefs(session.user.id, {
      ...row,
      [NOTIFICATION_COLUMNS[type]]: enabled,
    });
    return { ok: true };
  }

  try {
    // Build the upsert row explicitly. A computed key like
    // `{ [NOTIFICATION_COLUMNS[type]]: enabled }` widens to an index signature
    // and fails supabase-js's strict excess-check, so we build the patch
    // separately and cast through a narrow typed shape (documented; runtime
    // value is exactly the one boolean column the toggle owns).
    const patch: Partial<Record<NotificationType, boolean>> = {
      [type]: enabled,
    };
    const row = {
      user_id: session.user.id,
      updated_at: new Date().toISOString(),
      ...patch,
    } as {
      user_id: string;
      invite_accepted_enabled?: boolean;
      partner_logged_enabled?: boolean;
      pending_invite_enabled?: boolean;
      missed_week_enabled?: boolean;
      updated_at?: string;
    };
    const { error } = await supabase.from('notification_preferences').upsert(row, { onConflict: 'user_id' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch {
    return { ok: false, error: "Can't reach server. Try again." };
  }
}