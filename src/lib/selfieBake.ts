/**
 * Selfie-filter file orchestration (dual-capture v1.0).
 *
 * Reads the captured selfie JPEG → native resize to a working width (keeps the
 * pure-JS per-pixel bake fast on Hermes) → bakes the tonal grade → writes the
 * graded JPEG to cache. The bytes written here are EXACTLY the bytes logged and
 * uploaded — "baked at capture", on-device, no preset-id upload, no
 * post-processing claim. The environment (back) shot is never filtered and
 * never routed through this module.
 *
 * UI-layer only: LogSheet calls this right after capture; the lib workout
 * store never touches filters (photo isolation + smoke harness untouched).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import { applySelfieGrade, type SelfieFilter } from './filters';

/** Cache folder for baked selfies (app cache — cleared with the OS). */
export const SELFIE_BAKE_DIR = 'spotter-selfie-bakes';

/** Working-width cap — keeps the pure-JS bake ~sub-second on the JS thread. */
const BAKE_MAX_WIDTH = 1600;
const BAKE_RESIZE_COMPRESS = 0.85;

export type BakeSelfieResult = { ok: true; uri: string } | { ok: false; error: string };

export async function bakeSelfieFiltered(
  inputUri: string,
  filter: SelfieFilter,
): Promise<BakeSelfieResult> {
  if (filter === 'none') return { ok: true, uri: inputUri };
  try {
    // 1. Native resize (expo-image-manipulator) — fast, keeps pixel count small.
    const resized = await manipulateAsync(
      inputUri,
      [{ resize: { width: BAKE_MAX_WIDTH } }],
      { compress: BAKE_RESIZE_COMPRESS, format: SaveFormat.JPEG },
    );
    // 2. Read the resized JPEG into bytes.
    const bytes = await new File(resized.uri).bytes();
    // 3. Pure color-grade bake (src/lib/filters.ts) — per-pixel matrix.
    const baked = applySelfieGrade(bytes, filter);

    // 4. Write the graded JPEG to cache; this URI is what review + feed show,
    //    and what logWorkout uploads (isolation unchanged: it becomes the
    //    selfie object under `${user_id}/`).
    const dir = new Directory(Paths.cache, SELFIE_BAKE_DIR);
    if (!dir.exists) dir.create();
    const name = `bake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const out = dir.createFile(name, 'image/jpeg');
    out.write(baked);
    return { ok: true, uri: out.uri };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Couldn\u2019t apply the filter. Try again.',
    };
  }
}