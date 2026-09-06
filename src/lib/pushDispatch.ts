/**
 * CLIENT-INITIATED PUSH DISPATCHER (v1.1 Build #3, slice 2).
 *
 * WHY THE CLIENT SENDS (honest, documented trade-off — plan rev 5):
 *   SPOTTER has NO always-on backend server. v1.1 delivery is deliberately
 *   CLIENT-INITIATED: the dispatcher runs on the CURRENT user's app open /
 *   foreground, evaluates the four push types from the CURRENT user's own
 *   perspective, and when a condition fires it sends the push for the
 *   RECIPIENT (partner or self) through the Expo Push HTTP API, then logs a
 *   push_deliveries row for the funnel. This is a recognized limitation, not
 *   a bug: sends only happen when someone opens the app, so a workout your
 *   partner logs won't push to you until the LOGGING USER's next open (their
 *   app evaluates partner_logged at send time and writes the row). Real
 *   end-to-end delivery is verified at TestFlight with the runbook; this
 *   slice proves the evaluation + suppression + dedupe + logging logic with
 *   full dev parity (no network).
 *
 * EVALUATION ORDER (per type, at send time — plan rev 5):
 *   (a) master/pref enabled per type (notification_preferences; defaults:
 *       invite_accepted ON, partner_logged ON, pending_invite ON,
 *       missed_week OFF). missed_week additionally requires the member's OWN
 *       miss promise (a push without one would be empty noise).
 *   (b) quiet hours against the RECIPIENT's stored timezone
 *       (9pm–8am local = suppressed).
 *   (c) dedupe via push_deliveries.dedupe_key (UNIQUE) — one row per
 *       triggering event.
 *   (d) rate limit: partner_logged carries max 1 push per partner workout
 *       (the dedupe key does this) PLUS a max 3/day per RECIPIENT safety cap
 *       (counted from that day's delivery rows for the recipient).
 *   Only when every gate passes does the dispatcher call the Expo Push API
 *   and log the row (status 'sent' with a fake receipt in dev; 'failed' with
 *   the error otherwise).
 *
 *   On ANY suppression the dispatcher still logs the row with
 *   status='suppressed' + suppressed_reason ('pref_off', 'quiet_hours',
 *   'daily_cap', 'no_device', 'permission') so the funnel sees the decision.
 *   Dedupe skips are the sole exception (the UNIQUE key already exists —
 *   nothing to log; the earlier row IS the record).
 *
 * ISOLATION / WRITE RULE (honest):
 *   push_deliveries is own-row RLS (auth.uid() = user_id). The row must be
 *   written by the RECIPIENT'S own device. The four triggers therefore split:
 *     - pending_invite  → recipient = the CURRENT user (inviter, their own
 *       open). Row written on their own device. ✓
 *     - missed_week     → recipient = the CURRENT user (the missed member).
 *       Row written on their own device. ✓
 *     - invite_accepted → recipient = the INVITER. The ACCEPTOR's device
 *       evaluates it (their open) and CANNOT write the inviter's row under
 *       own-row RLS. In real mode the send still happens (the Expo API
 *       accepts any token) but the row insert is rejected by RLS — the
 *       dispatcher surfaces that honestly rather than fabricating a row. The
 *       inviter's own next open re-evaluates nothing for this event kind
 *       (dedupe lives on the rows that exist) — the runbook notes this.
 *     - partner_logged  → recipient = the partner; the LOGGER's device
 *       evaluates; same own-row reality as invite_accepted. In DEV the
 *       per-recipient stores accept any writer (mirror of the real table
 *       shape) so the smoke harness proves dedupe + cap logic exactly.
 *   This is the plan-rev-5 accepted trade-off of a client-initiated engine;
 *   the comment stays in sync with the code.
 *
 * NAME RESOLUTION (privacy): the recipient's name in a push body is rendered
 *   by the EVALUATOR using only names the evaluator already holds (partner
 *   name from their own pair read / self name from their own profile), never
 *   a cross-user fetch of another user's real name.
 */

import { AppState, type AppStateStatus } from 'react-native';

import { devMock, DEV_PAIR_GROUP_ID } from './mock';
import { getStoredSession, supabase } from './supabase';
import { getNotificationPrefs, type NotificationPrefs } from './notificationPrefs';
import { getNotificationPermissionState } from './notifications';
import { getMissPromise } from './missPromise';
import { previousWeekRange } from './weeklyResults';

// ---------------------------------------------------------------------------
// Constants + types
// ---------------------------------------------------------------------------

/** Expo Push HTTP API (single-message array; client-initiated send). */
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Quiet hours, recipient-local: 9pm–8am = suppressed (plan rev 5). */
export const QUIET_HOURS_START_HOUR = 21; // 9pm
export const QUIET_HOURS_END_HOUR = 8; // 8am (8:00am exactly is fine — not quiet)

/** pending_invite: first reminder at/after 48h, ONE follow-up at/after 7d,
 * hard cap 2 per invite (dedupe key carries the count). The INVITEE NEVER
 * receives a pending_invite push (owner-ratified 2026-09-06). */
export const PENDING_INVITE_FIRST_MS = 48 * 60 * 60 * 1000;
export const PENDING_INVITE_FOLLOWUP_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_INVITE_MAX = 2;

/** partner_logged daily safety cap per RECIPIENT (max 3/day, all kinds). */
export const PARTNER_LOGGED_DAILY_CAP = 3;

export type PushKind = 'invite_accepted' | 'partner_logged' | 'pending_invite' | 'missed_week';

export type DeliveryStatus = 'queued' | 'sent' | 'suppressed' | 'failed';

export type SuppressedReason = 'pref_off' | 'quiet_hours' | 'daily_cap' | 'no_device' | 'permission';

export interface PushDeliveryRowLike {
  user_id: string;
  dedupe_key: string;
  kind: PushKind;
  status: DeliveryStatus;
  suppressed_reason?: SuppressedReason | null;
  error?: string | null;
  created_at?: string;
  sent_at?: string | null;
}

/** The message the recipient's phone will render (Expo push message shape:
 * `to` must be the Expo push token; `title`/`body` render the notification). */
export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: 'default' | null;
}

export type DispatchResult =
  | { ok: true; status: 'sent' | 'suppressed'; suppressedReason?: SuppressedReason }
  | { ok: true; status: 'skipped'; reason: 'already_delivered' | 'no_recipient' }
  | { ok: false; status: 'failed'; error?: string };

/** Resolved send target: a device token + the recipient's stored timezone. */
export interface PushTarget {
  userId: string;
  expoPushToken: string | null;
  timezone: string;
}

// ---------------------------------------------------------------------------
// Quiet hours (recipient-local, injectable clock for tests)
// ---------------------------------------------------------------------------

/**
 * True when `now` falls inside quiet hours (9pm–8am) in the recipient's
 * stored IANA timezone. Uses Intl (Hermes supports it; settings.ts already
 * uses Intl.DateTimeFormat). Unknown zone / missing → UTC (schema default).
 */
export function isQuietHours(timezone: string | null | undefined, now: Date = new Date()): boolean {
  const hour = getLocalHour(now, timezone || 'UTC');
  return hour >= QUIET_HOURS_START_HOUR || hour < QUIET_HOURS_END_HOUR;
}

/** Local wall-clock hour (0–23) for `d` in `ianaTimezone` (UTC fallback). */
export function getLocalHour(d: Date, ianaTimezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: ianaTimezone,
    }).formatToParts(d);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    if (hour === undefined) return d.getUTCHours();
    return parseInt(hour, 10) % 24;
  } catch {
    return d.getUTCHours();
  }
}

// ---------------------------------------------------------------------------
// Copy — the four types, EXACT strings (gentle, specific, no shaming/urgency)
// ---------------------------------------------------------------------------

export function pendingInviteBody(inviteeName: string | null, count: number): string {
  // Exact spec copy when a name exists. This build never captures the
  // invitee's name (invites carry no invitee identity yet), so the no-name
  // fallback keeps the SAME gentle shape with grammatical agreement
  // ("they haven't", "their spot") — flagged in the slice report.
  if (count === 1) {
    return inviteeName
      ? `Your code's still waiting — ${inviteeName} hasn't joined yet`
      : "Your code's still waiting — they haven't joined yet";
  }
  return inviteeName
    ? `Still thinking it over? ${inviteeName}'s spot in your feed is saved`
    : "Still thinking it over? their spot in your feed is saved";
}

export function partnerLoggedBody(partnerName: string, workoutType: string | null): string {
  return `${partnerName} just logged ${workoutType ?? 'a workout'} 💪`;
}

export function missedWeekBody(promiseText: string | null): string {
  return promiseText
    ? `No judgment — your week reset. ${promiseText} is waiting if you want it`
    : 'No judgment — your week reset.';
}

// ---------------------------------------------------------------------------
// Recipient/target resolution (dev parity; real targets only self-read)
// ---------------------------------------------------------------------------

/** Resolve a push target in DEV MOCK (no network; deterministic token). */
async function resolveDevTarget(targetUserId: string): Promise<PushTarget | null> {
  const user = await devMock.getUserById(targetUserId);
  if (!user) return null;
  const devices = await devMock.listPushDevices(targetUserId);
  const profile = await devMock.getProfile(targetUserId);
  return {
    userId: targetUserId,
    expoPushToken: devices[0]?.expo_push_token ?? null,
    timezone: profile?.timezone ?? 'UTC',
  };
}

/**
 * Resolve a real target. Only the CURRENT user's own rows are readable under
 * own-row RLS (push_devices + users). For a PARTNER target the token is not
 * readable cross-user — the honest resolver returns a null token ('no_device'
 * suppression) so a real-mode partner send never fabricates a target; the
 * runbook path is the recipient's own-open evaluation.
 */
async function resolveRealTarget(targetUserId: string): Promise<PushTarget | null> {
  const session = await getStoredSession();
  if (!session || !supabase) return null;
  if (targetUserId !== session.user.id) {
    // Partner rows not readable cross-user (users RLS: `users_select_own`).
    return { userId: targetUserId, expoPushToken: null, timezone: 'UTC' };
  }
  try {
    const { data: device } = await supabase
      .from('push_devices')
      .select('expo_push_token')
      .eq('user_id', targetUserId)
      .limit(1)
      .maybeSingle();
    const { data: user } = await supabase
      .from('users')
      .select('timezone')
      .eq('id', targetUserId)
      .maybeSingle();
    return {
      userId: targetUserId,
      expoPushToken: device?.expo_push_token ?? null,
      timezone: user?.timezone ?? 'UTC',
    };
  } catch {
    return { userId: targetUserId, expoPushToken: null, timezone: 'UTC' };
  }
}

/** The CURRENT user's own stored timezone (self-target quiet-hours anchor). */
export async function getSelfTimezone(userId: string): Promise<string> {
  const session = await getStoredSession();
  if (!session) return 'UTC';
  if (session.isDevMode || !supabase) {
    return (await devMock.getProfile(userId))?.timezone ?? 'UTC';
  }
  try {
    const { data } = await supabase.from('users').select('timezone').eq('id', userId).maybeSingle();
    return data?.timezone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The CURRENT user's own first name (evaluator-side display name). */
export async function getSelfFirstName(userId: string): Promise<string> {
  const session = await getStoredSession();
  if (!session) return 'Partner';
  if (session.isDevMode || !supabase) {
    const profile = await devMock.getProfile(userId);
    if (profile?.name) return profile.name.split(' ')[0];
    const user = await devMock.getUserById(userId);
    return user?.email.split('@')[0] || 'Partner';
  }
  try {
    const { data } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
    return data?.name?.split(' ')[0] ?? 'Partner';
  } catch {
    return 'Partner';
  }
}

// ---------------------------------------------------------------------------
// push_deliveries persistence (dev mock + real; own-row rule in the header)
// ---------------------------------------------------------------------------

async function deliveriesFor(userId: string): Promise<PushDeliveryRowLike[]> {
  const session = await getStoredSession();
  if (session?.isDevMode || !supabase) {
    return devMock.listPushDeliveries(userId) as unknown as PushDeliveryRowLike[];
  }
  try {
    const { data } = await supabase
      .from('push_deliveries')
      .select('dedupe_key, kind, status, suppressed_reason, error, created_at, sent_at')
      .eq('user_id', userId);
    return (data ?? []) as PushDeliveryRowLike[];
  } catch {
    return [];
  }
}

/**
 * Write ONE delivery row. DEV always writes (per-recipient store; no RLS).
 * REAL: under own-row RLS only the recipient can write their own row — a
 * cross-user writer (acceptor/logging partner) gets the RLS error back, which
 * the dispatcher surfaces honestly as part of the result.
 */
async function persistDelivery(
  row: PushDeliveryRowLike,
  actorUserId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getStoredSession();
  if (session?.isDevMode || !supabase) {
    const rows = await devMock.listPushDeliveries(row.user_id);
    if (rows.some((r) => r.dedupe_key === row.dedupe_key)) return { ok: true }; // dedupe (already present)
    rows.push({
      id: `dev_del_${Math.random().toString(36).slice(2, 10)}`,
      user_id: row.user_id,
      dedupe_key: row.dedupe_key,
      kind: row.kind,
      status: row.status,
      suppressed_reason: row.suppressed_reason ?? null,
      error: row.error ?? null,
      created_at: row.created_at ?? new Date().toISOString(),
      sent_at: row.sent_at ?? null,
    });
    await devMock.savePushDeliveries(row.user_id, rows);
    return { ok: true };
  }
  if (row.user_id !== actorUserId) {
    // Cross-user real write: own-row RLS would reject; no row is written by
    // this client (the recipient's own evaluation owns that row).
    return { ok: true, error: 'cross-user row not written (own-row RLS); recipient open evaluates' };
  }
  try {
    const { error } = await supabase.from('push_deliveries').insert({
      user_id: row.user_id,
      dedupe_key: row.dedupe_key,
      kind: row.kind,
      status: row.status,
      suppressed_reason: row.suppressed_reason ?? null,
      error: row.error ?? null,
      sent_at: row.sent_at ?? null,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not log delivery.' };
  }
}

// ---------------------------------------------------------------------------
// Sending (dev: fake receipt, no network; real: Expo Push HTTP API)
// ---------------------------------------------------------------------------

/**
 * Send a message via the Expo Push API. DEV skips the network and returns a
 * fake ticket — full parity for the smoke flow. REAL posts the single-message
 * array; receipt ticket ids and error messages surface in the delivery row.
 *
 * PAYLOAD SHAPE (Expo docs): POST /--/api/v2/push/send with an ARRAY of
 * messages; each message has `to` (ExpoPushToken), `title` (notification
 * title), `body`, optional `data`/`sound`. The response `data[0]` carries
 * `id` (ticket), `status: 'ok' | 'error'`, and `message` on error.
 */
export async function sendViaExpo(
  message: ExpoPushMessage,
  isDev: boolean,
): Promise<{ ok: boolean; receiptId?: string; error?: string }> {
  if (isDev) {
    return { ok: true, receiptId: `dev-expo-ticket-${Math.random().toString(36).slice(2, 10)}` };
  }
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([message]),
    });
    if (!res.ok) return { ok: false, error: `Expo API HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: string; status?: string; message?: string }[] };
    const first = body?.data?.[0];
    if (!first?.id || first.status === 'error') {
      return { ok: false, error: first?.message ?? 'Expo API returned no ticket.' };
    }
    return { ok: true, receiptId: first.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Push request failed.' };
  }
}

// ---------------------------------------------------------------------------
// The core dispatch gate — ONE entry for all four types
// ---------------------------------------------------------------------------

export interface DispatchInput {
  kind: PushKind;
  /** The user whose device receives the push. */
  recipientUserId: string;
  /** Recipient's stored timezone (quiet-hours anchor). */
  recipientTimezone: string;
  /** Display name × kind (partner name for partner_logged; join name for
   * invite_accepted; null for self-target kinds). */
  recipientName: string | null;
  /** Triggering event id → dedupe key `${kind}:${eventKey}`. */
  eventKey: string;
  content?: {
    workoutType?: string | null;
    inviteeName?: string | null;
    /** pending_invite ordinal (1 or 2) — also embedded in the dedupe key. */
    pendingCount?: number;
    promiseText?: string | null;
    joinName?: string | null;
  };
}

export interface RunDispatchOptions {
  now?: Date;
  /** Test seam: override per-kind pref map + master (null = read real). */
  prefOverride?: { master: boolean; types: NotificationPrefs } | null;
  /** Test seam: override the delivery rows read for the recipient. */
  deliveriesOverride?: PushDeliveryRowLike[] | null;
  /** Test seam: override the resolved target (token/timezone). */
  targetOverride?: PushTarget | null;
  /** Test seam: override the OS-permission decision (self-target kinds). */
  permissionOverride?: boolean | null;
}

/** Today's UTC day-key for the daily cap (per-recipient, all kinds). */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Read the CURRENT user's master + 4-type prefs. Master comes from the
 * notification_preferences row (dev + real); defaults per schema. */
async function readPrefs(opts: RunDispatchOptions): Promise<{ master: boolean; types: NotificationPrefs } | null> {
  if (opts.prefOverride) return opts.prefOverride;
  const session = await getStoredSession();
  if (!session) return null;
  const types = await getNotificationPrefs();
  if (!types) return null;
  let master = true; // schema default
  if (session.isDevMode || !supabase) {
    master = (await devMock.getNotificationPrefs(session.user.id)).master_enabled;
  } else {
    try {
      const { data } = await supabase
        .from('notification_preferences')
        .select('master_enabled')
        .eq('user_id', session.user.id)
        .maybeSingle();
      master = data?.master_enabled ?? true;
    } catch {
      master = true;
    }
  }
  return { master, types };
}

/** OS permission gate: only a 'granted' OS permission may send (self-target
 * kinds — the evaluator IS the recipient; partner kinds use the device token
 * as the practical device gate instead, since the recipient's OS state is
 * only readable on their own device). */
async function permissionGate(recipientUserId: string, opts: RunDispatchOptions): Promise<boolean> {
  if (opts.permissionOverride !== undefined && opts.permissionOverride !== null) return opts.permissionOverride;
  const session = await getStoredSession();
  if (!session) return false;
  if (recipientUserId !== session.user.id) return true; // partner: device-token gate
  return (await getNotificationPermissionState()) === 'granted';
}

/**
 * Evaluate + send ONE push. Called by the trigger wiring AFTER the underlying
 * event committed — never blocks the UI (callers fire-and-forget inside
 * try/catch). Returns the decision so the smoke can assert it.
 */
export async function dispatchPush(input: DispatchInput, opts: RunDispatchOptions = {}): Promise<DispatchResult> {
  const session = await getStoredSession();
  if (!session) return { ok: false, status: 'failed', error: 'No session.' };
  const now = opts.now ?? new Date();
  const devMode = session.isDevMode || !supabase;

  // ---- (c) dedupe first — the hard anti-double-send guard.
  const dedupeKey = `${input.kind}:${input.eventKey}`;
  const deliveries = opts.deliveriesOverride ?? (await deliveriesFor(input.recipientUserId));
  if (deliveries.some((d) => d.dedupe_key === dedupeKey)) {
    return { ok: true, status: 'skipped', reason: 'already_delivered' };
  }

  // ---- (a) master/pref enabled per type.
  const prefs = await readPrefs(opts);
  const prefOn = prefs ? prefs.master && prefs.types[input.kind] === true : false;

  // ---- (b) quiet hours against the RECIPIENT's stored timezone.
  const quiet = isQuietHours(input.recipientTimezone, now);

  // ---- (d) partner_logged daily safety cap (3/day per recipient, all kinds).
  const todayPrefix = dayKey(now);
  const todayCount = deliveries.filter((d) => (d.created_at ?? '').startsWith(todayPrefix)).length;
  const capped = input.kind === 'partner_logged' && todayCount >= PARTNER_LOGGED_DAILY_CAP;

  // ---- OS permission (self-target kinds only).
  const canSend = await permissionGate(input.recipientUserId, opts);

  const buildRow = (status: DeliveryStatus, reason?: SuppressedReason, error?: string): PushDeliveryRowLike => ({
    user_id: input.recipientUserId,
    dedupe_key: dedupeKey,
    kind: input.kind,
    status,
    suppressed_reason: reason ?? null,
    error: error ?? null,
    created_at: now.toISOString(),
    sent_at: status === 'sent' ? now.toISOString() : null,
  });

  if (!prefOn) {
    await persistDelivery(buildRow('suppressed', 'pref_off'), session.user.id);
    return { ok: true, status: 'suppressed', suppressedReason: 'pref_off' };
  }
  if (!canSend) {
    await persistDelivery(buildRow('suppressed', 'permission'), session.user.id);
    return { ok: true, status: 'suppressed', suppressedReason: 'permission' };
  }
  if (quiet) {
    await persistDelivery(buildRow('suppressed', 'quiet_hours'), session.user.id);
    return { ok: true, status: 'suppressed', suppressedReason: 'quiet_hours' };
  }
  if (capped) {
    await persistDelivery(buildRow('suppressed', 'daily_cap'), session.user.id);
    return { ok: true, status: 'suppressed', suppressedReason: 'daily_cap' };
  }

  // ---- Resolve the recipient's device.
  const target =
    opts.targetOverride ??
    (devMode ? await resolveDevTarget(input.recipientUserId) : await resolveRealTarget(input.recipientUserId));
  if (!target || !target.expoPushToken) {
    await persistDelivery(buildRow('suppressed', 'no_device'), session.user.id);
    return { ok: true, status: 'suppressed', suppressedReason: 'no_device' };
  }

  // ---- Copy (name rendered by the evaluator — see header privacy note).
  const name = input.recipientName ?? 'Partner';
  let message: ExpoPushMessage;
  switch (input.kind) {
    case 'partner_logged':
      message = {
        to: target.expoPushToken,
        title: name,
        body: partnerLoggedBody(name, input.content?.workoutType ?? null),
        data: { kind: input.kind },
      };
      break;
    case 'pending_invite':
      message = {
        to: target.expoPushToken,
        title: 'Invite',
        body: pendingInviteBody(input.content?.inviteeName ?? null, input.content?.pendingCount ?? 1),
        data: { kind: input.kind },
      };
      break;
    case 'missed_week':
      message = {
        to: target.expoPushToken,
        title: name,
        body: missedWeekBody(input.content?.promiseText ?? null),
        data: { kind: input.kind },
      };
      break;
    case 'invite_accepted':
    default:
      message = {
        to: target.expoPushToken,
        title: input.content?.joinName ?? name,
        body: `${input.content?.joinName ?? name} joined — you two are paired up 🎉`,
        data: { kind: input.kind },
      };
      break;
  }

  // ---- Send + log (own-row rule applies at the persist layer).
  const send = await sendViaExpo(message, devMode);
  if (!send.ok) {
    await persistDelivery(buildRow('failed', undefined, send.error), session.user.id);
    return { ok: false, status: 'failed', error: send.error };
  }
  await persistDelivery(buildRow('sent'), session.user.id);
  return { ok: true, status: 'sent' };
}

// ---------------------------------------------------------------------------
// App-open evaluation — pending_invite + missed_week (self-target kinds)
// ---------------------------------------------------------------------------

/** The CURRENT user's pair state (dev + real) — used to stop the pending
 * reminder loop once the inviter is no longer solo-waiting. */
async function isCurrentlyPaired(userId: string): Promise<boolean> {
  const session = await getStoredSession();
  if (!session) return false;
  if (session.isDevMode || !supabase) {
    return (await devMock.getPairState(userId)).accepted;
  }
  try {
    const { data } = await supabase
      .from('memberships')
      .select('group_id')
      .eq('user_id', userId);
    const myGroupIds = (data ?? []).map((m) => m.group_id);
    if (myGroupIds.length === 0) return false;
    const { data: groupMems } = await supabase
      .from('memberships')
      .select('group_id, user_id')
      .in('group_id', myGroupIds);
    for (const m of groupMems ?? []) {
      const count = (groupMems ?? []).filter((x) => x.group_id === m.group_id).length;
      if (count === 2) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The CURRENT user's own open/foreground evaluation. Run from the app-open
 * hook (HomeScreen mounts this alongside refreshPushRegistrationIfGranted)
 * AND on every foreground transition via subscribePushDispatchAppState (below).
 * Evaluated in order:
 *   1. pending_invite — invites the CURRENT user created that are still
 *      'pending': first reminder at ≥48h after creation, ONE follow-up at
 *      ≥7d, hard cap 2 per invite; stops immediately when the invite is
 *      accepted (the pending filter drops it) or when the inviter is already
 *      paired (the nudge is moot — their code's purpose resolved). The
 *      RECIPIENT is ALWAYS the CURRENT USER (the inviter). The INVITEE can
 *      NEVER receive a pending_invite push — nothing in this function ever
 *      targets anyone else, and the invitee's own opens evaluate only THEIR
 *      invites.
 *   2. missed_week (pref default OFF) — to the MISSED member THEMSELF (not
 *      the partner; the partner MissCard is the passive surface), only when
 *      they set a miss promise AND the previous fully-elapsed week was
 *      missed. Dedupe key is the previous week's start (one push per missed
 *      week per user — a reinstall cannot re-fire the same week).
 *
 * Client-initiated honesty: pending reminders only fire on the INVITER's own
 * opens — the plan-rev-5 trade-off (no always-on server).
 */
export async function runAppOpenDispatches(opts: RunDispatchOptions = {}): Promise<DispatchResult[]> {
  const session = await getStoredSession();
  if (!session) return [];
  const devMode = session.isDevMode || !supabase;
  const now = opts.now ?? new Date();
  const uid = session.user.id;
  const results: DispatchResult[] = [];

  // ---- 1. pending_invite (inviter's own invites; recipient = self always).
  const paired = await isCurrentlyPaired(uid);
  if (!paired) {
    const invites = devMode
      ? await devMock.listInvites(uid)
      : ((await supabase!.from('invites').select('id, status, created_at').eq('inviter_id', uid)).data ?? []);
    const pending = invites.filter((i) => i.status === 'pending');

    for (const invite of pending) {
      const created = new Date(invite.created_at);
      if (Number.isNaN(created.getTime())) continue;
      const age = now.getTime() - created.getTime();
      if (age < PENDING_INVITE_FIRST_MS) continue;

      const inviteId = invite.id;
      const inviteeName: string | null = null; // invites carry no invitee name this build
      const deliveries = opts.deliveriesOverride ?? (await deliveriesFor(uid));
      const priorCount = deliveries.filter(
        (d) => d.kind === 'pending_invite' && d.dedupe_key.startsWith(`pending_invite:${inviteId}:`),
      ).length;

      // Next ordinal from prior count; the dedupe key (count embedded) makes
      // re-evaluation idempotent and the hard cap stops the third.
      for (let count = priorCount + 1; count <= PENDING_INVITE_MAX; count += 1) {
        const gateAge = count === 1 ? PENDING_INVITE_FIRST_MS : PENDING_INVITE_FOLLOWUP_MS;
        if (age < gateAge) break;
        results.push(
          await dispatchPush(
            {
              kind: 'pending_invite',
              recipientUserId: uid, // the INVITER — never the invitee
              recipientTimezone: await getSelfTimezone(uid),
              recipientName: null,
              eventKey: `${inviteId}:${count}`,
              content: { inviteeName, pendingCount: count },
            },
            opts,
          ),
        );
      }
    }
  }

  // ---- 2. missed_week (to the missed member themself; pref default OFF).
  const prefs = await readPrefs(opts);
  const missedOn = prefs ? prefs.master && prefs.types.missed_week === true : false;
  if (missedOn) {
    const promise = await getMissPromise();
    if (promise) {
      const missed = await wasPreviousWeekMissedForOpen(uid);
      if (missed) {
        const weekKey = await previousWeekKey(uid);
        results.push(
          await dispatchPush(
            {
              kind: 'missed_week',
              recipientUserId: uid,
              recipientTimezone: await getSelfTimezone(uid),
              recipientName: null,
              eventKey: weekKey, // one per missed week per user
              content: { promiseText: promise },
            },
            opts,
          ),
        );
      }
    }
  }

  return results;
}

/** Previous fully-elapsed week's start ISO for the user's stored week-start
 * day (dedupe key + the miss check both anchor on the SAME week). */
async function previousWeekKey(userId: string): Promise<string> {
  const session = await getStoredSession();
  if (!session) return 'week';
  const weekStartDay = session.isDevMode || !supabase
    ? ((await devMock.getProfile(userId))?.week_start_day ?? 'Mon')
    : 'Mon'; // real users row read skipped here (default consistent with miss check)
  const range = previousWeekRange(new Date(), weekStartDay);
  return range ? range.start.toISOString() : 'week';
}

/**
 * Missed-previous-week check for the app-open path (self). Snapshot-preferred
 * (finalized row is authoritative), count fallback when no snapshot exists —
 * the same computation the ring uses, so it stays honest. Goal default 3
 * when the user's own setting can't be resolved (invitee default).
 */
async function wasPreviousWeekMissedForOpen(userId: string): Promise<boolean> {
  const session = await getStoredSession();
  if (!session) return false;
  const devMode = session.isDevMode || !supabase;

  if (devMode) {
    const weekStartDay = (await devMock.getProfile(userId))?.week_start_day ?? 'Mon';
    const results = await devMock.listResults(userId);
    const prev = previousWeekRange(new Date(), weekStartDay);
    const snap = prev
      ? results.find((r) => r.group_id === DEV_PAIR_GROUP_ID && r.week_start_at === prev.start.toISOString())
      : undefined;
    if (snap) return !snap.completed;
    const rows = await devMock.listWorkouts(userId);
    const count = prev ? rows.filter((r) => inRange(r.logged_at, prev.start, prev.end)).length : 0;
    return count < 3; // goal default 3 (invitee default)
  }

  try {
    const { data: results } = await supabase!
      .from('weekly_results')
      .select('completed')
      .eq('user_id', userId)
      .order('week_start_at', { ascending: false })
      .limit(1);
    const snap = (results ?? [])[0];
    if (snap) return !snap.completed;
    const prev = previousWeekRange(new Date(), 'Mon');
    const { data: rows } = prev
      ? await supabase!.from('workouts')
          .select('id')
          .eq('user_id', userId)
          .gte('logged_at', prev.start.toISOString())
          .lt('logged_at', prev.end.toISOString())
      : { data: null };
    return (rows ?? []).length < 3;
  } catch {
    return false;
  }
}

function inRange(iso: string, start: Date, end: Date): boolean {
  const t = new Date(iso);
  return !Number.isNaN(t.getTime()) && t >= start && t < end;
}

// ---------------------------------------------------------------------------
// Event wiring — partner_logged + invite_accepted (called AFTER commit)
// ---------------------------------------------------------------------------

/**
 * partner_logged: fired from the logWorkout path AFTER the workout row is
 * committed (never blocks the UI — callers fire-and-forget in try/catch).
 * Recipient = the CURRENT user's partner; quiet hours anchor on the
 * PARTNER's stored timezone (dev: read from their profile; real: UTC
 * fallback — partner timezone isn't cross-user readable); dedupe key = the
 * workout id (max 1 push per partner workout). Returns null when unpaired.
 */
export async function dispatchPartnerLogged(opts: {
  workoutId: string;
  workoutType: string | null;
  partnerId: string | null;
  partnerName: string | null;
  partnerTimezone?: string | null;
}): Promise<DispatchResult | null> {
  if (!opts.partnerId) return null;
  const session = await getStoredSession();
  if (!session) return null;
  const devMode = session.isDevMode || !supabase;
  const partnerTz = opts.partnerTimezone ?? (devMode ? (await devMock.getProfile(opts.partnerId))?.timezone : undefined) ?? 'UTC';
  return dispatchPush(
    {
      kind: 'partner_logged',
      recipientUserId: opts.partnerId,
      recipientTimezone: partnerTz,
      recipientName: opts.partnerName ?? null,
      eventKey: opts.workoutId,
      content: { workoutType: opts.workoutType },
    },
    {},
  );
}

/**
 * invite_accepted: fired from the acceptInvite path AFTER the pairing
 * commits. Recipient = the invite's INVITER (their own device); only when
 * the inviter's pref is on (the dispatch gate handles that). Never blocks
 * the UI. `inviteeName` is the acceptor's own first name (their own data).
 */
export async function dispatchInviteAccepted(opts: {
  inviteId: string;
  inviterId: string;
  inviterTimezone?: string | null;
  inviteeName: string | null;
}): Promise<DispatchResult> {
  return dispatchPush(
    {
      kind: 'invite_accepted',
      recipientUserId: opts.inviterId,
      recipientTimezone: opts.inviterTimezone ?? 'UTC',
      recipientName: null,
      eventKey: opts.inviteId,
      content: { joinName: opts.inviteeName },
    },
    {},
  );
}

// ---------------------------------------------------------------------------
// Fire-and-forget event hooks — the ONLY call sites in the app flows
// ---------------------------------------------------------------------------

/**
 * partner_logged EVENT HOOK — call AFTER the workout row commits (logWorkout
 * path). Never blocks the UI: wraps everything in try/catch and returns no
 * promise to the caller (void). Resolves the current user's partner via the
 * pair read (dev pair state / real membership walk — same helper the weekly
 * context uses) and dispatches with the partner's name + timezone.
 */
export async function notifyPartnerLogged(workoutId: string, workoutType: string | null): Promise<void> {
  try {
    const partner = await resolveCurrentPartner();
    if (!partner) return;
    await dispatchPartnerLogged({
      workoutId,
      workoutType,
      partnerId: partner.id,
      partnerName: partner.name,
      partnerTimezone: partner.timezone,
    });
  } catch {
    // Never fail a workout log over a push. Swallowed by design.
  }
}

/**
 * invite_accepted EVENT HOOK — call AFTER the pairing commits (acceptInvite
 * path). Never blocks the UI: wraps everything in try/catch.
 */
export async function notifyInviteAccepted(opts: {
  inviteId: string;
  inviterId: string;
  inviterTimezone?: string | null;
  inviteeName: string | null;
}): Promise<void> {
  try {
    await dispatchInviteAccepted(opts);
  } catch {
    // Never fail an accept over a push. Swallowed by design.
  }
}

/**
 * invite_accepted REAL-MODE HOOK — call AFTER accept_invite returns the new
 * pair group id. The acceptor's RLS cannot read the invite row (inviter owns
 * it), so the inviter is resolved as the OTHER seat of the fresh pair group —
 * the accept just created it. Event key = the group id (unique per pairing —
 * the same accept can never fire twice).
 */
export async function notifyInviteAcceptedAfterRealPair(
  groupId: string,
  inviteeName: string | null,
): Promise<void> {
  try {
    const session = await getStoredSession();
    if (!session || !supabase) return;
    const partner = await resolveCurrentPartner();
    if (!partner) return;
    await dispatchInviteAccepted({
      inviteId: groupId, // unique per accept (the pair group id)
      inviterId: partner.id,
      inviterTimezone: null, // not cross-user readable in real mode (UTC fallback)
      inviteeName,
    });
  } catch {
    // Never fail an accept over a push. Swallowed by design.
  }
}

interface CurrentPartnerInfo {
  id: string;
  name: string | null;
  timezone: string | null;
}

/** Resolve the CURRENT user's accepted partner (dev + real, same walk as
 * fetchWeeklyContext). Null when solo. */
async function resolveCurrentPartner(): Promise<CurrentPartnerInfo | null> {
  const session = await getStoredSession();
  if (!session) return null;
  const uid = session.user.id;

  if (session.isDevMode || !supabase) {
    const pair = await devMock.getPairState(uid);
    if (!pair.partner) return null;
    const profile = await devMock.getProfile(pair.partner.id);
    return {
      id: pair.partner.id,
      name: profile?.name ?? pair.partner.name ?? null,
      timezone: profile?.timezone ?? null,
    };
  }

  try {
    const { data: myMemberships } = await supabase
      .from('memberships')
      .select('group_id')
      .eq('user_id', uid);
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
      if (userIds.length !== 2) continue;
      const other = userIds.find((u) => u !== uid);
      if (other) {
        const { data: partnerUser } = await supabase
          .from('users')
          .select('name')
          .eq('id', other)
          .maybeSingle();
        return { id: other, name: partnerUser?.name ?? null, timezone: null };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Foreground hook — the app-open trigger (client-initiated engine)
// ---------------------------------------------------------------------------

let foregroundSub: { remove(): void } | null = null;

/**
 * Subscribe to app foreground transitions. On EVERY transition to 'active',
 * re-run the app-open dispatcher (pending_invite + missed_week self-target
 * evaluations — see runAppOpenDispatches). Idempotent: calling twice keeps
 * ONE subscription. The initial mount call also runs immediately so the very
 * first open evaluates.
 *
 * Honest v1.1 limitation (plan rev 5): this is the app-open trigger of a
 * client-only engine — evaluations happen when the app is opened or brought
 * to the foreground, never on a schedule. The smoke harness exercises
 * runAppOpenDispatches directly; the subscription is the UI wiring.
 */
export function subscribePushDispatchForeground(): () => void {
  if (foregroundSub) return () => {};
  void runAppOpenDispatches(); // first open evaluates immediately
  foregroundSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') void runAppOpenDispatches();
  });
  // The returned cleanup keeps callers able to unsubscribe if they mounted
  // the hook themselves; the module-level guard prevents duplicate listeners.
  return () => {
    if (foregroundSub) {
      foregroundSub.remove();
      foregroundSub = null;
    }
  };
}