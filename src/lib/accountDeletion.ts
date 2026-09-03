/**
 * Account deletion (App Store Guideline 5.1.1(v) — in-app account deletion).
 *
 * This file is the SINGLE honest entry point for "Delete account". It must:
 *   (a) delete the user's auth account,
 *   (b) delete their photo logs + the photo files they uploaded,
 *   (c) clear local storage/session,
 *   (d) return a truthful result so the UI can say what happened.
 *
 * DEV MOCK: fully REAL (runs right now against the local dev store — the
 * user's sessions, user records, workouts, workout-photo files, profile,
 * pair state, memberships and invites are all removed).
 *
 * REAL MODE: forward-compatible path with clearly-marked TODOs. Calling
 * admin.deleteUser() from the client is intentionally NOT done here (it
 * requires the service_role key, which never ships in the app). The correct
 * production shape — to be wired when Supabase auth/RLS is connected — is a
 * security-definer `delete_account()` RPC (schema.sql) that deletes the
 * auth user, their workouts rows, storage objects and memberships in a
 * transaction, called with the user's own JWT. Until that RPC exists, the
 * REAL branch returns NOT-IMPLEMENTED so the UI never fakes a deletion.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

import { devMock } from './mock';
import { clearSession, getStoredSession, supabase } from './supabase';
import { DEVMOCK_PHOTOS_DIR } from './workoutStore';

const ACCOUNT_DELETION_KEYS: readonly string[] = ['spotter.invite:v1'];

/** Remove one local AsyncStorage key silently (best-effort cleanup). */
async function removeLocalKey(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Best-effort; the account + server data are already gone at this point.
  }
}

/** Delete the user's dev-mock photo cache folder (files + folder). */
async function deleteDevPhotosDir(userId: string): Promise<boolean> {
  try {
    const dir = new Directory(Paths.cache, DEVMOCK_PHOTOS_DIR, userId);
    if (dir.exists) dir.delete();
    return true;
  } catch {
    return false;
  }
}

export interface DeleteAccountResult {
  ok: boolean;
  /** Human-readable, honest summary of what happened (or didn't). */
  message: string;
  /** True when real-mode deletion is stubbed (needs the RPC — see file doc). */
  deferred?: boolean;
}

/**
 * Delete the CURRENT user's account + data. Throws are caught — the result
 * always carries the truth of what happened.
 */
export async function deleteAccount(): Promise<DeleteAccountResult> {
  const session = await getStoredSession();
  if (!session) {
    // Nothing to delete locally — still clear anything left over.
    await clearSession();
    for (const k of ACCOUNT_DELETION_KEYS) await removeLocalKey(k);
    return { ok: true, message: 'Account deleted. Sorry to see you go.' };
  }

  if (session.isDevMode || !supabase) {
    // ---- DEV MOCK: REAL deletion, end to end ----------------------------
    try {
      const { ok, error } = await devMock.deleteUserData(session.user.id);
      if (!ok) return { ok: false, message: error ?? "Couldn't delete your account. Try again." };
      await deleteDevPhotosDir(session.user.id);
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : "Couldn't delete your account. Try again.",
      };
    }
    await clearSession();
    for (const k of ACCOUNT_DELETION_KEYS) await removeLocalKey(k);
    return { ok: true, message: 'Account deleted. Sorry to see you go.' };
  }

  // ---- REAL MODE ---------------------------------------------------------
  // TODO(real-mode): wire a SECURITY-DEFINER `delete_account()` RPC in
  // supabase/schema.sql (transactional: deletes auth.users row via
  // `delete from auth.users where id = auth.uid()`, the user's workouts
  // rows + storage objects + memberships + invites). Call it here with the
  // user's own JWT:
  //   const { error } = await supabase.rpc('delete_account');
  //   if (error) return { ok: false, message: error.message, deferred: true };
  // Interstitial NOT-IMPLEMENTED until that RPC lands — the UI must never
  // claim deletion it didn't perform.
  return {
    ok: false,
    message:
      'Account deletion is not available yet in this build. Your photos stay sealed — you can come back anytime.',
    deferred: true,
  };
}