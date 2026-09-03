/**
 * Supabase Storage helpers for workout photo proofs.
 *
 * THE TRUST PIECE: the `workouts` bucket is PRIVATE. Nothing here ever
 * produces a public URL — the only way an image displays is a short-lived
 * signed URL, and only for a path the caller owns (Storage RLS enforces the
 * `${auth.uid()}/` prefix server-side; photo isolation is a release blocker).
 *
 * `photo_path` on the workouts row is the raw Storage path, never a URL.
 */
import { WORKOUT_BUCKET } from './workouts';
import { supabase } from './supabase';

const SIGNED_URL_TTL_SECONDS = 3600; // 1h — matches app-session scale; refresh is cheap

/**
 * Ask Storage for a short-lived signed URL for one object path.
 * Returns null when unavailable (dev mode, missing client, or error).
 * Signed URLs are NOT stored anywhere — regenerated per display request.
 */
export async function createSignedUrl(path: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<string | null> {
  if (!supabase) return null; // DEV MOCK — the dev store hands out local file URIs instead
  const { data, error } = await supabase.storage.from(WORKOUT_BUCKET).createSignedUrl(path, ttlSeconds);
  if (error) {
    console.warn(`[storage] signed URL failed for ${path}: ${error.message}`);
    return null;
  }
  return data.signedUrl;
}

/**
 * Batch variant — one round trip for the whole feed.
 * Returns a map path → signed URL (missing/errored paths are absent).
 */
export async function createSignedUrls(paths: string[], ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!supabase) return map;
  if (paths.length === 0) return map;
  const { data, error } = await supabase.storage.from(WORKOUT_BUCKET).createSignedUrls(paths, ttlSeconds);
  if (error) {
    console.warn(`[storage] signed URLs batch failed: ${error.message}`);
    return map;
  }
  for (const item of data ?? []) {
    if (item?.path && item.signedUrl) map.set(item.path, item.signedUrl);
  }
  return map;
}

/** Validate a workouts-row photo path before using it (defense in depth). */
export function isOwnedPhotoPath(userId: string, path: string): boolean {
  return path.startsWith(`${userId}/`) && path.endsWith('.jpg');
}