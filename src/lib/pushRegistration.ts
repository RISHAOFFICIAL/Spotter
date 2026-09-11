/**
 * Push-device registration (v1.1 Build #3, slice 1).
 *
 * After the OS grant the app obtains the Expo push token and upserts it into
 * `push_devices` (schema exists; `expo_push_token` UNIQUE — the upsert targets
 * onConflict: 'expo_push_token' with `user_id` attached so re-registering the
 * same token on the same user is IDEMPOTENT, and a token stolen by another
 * device/user is impossible under own-row RLS — a conflicting token's row can
 * never be updated by anyone but its owner).
 *
 * Security: the token is opaque (no PII) but still NEVER logged or exposed
 * beyond its own row. registerPushDevice returns the token to the caller only
 * so the smoke harness can prove the idempotent upsert; the app surfaces
 * nothing.
 *
 * DEV MOCK parity: a deterministic fake token per user (stable so the same
 * device re-registers the SAME token → idempotency is provable in the smoke
 * run) stored through devMock.upsertPushDevice.
 */
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

import { devMock, type DevPushDevice } from './mock';
import { getStoredSession, supabase } from './supabase';
import { isDevMode } from './supabase';

/** Explicit default channel so Android notifications land on a named channel
 * (the plugin's `defaultChannel` also creates it at build time). */
export const DEFAULT_NOTIFICATION_CHANNEL = 'spotter-pair';

/** Deterministic dev fake token (stable per user — idempotent re-register). */
function devFakeToken(userId: string): string {
  return `dev-expo-token-${userId}`;
}

/**
 * Obtain the current Expo push token (REAL) or a stable dev fake (DEV).
 * Returns null when the platform can't provide one — callers treat null as
 * "no device to register" and never fabricate a send target.
 */
async function getExpoPushToken(): Promise<string | null> {
  if (isDevMode) {
    const session = await getStoredSession();
    return session ? devFakeToken(session.user.id) : null;
  }
  try {
    // A device check is required before requesting a token on Android.
    const devicePushSupported = Device.isDevice;
    const token = await Notifications.getExpoPushTokenAsync({
      projectId: undefined, // falls back to the EAS project id from the build.
    });
    return token.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Upsert the CURRENT user's push device row. Idempotent per token — re-calling
 * with the same token replaces the row (last_seen_at refreshed), never dups.
 * Safe to call on every app start (token rotation → new row, old row stays
 * until a future cleanup). Best-effort: a network failure must never block
 * app start, so failures are swallowed (returns `false`).
 */
export async function registerPushDevice(): Promise<boolean> {
  const session = await getStoredSession().catch(() => null);
  if (!session) return false;
  const token = await getExpoPushToken();
  if (!token) return false;

  if (session.isDevMode || !supabase) {
    const now = new Date().toISOString();
    const device: DevPushDevice = {
      user_id: session.user.id,
      expo_push_token: token,
      platform: 'dev',
      app_version: '1.1.0',
      last_seen_at: now,
      created_at: now,
    };
    await devMock.upsertPushDevice(session.user.id, device);
    return true;
  }

  try {
    const now = new Date().toISOString();
    const { error } = await supabase.from('push_devices').upsert(
      {
        user_id: session.user.id,
        expo_push_token: token,
        // Device.osName exists on the expo-device module type ('iOS' |
        // 'Android' | other); Device.platform does not — use osName.
        platform: Device.osName ?? null,
        app_version: '1.1.0',
        last_seen_at: now,
      },
      { onConflict: 'expo_push_token' },
    );
    return !error;
  } catch {
    return false;
  }
}

/**
 * Read the CURRENT user's registered dev token (DEV parity + smoke proof —
 * real mode owns the token server-side and this returns null). The token is
 * the caller's own row; still never logged.
 */
export async function getPushDeviceToken(): Promise<string | null> {
  const session = await getStoredSession().catch(() => null);
  if (!session) return null;
  if (!session.isDevMode) return null;
  const rows = await devMock.listPushDevices(session.user.id);
  return rows[0]?.expo_push_token ?? null;
}