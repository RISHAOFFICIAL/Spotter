/**
 * Notification EXPLAINER + permission state machine (v1.1 Build #3, slice 1).
 *
 * Two-step contextual ask — NEVER at first open:
 *   1. In-app explainer sheet (InviteSheet chrome) shown only AFTER the user is
 *      paired AND has completed their first return visit to Home (see
 *      HomeScreen — the ask fires once the pairing flip has settled AND a
 *      foreground load has run, i.e. a "return visit"). The sheet says exactly
 *      what notifications DO today (partner logs + invite accepted — "nothing
 *      else"), no invented variants.
 *   2. "Enable" then triggers the REAL OS permission prompt (expo-notifications
 *      getPermissionsAsync/requestPermissionsAsync). Dev mode mocks the grant.
 *
 * Local state machine (persisted per user in AsyncStorage):
 *   unseen → explained → granted | denied
 *   - "explained" is set the moment the sheet is shown (Enable OR Not now).
 *   - "Not now" = dismissed; the state stays `explained` and a LOCAL flag
 *     remembers the dismissed time; we re-ask at most ONCE more, and only
 *     after a long cooldown (REASK_COOLDOWN_MS, default 14 days).
 *   - "granted"/"denied" persist; a granted user never sees the sheet again.
 *   - Dev+real parity: the lib is the single owner of this machine; dev mock
 *     grants the OS prompt, real mode asks expo-notifications.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { devMock } from './mock';
import { getStoredSession } from './supabase';
import { registerPushDevice } from './pushRegistration';

export type NotificationPermissionState = 'unseen' | 'explained' | 'granted' | 'denied';

/** Long cooldown before a single re-ask after "Not now" (14 days). */
export const REASK_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

const PREFIX = 'spotter.notifperm:v1:';

interface LocalPerm {
  state: NotificationPermissionState;
  /** ISO timestamp of the last time the sheet was dismissed with "Not now". */
  dismissedAt: string | null;
}

async function readLocal(userId: string): Promise<LocalPerm> {
  try {
    const raw = await AsyncStorage.getItem(`${PREFIX}${userId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as LocalPerm;
      if (parsed && (parsed.state === 'unseen' || parsed.state === 'explained' || parsed.state === 'granted' || parsed.state === 'denied')) {
        return parsed;
      }
    }
  } catch {
    // Corrupt/absent → treat as unseen (fresh machine).
  }
  return { state: 'unseen', dismissedAt: null };
}

async function writeLocal(userId: string, perm: LocalPerm): Promise<void> {
  try {
    await AsyncStorage.setItem(`${PREFIX}${userId}`, JSON.stringify(perm));
  } catch {
    // Best-effort local flag; the machine still advances in-memory this run.
  }
}

/** Current permission state for the signed-in user ('unseen' when signed out). */
export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  const session = await getStoredSession().catch(() => null);
  if (!session) return 'unseen';
  const local = await readLocal(session.user.id);
  return local.state;
}

/**
 * Whether the explainer sheet should be offered right now. Gates:
 *  - a session exists (never before sign-in; never blocking onboarding),
 *  - the user is NOT already granted (never re-ask a granted user),
 *  - state is 'unseen' (first ask) OR 'explained' AND the cooldown since the
 *    "Not now" dismissal has elapsed (the ONE re-ask — never nag in a loop).
 */
export async function shouldAskNotificationPermission(): Promise<boolean> {
  const session = await getStoredSession().catch(() => null);
  if (!session) return false;
  const local = await readLocal(session.user.id);
  if (local.state === 'granted') return false;
  if (local.state === 'unseen') return true;
  if (local.state === 'explained') {
    if (!local.dismissedAt) return false;
    try {
      const elapsed = Date.now() - new Date(local.dismissedAt).getTime();
      return elapsed >= REASK_COOLDOWN_MS;
    } catch {
      return false; // Broken timestamp → fail silent, never nag.
    }
  }
  return false; // 'denied' → never re-ask (the user said no).
}

/**
 * Mark the sheet as shown (Enable OR Not now both advance unseen → explained;
 * the sheet can only appear when shouldAsk returned true). This runs BEFORE
 * the OS prompt so a user who closes the sheet mid-flow still lands in a
 * truthful state.
 */
export async function markNotificationExplained(): Promise<void> {
  const session = await getStoredSession().catch(() => null);
  if (!session) return;
  const local = await readLocal(session.user.id);
  if (local.state !== 'granted') await writeLocal(session.user.id, { state: 'explained', dismissedAt: local.dismissedAt });
}

/** "Not now" dismissal — remembers the timestamp for the single later re-ask. */
export async function dismissNotificationAsk(): Promise<void> {
  const session = await getStoredSession().catch(() => null);
  if (!session) return;
  await writeLocal(session.user.id, { state: 'explained', dismissedAt: new Date().toISOString() });
}

/**
 * The OS permission survey. REAL mode goes through expo-notifications'
 * getPermissionsAsync/requestPermissionsAsync with the app's honest usage
 * string. DEV mode returns `granted` (+ registers the dev fake token via
 * registerPushDevice) so the walkable demo never hits the OS prompt.
 * Returns the SETTLED permission state ('granted' | 'denied').
 */
export async function requestNotificationPermission(): Promise<'granted' | 'denied'> {
  const session = await getStoredSession();
  if (!session) return 'denied';

  if (session.isDevMode) {
    // DEV: honest mock grant — no OS prompt.
    await writeLocal(session.user.id, { state: 'granted', dismissedAt: null });
    await registerPushDevice(); // fake token, idempotent (dev parity)
    return 'granted';
  }

  // REAL: two-step (see summarized) — ask the OS only after the explainer.
  try {
    // Lazy import keeps expo-notifications OUT of the smoke compile path;
    // the Node harness stubs it if ever reached (dev path never does).
    const Notifications = await import('expo-notifications');
    const current = await Notifications.getPermissionsAsync();
    let status = current.status;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    const granted = status === 'granted';
    await writeLocal(session.user.id, { state: granted ? 'granted' : 'denied', dismissedAt: null });
    if (granted) await registerPushDevice();
    return granted ? 'granted' : 'denied';
  } catch {
    // OS/API failure — persist the honest current state (unknown → denied for
    // the sheet, but don't fabricate). No push without a confirmed grant.
    await writeLocal(session.user.id, { state: 'denied', dismissedAt: null });
    return 'denied';
  }
}

/**
 * App-start refresh: when the OS permission is ALREADY granted (returning
 * user), read the current token and re-register it so a rotated/expired token
 * gets refreshed on every launch. No-op when not granted / not signed in.
 * NEVER logs or exposes the token beyond its own-row storage.
 */
export async function refreshPushRegistrationIfGranted(): Promise<void> {
  const session = await getStoredSession().catch(() => null);
  if (!session) return;
  const local = await readLocal(session.user.id);
  if (local.state !== 'granted') return;
  // Dev mode is automatically handled (registerPushDevice uses the dev fake
  // token); real mode re-reads the OS token and upserts it idempotently.
  await registerPushDevice();
}

// Re-export the registration lib so the app calls ONE import surface.
export { registerPushDevice, getPushDeviceToken } from './pushRegistration';
export { subscribePushDispatchForeground } from './pushDispatch';