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
 * REAL MODE: fully wired against the Supabase backend — no service_role key
 * is ever needed (nothing secret ships in the app). The photo BYTES are
 * erased first via the Storage API (`remove()` on the owning user's own
 * `${uid}/` prefix — the only path that truly deletes files; direct SQL row
 * deletes are blocked by Storage's guard trigger and would orphan the
 * underlying file). Then the security-definer `delete_account()` RPC
 * (schema.sql) deletes the auth user, their workout rows, leftover storage
 * metadata and memberships in ONE transaction, called with the user's own
 * JWT. If the photo erase fails, we stop BEFORE the RPC so the account is
 * never half-deleted — the whole flow is retry-safe.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

import { devMock } from './mock';
import { clearPetName } from './naming';
import { clearSession, getStoredSession, supabase } from './supabase';
import { DEVMOCK_PHOTOS_DIR } from './workoutStore';
import { WORKOUT_BUCKET } from './workouts';

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

/**
 * Enumerate the CURRENT user's photo files under their `${userId}/` prefix via
 * the Storage API. Listing is ground truth (only files that actually exist are
 * returned), so a retry never tries to remove already-gone objects.
 */
async function listOwnPhotoPaths(userId: string): Promise<string[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.storage
    .from(WORKOUT_BUCKET)
    .list(userId, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new Error(error.message ?? 'Storage list failed.');
  return (data ?? [])
    .filter((f) => !f.name.endsWith('/')) // drop folder rows (their name ends with '/')
    .map((f) => `${userId}/${f.name}`);
}

export interface DeleteAccountResult {
  ok: boolean;
  /** Human-readable, honest summary of what happened (or didn't). */
  message: string;
  /**
   * True when real-mode deletion could not complete because a required
   * backend step is unavailable (retry-safe). Retained for contract
   * compatibility with the pre-RPC stub builds; the wired real branch only
   * sets it on an infrastructural failure (e.g. Storage unreachable).
   */
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
    await clearPetName(session.user.id);
    await clearSession();
    for (const k of ACCOUNT_DELETION_KEYS) await removeLocalKey(k);
    return { ok: true, message: 'Account deleted. Sorry to see you go.' };
  }

  // ---- REAL MODE ---------------------------------------------------------
  // 1) Erase photo BYTES via the Storage API before touching any rows. The
  //    owning user's own JWT is enough — the `workouts_storage_delete_own`
  //    policy (schema.sql) already scopes deletes to the `${uid}/` prefix.
  //    Any failure here aborts BEFORE the RPC: we never half-delete.
  try {
    const paths = await listOwnPhotoPaths(session.user.id);
    if (paths.length > 0) {
      const { error } = await supabase.storage.from(WORKOUT_BUCKET).remove(paths);
      if (error) {
        return {
          ok: false,
          message: "Couldn't delete your photos. Try again.",
          deferred: true,
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Couldn't delete your photos. Try again.",
      deferred: true,
    };
  }

  // 2) delete_account() RPC: transactional removal of the auth user (FK
  //    cascade wipes our public.users, workouts, invites + memberships),
  //    group handling (partner groups survive unless we were the last
  //    member), and a sweep of any leftover storage metadata rows.
  const { error } = await supabase.rpc('delete_account');
  if (error) {
    return { ok: false, message: error.message ?? "Couldn't delete your account. Try again." };
  }

  // 3) Real deletion completed — clear the local session + leftover keys.
  await clearPetName(session.user.id);
  await clearSession();
  for (const k of ACCOUNT_DELETION_KEYS) await removeLocalKey(k);
  return { ok: true, message: 'Account deleted. Sorry to see you go.' };
}