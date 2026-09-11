/**
 * V1.1 MEASUREMENT FOUNDATION (Build #1) — first-party analytics emitter.
 *
 * Two backends, no third-party SDK:
 *  - REAL: insert into public.analytics_events (authenticated INSERT only,
 *    user_id = auth.uid(); no client read — dashboards are service-role).
 *  - DEV MOCK: in-memory ring buffer (exported getter for the smoke test) +
 *    console.debug. Never touches the network.
 *
 * EVENTS WIRED IN BUILD #1 (UI exists today):
 *  - app_opened        { is_first_open }            ← AuthProvider mount
 *  - signup_completed  {}                           ← authenticate() success
 *  - pair_action       invite_created | share_tapped | code_copied |
 *                      invite_accepted | unpaired   ← invites.ts / invite UI
 *  - workout_logged    { workout_id, week_count }   ← logWorkout()
 *
 * DEFERRED (their builds wire them; the emitter already supports the names):
 *  - nudge_set / nudge_viewed        → Build #2 (nudge blank)
 *  - notification_* (permission, delivery, open, opt-out) → Build #3 (push)
 *  - recap_viewed                    → Build #4 (week recap)
 *
 * PRIVACY GUARDRAIL (non-negotiable): properties must NEVER include photo
 * paths, names, emails, nudge text, or notification body text. track() only
 * accepts ids, counts, booleans, and enum strings — pass display strings and
 * you are violating the trust model. Enforced by type (AnalyticsProps) + the
 * scrub() runtime guard below, which drops known-sensitive keys defensively.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getStoredSession, isDevMode, supabase } from './supabase';

/** Event families. The four *_WIRED families emit today; the rest are typed
 * now so Builds #2–#4 wire call sites without touching this file's API. */
export type AnalyticsEventName =
  | 'app_opened' // WIRED (AuthProvider)
  | 'signup_completed' // WIRED (authenticate)
  | 'pair_action' // WIRED (invites.ts + invite UI)
  | 'workout_logged' // WIRED (logWorkout)
  | 'nudge_set' // DEFERRED → Build #2
  | 'nudge_viewed' // DEFERRED → Build #2
  | 'notification_permission' // DEFERRED → Build #3
  | 'notification_delivered' // DEFERRED → Build #3
  | 'notification_opened' // DEFERRED → Build #3
  | 'recap_viewed'; // DEFERRED → Build #4

/** Pair-action verbs (the `action` column for pair_action events). */
export type PairAction =
  | 'invite_created'
  | 'share_tapped'
  | 'code_copied'
  | 'invite_accepted'
  | 'unpaired';

/**
 * Properties: ids, counts, booleans, enum strings ONLY. No photo_path, no
 * name/email, no nudge text, no notification body — see header.
 */
export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

/** Keys that must never reach the backend even if a caller passes them. */
const SENSITIVE_KEYS = new Set([
  'photo_path',
  'photo_uri',
  'photo_url',
  'name',
  'email',
  'nudge_text',
  'nudge',
  'notification_body',
  'body',
  'message',
]);

function scrub(props: AnalyticsProps): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(props)) {
    if (SENSITIVE_KEYS.has(k)) continue;
    if (v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    }
  }
  return out;
}

export interface TrackedEvent {
  event_name: AnalyticsEventName;
  action: string | null;
  anonymous_install_id: string | null;
  session_id: string | null;
  user_id: string | null;
  group_id: string | null;
  source_id: string | null;
  occurred_at: string;
  app_version: string | null;
  properties: Record<string, string | number | boolean | null>;
}

const INSTALL_KEY = 'spotter.install:v1';
const FIRST_OPEN_KEY = 'spotter.first_open:v1';
const SESSION_KEY = 'spotter.session_id:v1';
const APP_VERSION = '1.1.0';

const BUFFER_CAP = 200;
const devBuffer: TrackedEvent[] = [];

/** Test hook: the dev-mock ring buffer (Build #1 smoke asserts on this). */
export function getDevEventBuffer(): TrackedEvent[] {
  return [...devBuffer];
}

/** Test hook: clear the dev-mock ring buffer between smoke steps. */
export function clearDevEventBuffer(): void {
  devBuffer.length = 0;
}

/** Anonymous install id (existing storage pattern: AsyncStorage, stable per install). */
export async function getInstallId(): Promise<string> {
  try {
    let id = await AsyncStorage.getItem(INSTALL_KEY);
    if (!id) {
      id = `install_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
      await AsyncStorage.setItem(INSTALL_KEY, id);
    }
    return id;
  } catch {
    return 'install_unknown';
  }
}

/**
 * app_opened helper: returns true exactly once per install (is_first_open).
 * Backed by the same AsyncStorage pattern as the install id.
 */
export async function consumeIsFirstOpen(): Promise<boolean> {
  try {
    const seen = await AsyncStorage.getItem(FIRST_OPEN_KEY);
    if (seen) return false;
    await AsyncStorage.setItem(FIRST_OPEN_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

async function getSessionId(): Promise<string | null> {
  try {
    let id = await AsyncStorage.getItem(SESSION_KEY);
    if (!id) {
      id = `sess_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      await AsyncStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

export interface TrackOptions {
  action?: string;
  /** Pair/group context when known (e.g. invite_accepted carries the pair group). */
  groupId?: string | null;
  /** Source row id when the event references one (e.g. workout id). */
  sourceId?: string | null;
  props?: AnalyticsProps;
}

/**
 * Typed emitter. Fire-and-forget safe: never throws, never blocks UI —
 * failures are swallowed (analytics must not break the core loop).
 */
export async function track(event: AnalyticsEventName, options: TrackOptions = {}): Promise<void> {
  try {
    const session = await getStoredSession().catch(() => null);
    const [installId, sessionId] = await Promise.all([getInstallId(), getSessionId()]);
    const row: TrackedEvent = {
      event_name: event,
      action: options.action ?? null,
      anonymous_install_id: installId,
      session_id: sessionId,
      user_id: session?.user.id ?? null,
      group_id: options.groupId ?? null,
      source_id: options.sourceId ?? null,
      occurred_at: new Date().toISOString(),
      app_version: APP_VERSION,
      properties: scrub(options.props ?? {}),
    };

    if (isDevMode || !supabase) {
      devBuffer.push(row);
      if (devBuffer.length > BUFFER_CAP) devBuffer.splice(0, devBuffer.length - BUFFER_CAP);
      if (typeof console !== 'undefined' && console.debug) {
        console.debug(`[analytics:dev] ${event}${row.action ? `/${row.action}` : ''}`, row.properties);
      }
      return;
    }

    // REAL: authenticated INSERT (RLS: user_id = auth.uid() or null).
    // Best-effort — a failed insert must never surface to the user.
    try {
      await supabase.from('analytics_events').insert({
        event_name: row.event_name,
        action: row.action,
        anonymous_install_id: row.anonymous_install_id,
        session_id: row.session_id,
        user_id: row.user_id,
        group_id: row.group_id,
        source_id: row.source_id,
        occurred_at: row.occurred_at,
        app_version: row.app_version,
        properties: row.properties as unknown as Record<string, never>,
      });
    } catch {
      // Swallowed: analytics is observability, not the product.
    }
  } catch {
    // Never throw from the emitter.
  }
}
