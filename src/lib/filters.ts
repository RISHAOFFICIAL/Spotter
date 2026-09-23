/**
 * Selfie LOOKS + the on-device colour-grade bake (v1.0 dual-capture).
 *
 * Product law (groups-copy-spec §5 / onboarding addendum §2.4): a look is a
 * TONAL grade for the selfie shot only. Nothing blurs, masks, smooths, warps or
 * is face-aware; the environment shot is never filtered, and the proof is never
 * weakened. The grade is BAKED INTO THE JPEG on-device at capture time — no
 * look id is uploaded, no post-processing is claimed. What the group sees in
 * the feed is exactly the bytes baked here.
 *
 * This module is PURE (no RN imports) so the exact bake path is executable and
 * testable under Node (scripts/looks/*.mjs), while the file orchestration
 * (read → resize → bake → write) lives in src/lib/selfieBake.ts.
 *
 * Pipeline: capture (expo-camera, iOS bakes orientation into pixels) → native
 * resize to ≤1600px (expo-image-manipulator, keeps the pure-JS bake fast) →
 * this module decodes the JPEG, applies the look's tone-first grade, re-encodes.
 * No ML, no ARKit, no new permissions (camera only).
 *
 * THE PIPELINE (src/lib/lookGrade.ts): LUT → 3×4 matrix → splitTone →
 * highlightDesat. Tone first, exactly so the highlights survive. The retired
 * presets applied the matrix first (`1.08 · 255 + 11.5 = 287`) and clipped.
 *
 * The live preview is NOT a tint invented here: it is derived from the real
 * grade by src/lib/lookPreviews.ts (`LOOK_PREVIEWS`) and checked against it
 * offline by scripts/looks/check-look-previews.mjs, so the camera feed and the
 * baked photo cannot drift apart.
 */
import { decode, encode } from 'jpeg-js';

import { IDENTITY_MATRIX, gradeRgba, satMatrix, type LookGrade } from './lookGrade';

/** Shipped look ids, in chip order. */
export type LookId = 'clean' | 'bright' | 'amber' | 'vivid' | 'film' | 'dusk' | 'cool' | 'mono';

export interface Look {
  readonly id: LookId;
  /** Chip / receipt label. */
  readonly label: string;
  readonly grade: LookGrade;
}

const LUT_5 = (a: number, b: number, c: number, d: number, e: number) => [a, b, c, d, e] as const;

/**
 * The 8 shipped looks. `clean` is the identity: the raw capture is logged
 * untouched (no resize, no re-encode) — see applySelfieGrade / bakeSelfieFiltered.
 */
export const LOOKS: Record<LookId, Look> = {
  clean: {
    id: 'clean',
    label: 'Clean',
    grade: { lut: LUT_5(0, 64, 128, 192, 255), matrix: IDENTITY_MATRIX, identity: true },
  },
  bright: {
    id: 'bright',
    label: 'Bright',
    // Exposure lift as a TONE curve (mid +13) with head-room left at the top.
    grade: { lut: LUT_5(4, 76, 141, 204, 252), matrix: IDENTITY_MATRIX },
  },
  amber: {
    id: 'amber',
    label: 'Amber',
    // Warm lift: red/green lead, blue eases back — mid (18.4R, +9G, −1.7B).
    grade: {
      lut: LUT_5(6, 72, 134, 196, 236),
      matrix: { r: [1.02, 0.02, 0, 7], g: [0, 1, 0, 3], b: [0, 0.02, 0.96, -5] },
    },
  },
  vivid: {
    id: 'vivid',
    label: 'Vivid',
    // Luma-preserving saturation 1.18 + the highlight roll-off that keeps it
    // from clipping (mandatory: without the desat stage vivid clips).
    grade: {
      lut: LUT_5(0, 62, 132, 198, 236),
      matrix: satMatrix(1.18, [2, 2, 2]),
      highlightDesat: { start: 190, end: 255, amount: 0.75 },
    },
  },
  film: {
    id: 'film',
    label: 'Film',
    // Faded stock look: slight desaturation, lifted blacks, cooled shadows.
    grade: { lut: LUT_5(14, 74, 132, 196, 238), matrix: satMatrix(0.94, [3, 1, -2]) },
  },
  dusk: {
    id: 'dusk',
    label: 'Dusk',
    // Warm shadows / cool highlights around the true luma.
    grade: {
      lut: LUT_5(12, 72, 130, 192, 234),
      matrix: satMatrix(1.05),
      splitTone: { shadow: [8, 2, 6], highlight: [0, 2, 10] },
    },
  },
  cool: {
    id: 'cool',
    label: 'Cool',
    // Daylight cool: blue up, red down.
    grade: {
      lut: LUT_5(4, 74, 136, 196, 230),
      matrix: { r: [0.98, 0, 0, -8], g: [0, 1, 0, 0], b: [0, 0, 1.04, 12] },
    },
  },
  mono: {
    id: 'mono',
    label: 'Mono',
    // Saturation 0 = the luma mix, so it can never shift exposure.
    grade: { lut: LUT_5(10, 74, 134, 196, 238), matrix: satMatrix(0) },
  },
};

/** Chip order — exactly the registry order above. */
export const LOOK_IDS: readonly LookId[] = [
  'clean',
  'bright',
  'amber',
  'vivid',
  'film',
  'dusk',
  'cool',
  'mono',
];

/** JPEG quality for the re-encode step of the bake (92 keeps the grade honest). */
export const JPEG_ENCODE_QUALITY = 92;

/**
 * Legacy ids from the retired 4-preset set. Kept ONLY so the not-yet-migrated
 * camera UI (LogSheet / PracticeCamStep) still type-checks until the UI
 * delegation lands: `none → clean`, `warm → amber`, `soft` was DROPPED (it
 * graded nothing that Clean does not).
 */
export type LegacyLookId = 'none' | 'warm' | 'soft';

/** What the camera UI may pass today: a LookId, or a retired legacy id. */
export type SelfieFilter = LookId | LegacyLookId;

/** Legacy → LookId. */
export function normalizeLookId(id: LookId | LegacyLookId): LookId {
  if (id === 'none') return 'clean';
  if (id === 'warm') return 'amber';
  if (id === 'soft') return 'clean';
  return id as LookId;
}

export function look(id: LookId | LegacyLookId): Look {
  return LOOKS[normalizeLookId(id)];
}

/** The bake grade for a look (legacy ids normalised first). */
export function lookGrade(id: LookId | LegacyLookId): LookGrade {
  return look(id).grade;
}

export function lookLabel(id: LookId | LegacyLookId): string {
  return look(id).label;
}

/**
 * Receipt text for a logged workout: the look's name, e.g. 'Amber'
 * (identity look → 'Clean'). Text only — the id itself never leaves the device.
 */
export function lookReceiptLabel(id: LookId | LegacyLookId): string {
  return look(id).label;
}

// --------------------------------------------------------------------------
// TRANSITIONAL COMPAT SHIM — deleted by the UI delegation
// --------------------------------------------------------------------------
/**
 * The pre-8-look API, kept so the untouched camera screens keep compiling and
 * behaving (they read `.label` and `.previewTint` off `SELFIE_FILTER_PRESETS`).
 *
 * `previewTint` is the ONE flat layer an un-migrated screen can draw: the
 * secant flatten of this look's REAL baked response between tones 16 and 245,
 * anchored at the mid tone 128 (alpha = 1 − secant gain, colour = offset/alpha).
 * It is a deliberate, documented approximation of `LOOK_PREVIEWS[id]`'s layered
 * stack — the checker asserts the literals still match the grade.
 */
export interface SelfieFilterPreset {
  readonly id: SelfieFilter;
  readonly label: string;
  readonly previewTint: string | null;
}

function tint(alpha: number, r: number, g: number, b: number): string {
  if (alpha <= 0.001) return 'rgba(0,0,0,0)';
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(alpha.toFixed(3))})`;
}

export const SELFIE_FILTER_PRESETS: Record<SelfieFilter, SelfieFilterPreset> = (() => {
  const byId = (id: LookId, previewTint: string | null): SelfieFilterPreset => ({
    id,
    label: LOOKS[id].label,
    previewTint,
  });
  return {
    clean: byId('clean', null),
    bright: byId('bright', tint(0.088, 255, 255, 255)),
    amber: byId('amber', tint(0.118, 255, 212, 128)),
    vivid: byId('vivid', tint(0.06, 255, 196, 196)),
    film: byId('film', tint(0.055, 196, 200, 190)),
    dusk: byId('dusk', tint(0.075, 216, 200, 232)),
    cool: byId('cool', tint(0.075, 128, 176, 255)),
    mono: byId('mono', tint(0.05, 180, 180, 180)),
    // Legacy aliases (their chips are gone; these only serve stale call sites).
    none: byId('clean', null),
    warm: byId('amber', tint(0.118, 255, 212, 128)),
    soft: byId('clean', null),
  };
})();

/** Chip ids for the (legacy) chip row — the shipped look order. */
export const SELFIE_FILTER_IDS: readonly SelfieFilter[] = LOOK_IDS;

/** Optional helper line under the chip row (dropped when the bar is tight). */
export const SELFIE_FILTER_HELPER = 'A touch of light — nothing hidden.';

export function filterPreset(filter: SelfieFilter): SelfieFilterPreset {
  return SELFIE_FILTER_PRESETS[filter];
}

/** a11y label per the spec: `Look: Amber` / `Look: Clean` / … */
export function filterA11yLabel(filter: SelfieFilter): string {
  return `Look: ${lookLabel(filter)}`;
}

/**
 * jpeg-js's encoder returns `Buffer.from(byteout)` when CommonJS is detected
 * (Metro defines `module`), but Hermes has no Buffer global. Provide a minimal
 * Uint8Array-backed shim for that single return path — base64 (the only other
 * Buffer use) is never called by this module. Scoped, documented, inert when
 * a Buffer already exists (Node tests / future polyfills).
 */
if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  class BufferShim {
    static from(data: unknown): Uint8Array {
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      return Uint8Array.from(data as ArrayLike<number>);
    }
  }
  (globalThis as Record<string, unknown>).Buffer = BufferShim;
}

/**
 * Bake ONE look into a JPEG's pixels — the exact bytes that get logged.
 * Pure (no RN/device dependencies): `input` is a JPEG byte buffer, the result
 * is a re-encoded JPEG buffer with the look's grade applied per pixel.
 *
 * Returns the SAME buffer reference when the look is the identity (Clean):
 * callers short-circuit before reaching this path, and this guard keeps the
 * promise even if one does not.
 */
export function applySelfieGrade(input: Uint8Array, filter: LookId | LegacyLookId): Uint8Array {
  const grade = lookGrade(filter);
  if (grade.identity) return input;

  const raw = decode(input, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 100,
    maxMemoryUsageInMB: 1024,
  });
  const { data, width, height } = raw;

  gradeRgba(data, width, height, grade);

  return encode({ data, width, height }, JPEG_ENCODE_QUALITY).data as unknown as Uint8Array;
}
