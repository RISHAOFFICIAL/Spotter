/**
 * Selfie filter presets + the on-device color-grade bake (v1.0 dual-capture).
 *
 * Product law (groups-copy-spec §5; AMENDED 2026-10-05 — see
 * `onboarding-copy-addendum-2026-09-11.md` §2.4 and
 * `beauty-mode-scope-2026-10-05.md`): the owner reversed the flat "no beauty"
 * ban on 2026-10-05 and approved a GEOMETRY-FREE enhancement alongside the
 * tonal looks.
 *
 *   LOOK family (tonal only): amber lift (Warm), exposure lift (Bright),
 *   gentle contrast roll-off (Soft).
 *   SKIN family (geometry-free): Glow — a skin-range colour grade. Its mask is
 *   a per-pixel YCbCr chroma test, NEVER face detection, NEVER a landmark,
 *   NEVER ML, NEVER ARKit, and it ships no native module and no new permission.
 *
 * THE HARD LINE, unchanged and now enforced by a gate
 * (`scripts/smoke/skin-caps-guard.cjs`): no pixel ever moves, no face is
 * reshaped, no landmark is estimated, and the caps in
 * `beauty-mode-scope-2026-10-05.md` §1 are numbers the bake is measured
 * against. A colour grade costs the proof ("a live-camera proof you actually
 * worked out") nothing; a geometry change would cost it on every log forever.
 * The back (environment) shot is ALWAYS unfiltered, in every family.
 *
 * Honesty law: the grade is BAKED INTO THE JPEG on-device at capture time —
 * no filter preset id is uploaded, no post-processing is claimed. What the
 * group sees in the feed is exactly the bytes that were baked here.
 *
 * This module is PURE (no RN imports) so the exact bake path is executable
 * and testable under Node (scripts + dev verification), while the file
 * orchestration (read → resize → bake → write) lives in src/lib/selfieBake.ts.
 *
 * Pipeline: capture (expo-camera, iOS bakes orientation into pixels) → native
 * resize to ≤1600px (expo-image-manipulator, keeps the pure-JS bake fast) →
 * this module decodes the JPEG, applies the per-pixel matrix, re-encodes.
 * No ML, no ARKit, no new permissions (camera only).
 */
import { decode, encode } from 'jpeg-js';

export type SelfieLookFilter = 'none' | 'warm' | 'bright' | 'soft';

export type SelfieEnhancementFilter = 'glow';

export type SelfieFilter = SelfieLookFilter | SelfieEnhancementFilter;

/** Which chip family a preset belongs to — one choice overall, two rows. */
export type SelfieFilterFamily = 'look' | 'skin';

/** LOOK family — the tonal grades (single-select across BOTH families). */
export const SELFIE_FILTER_IDS: readonly SelfieLookFilter[] = ['none', 'warm', 'bright', 'soft'];

/**
 * SKIN family — geometry-free enhancements. Glow is the whole family for now:
 * `beauty-mode-scope-2026-10-05.md` §6 makes "Polish" (a skin-masked smoothing
 * pass) conditional on proving the bake budget AND the detail floor at the
 * 1600 px bake width *on Hermes*. The detail floor is measurable offline; the
 * Hermes bake budget is not measurable in this environment (there is no Hermes
 * VM — `node_modules/react-native/sdks/hermes-engine` ships build scripts, not a
 * binary), so Polish is NOT implemented and NOT shippable yet.
 */
export const SELFIE_ENHANCEMENT_IDS: readonly SelfieEnhancementFilter[] = ['glow'];

/** Group labels for the two chip rows (uppercase per tokens). */
export const SELFIE_FILTER_FAMILY_LABELS: Record<SelfieFilterFamily, string> = {
  look: 'LOOK',
  skin: 'SKIN',
};

/** The two chip rows, in render order — one source of truth for both surfaces. */
export const SELFIE_FILTER_FAMILIES: readonly {
  family: SelfieFilterFamily;
  label: string;
  ids: readonly SelfieFilter[];
}[] = [
  { family: 'look', label: SELFIE_FILTER_FAMILY_LABELS.look, ids: SELFIE_FILTER_IDS },
  { family: 'skin', label: SELFIE_FILTER_FAMILY_LABELS.skin, ids: SELFIE_ENHANCEMENT_IDS },
];

/**
 * Inline, NON-MODAL first-use disclosure for the SKIN family (verbatim from
 * `beauty-mode-scope-2026-10-05.md`, appendix). It is rendered from the first
 * tap onward while an enhancement is selected — never a modal (this app has
 * already lost a session to a native modal layer misbehaving on the capture
 * surface) and never persisted (no storage read, no storage write, no flag).
 * Every clause is true of the shipped Glow grade: on-device, selfie-only,
 * no shape / body / place change, and the surroundings photo is untouched.
 *
 * IF A GEOMETRY FEATURE IS EVER BUILT, THIS SENTENCE BECOMES A LIE. Changing
 * pixels' positions means the shape clause has to go, and the copy would then
 * have to sit under the app's own "proof it's you" line. That is the copy
 * argument against geometry, and it is independent of the engineering cost.
 */
export const SELFIE_ENHANCEMENT_DISCLOSURE =
  'On your phone, selfie only. Glow and Polish even out light and skin tone before it’s shared. They never change your face’s shape, your body, or the place — and the surroundings photo is never edited.';

/**
 * The authoritative preview line. An enhancement is a masked colour grade that
 * a flat full-bleed tint cannot show, so the live viewfinder makes NO claim
 * about it: the chip carries a swatch-free label and the REVIEW thumb — which
 * is the actual baked JPEG, the exact bytes that are uploaded — is the preview
 * that counts. Drawn only on the LOG surface: the practice camera posts
 * nothing, so "your group sees" would be false there.
 */
export const SELFIE_REVIEW_HONESTY_LINE = 'This is exactly what your group sees.';

/**
 * A 20-value SVB-style color matrix, row-major per output channel:
 *   [Rr Rg Rb Ra Ro | Gr Gg Gb Ga Go | Br Bg Bb Ba Bo | Ar Ag Ab Aa Ao]
 * Offsets (o) are fractions of 255 — multiplied by 255 per pixel.
 * The alpha row is the identity (JPEG is opaque; alpha is never graded).
 */
export type ColorMatrix = readonly [
  number, number, number, number, number,
  number, number, number, number, number,
  number, number, number, number, number,
  number, number, number, number, number,
];

export interface SelfieFilterPreset {
  id: SelfieFilter;
  /** Which chip row it belongs to. */
  family: SelfieFilterFamily;
  /** Chip label (surface text only; a11y label = `Filter: {label}` / `Enhancement: {label}`). */
  label: string;
  /**
   * Live-preview overlay tint approximating the baked grade on the camera feed.
   * ALWAYS null for the SKIN family: a masked colour grade is not a flat tint,
   * and a tint that cannot agree with the baked bytes is the honesty failure we
   * already fixed once. The review thumb is the enhancement's preview.
   */
  previewTint: string | null;
  /**
   * The baked per-pixel grade for the LOOK family. The SKIN family's grade is
   * not expressible as one matrix (it is mask-conditioned), so its matrix is the
   * identity and `applySelfieEnhancementRGBA` does the work — see
   * `isEnhancementFilter`.
   */
  matrix: ColorMatrix;
}

const identity: ColorMatrix = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/** Warm — amber lift + warm shadows (slight red/green boost, blue suppression). */
const warmMatrix: ColorMatrix = [
  1.06, 0.02, 0.00, 0, 0.045,
  0.00, 1.00, 0.00, 0, 0.028,
  0.00, 0.02, 0.96, 0, 0.000,
  0, 0, 0, 1, 0,
];

/** Bright — exposure lift (uniform scale + small lift). */
const brightMatrix: ColorMatrix = [
  1.08, 0.00, 0.00, 0, 0.045,
  0.00, 1.08, 0.00, 0, 0.045,
  0.00, 0.00, 1.08, 0, 0.045,
  0, 0, 0, 1, 0,
];

/** Soft — gentle contrast roll-off around mid-gray (0.90 × in + 12.8). */
const softMatrix: ColorMatrix = [
  0.90, 0.00, 0.00, 0, 0.050,
  0.00, 0.90, 0.00, 0, 0.050,
  0.00, 0.00, 0.90, 0, 0.050,
  0, 0, 0, 1, 0,
];

export const SELFIE_FILTER_PRESETS: Record<SelfieFilter, SelfieFilterPreset> = {
  none: { id: 'none', family: 'look', label: 'None', previewTint: null, matrix: identity },
  warm: { id: 'warm', family: 'look', label: 'Warm', previewTint: 'rgba(255, 168, 64, 0.12)', matrix: warmMatrix },
  bright: { id: 'bright', family: 'look', label: 'Bright', previewTint: 'rgba(255, 255, 255, 0.08)', matrix: brightMatrix },
  soft: { id: 'soft', family: 'look', label: 'Soft', previewTint: 'rgba(0, 0, 0, 0.06)', matrix: softMatrix },
  // SKIN family. previewTint: null is load-bearing — see the interface comment.
  glow: { id: 'glow', family: 'skin', label: 'Glow', previewTint: null, matrix: identity },
};

/** True for the geometry-free SKIN family (the masked grade, not a matrix). */
export function isEnhancementFilter(filter: SelfieFilter): filter is SelfieEnhancementFilter {
  return SELFIE_FILTER_PRESETS[filter].family === 'skin';
}

/**
 * Helper line under the LOOK chip row. Kept verbatim and scoped to the row it
 * labels: it is a truthful description of three TONAL grades ("nothing hidden"
 * = no blur, no mask, no reshaping). It is NOT rendered under the SKIN row —
 * that row carries `SELFIE_ENHANCEMENT_DISCLOSURE` instead, because the same
 * sentence over a skin grade would describe something else. Keeping one string
 * and one row is the fix; the string itself never became false.
 */
export const SELFIE_FILTER_HELPER = 'A touch of light — nothing hidden.';

export function filterPreset(filter: SelfieFilter): SelfieFilterPreset {
  return SELFIE_FILTER_PRESETS[filter];
}

/**
 * a11y label per the spec: `Filter: None` / `Filter: Warm` / … for the LOOK
 * family, and `Enhancement: Glow` for the SKIN family (memo appendix). The
 * family decides the word, so the two rows can never announce themselves as
 * the same kind of control.
 */
export function filterA11yLabel(filter: SelfieFilter): string {
  const preset = SELFIE_FILTER_PRESETS[filter];
  const kind = preset.family === 'skin' ? 'Enhancement' : 'Filter';
  return `${kind}: ${preset.label}`;
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

function clamp255(v: number): number {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

// ---------------------------------------------------------------------------
// SKIN family — the geometry-free enhancement grade.
//
// THE WHOLE DESIGN IN ONE SENTENCE: inside a per-pixel skin-range CHROMA test,
// mix each channel a little toward a level below white; outside it, change
// nothing at all. No pixel moves, no landmark is estimated, no model is loaded,
// nothing leaves the device, and the environment shot is not routed here.
//
// WHY THE NUMBERS MAKE THE CAPS HOLD BY CONSTRUCTION, not by luck.
// Note first that a bound and an implementation can disagree about *shape*: the
// memo's Level A row calls Glow "a colour matrix", but a single matrix applies
// the same transform to every pixel, so it cannot lift skin and leave the room
// within ±2/255 at the same time — those two caps are only jointly satisfiable
// by a MASK-CONDITIONED grade. The caps are the binding thing, so Glow is a
// masked grade and the "colour matrix" phrasing is superseded; the memo's own
// Level B already describes exactly this per-pixel YCbCr chroma test.
//
// Let `in` be a channel in 0..255 and `t` the mix amount toward WHITE (255):
//     out = in·(1 − t) + 255·t
//   • HUES: every channel difference scales by (1 − t), so out_i − out_j =
//     (1 − t)(in_i − in_j). HLS hue is a function of those differences alone, so
//     the hue drift is EXACTLY ZERO (only per-channel rounding moves it, and the
//     gate measures the residue).
//   • HLS SATURATION: S = Δ/(2·255 − max − min); Δ and the denominator both
//     scale by (1 − t) — and the white reference stays 255 because the mix
//     target IS white — so S is EXACTLY preserved. (Mixing toward a level below
//     white would NOT preserve it; that is why the target is 255 and the safety
//     is a cap on the MIX, below.)
//   • LUMINANCE LIFT: Y' = Y(1 − t) + 255t, i.e. relative lift t(255 − Y)/Y,
//     monotonic in t. Solving t for a cap L bounds the lift for EVERY pixel —
//     deliberately *relative*, so dark skin is lifted by the same 7% as light
//     skin and the grade can never read as "it lightens people":
//         t ≤ L·Y/(255 − Y).
//   • CLIPPING: t < 1 and in ≤ 255 give out < 255 strictly, so the grade cannot
//     add a single pixel at 255 — the measured defect of the existing Bright
//     preset. (At Y → 255 the lift bound above wants t → 1, so a second, cruder
//     cap does the work there: t <= SKIN_MIX_MAX = 0.30. A pixel near white
//     therefore gets a small lift or none, never a grey-out — which is exactly
//     what a specular highlight must do.)
//   • SHADOW CRUSH: out ≥ in everywhere, so nothing new appears below 4/255.
//   • OUT-OF-MASK DELTA: pixels outside the mask are not written at all — the
//     delta is exactly 0, not "within 2/255".
//
// The mask is a rule, not a model: YCbCr within the classic skin rectangle
// (from Chai & Ngan's skin rectangle, tightened at the Cr edge so saturated lip tones fall outside: 80 ≤ Cb ≤ 124, 135 ≤ Cr ≤ 165), never below a luma floor, with
// a small chroma + luma feather so the boundary is a ramp rather than a seam.
// KNOWN LIMITATION, stated rather than hidden: a chroma-range test cannot tell
// skin from anything else warm and mid-dark (some wood, some beige walls), so a
// misfiring mask lifts those by the same relative cap. That is exactly why the
// grade is capped at 7.5% relative and why the mask is a range test, not a claim
// about faces. `scripts/smoke/skin-caps-guard.cjs` measures a fixture set.
// ---------------------------------------------------------------------------

/** The relative luminance lift cap enforced per pixel (≤ the memo's +8%). */
export const SKIN_LIFT_MAX = 0.07;

/** The level the grade mixes toward — white, so hue and saturation are exact. */
export const SKIN_MIX_TARGET = 255;

/**
 * Hard ceiling on the mix amount. Only binds on near-white pixels, where the
 * lift bound asks for a mix that would grey the pixel out; 0.30 keeps every
 * pixel's colour direction intact while still leaving a small lift.
 */
export const SKIN_MIX_MAX = 0.3;

/** Classic skin-chroma rectangle (Chai & Ngan, YCbCr, BT.601 full range). */
export const SKIN_CB_MIN = 80;
export const SKIN_CB_MAX = 124;
export const SKIN_CR_MIN = 135;
export const SKIN_CR_MAX = 165;
/** Below this luma nothing is touched (dark hair, shadows) — with a ramp. */
export const SKIN_LUMA_FLOOR = 48;
export const SKIN_LUMA_RAMP = 24;
/** Chroma-level ramp inside the rectangle's edge (softens the boundary). */
export const SKIN_CHROMA_FEATHER = 6;

/**
 * The mask weight in 0..1 for one pixel: 1 well inside the skin range, ramping
 * to 0 at the range's edge and at the luma floor. Exported because the caps gate
 * measures the grade through the same function the bake uses — one definition.
 */
export function skinMaskWeight(r: number, g: number, b: number): number {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y >= SKIN_MIX_TARGET) return 0;
  const yw = (y - SKIN_LUMA_FLOOR) / SKIN_LUMA_RAMP;
  if (yw <= 0) return 0;
  const cb = 128 + (-0.168736 * r - 0.331264 * g + 0.5 * b);
  const cr = 128 + (0.5 * r - 0.418688 * g - 0.081312 * b);
  const d = Math.min(
    Math.min(cb - SKIN_CB_MIN, SKIN_CB_MAX - cb),
    Math.min(cr - SKIN_CR_MIN, SKIN_CR_MAX - cr),
  );
  if (d <= 0) return 0;
  const cw = d >= SKIN_CHROMA_FEATHER ? 1 : d / SKIN_CHROMA_FEATHER;
  return Math.min(1, cw * Math.min(1, yw));
}

/**
 * Per-level relative lift cap. One entry today; a new level is a new number
 * here, never a second code path.
 */
export const SKIN_ENHANCEMENT_LIFT: Record<SelfieEnhancementFilter, number> = {
  glow: SKIN_LIFT_MAX,
};

/**
 * Apply the SKIN-family grade in place over an RGBA buffer — the bytes that get
 * encoded and logged. Pure, no RN imports, no device dependency: executable
 * under Node so the caps gate measures the shipping transform itself.
 */
export function applySelfieEnhancementRGBA(
  data: Uint8Array | Uint8ClampedArray,
  filter: SelfieEnhancementFilter,
): void {
  const maxLift = SKIN_ENHANCEMENT_LIFT[filter];
  const target = SKIN_MIX_TARGET;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const w = skinMaskWeight(r, g, b);
    if (w <= 0) continue;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    if (y <= 0 || y >= target) continue;
    const tLift = (maxLift * y) / (target - y);
    const t = (tLift < SKIN_MIX_MAX ? tLift : SKIN_MIX_MAX) * w;
    if (t <= 0) continue;
    const keep = 1 - t;
    data[i] = clamp255(r * keep + target * t);
    data[i + 1] = clamp255(g * keep + target * t);
    data[i + 2] = clamp255(b * keep + target * t);
    // Alpha untouched — JPEGs are opaque.
  }
}

/**
 * Bake ONE grade into a JPEG's pixels — the exact bytes that get logged.
 * Pure (no RN/device dependencies): `input` is a JPEG byte buffer, the result
 * is a re-encoded JPEG buffer with the grade applied per pixel.
 * Returns the SAME buffer reference for 'none' — callers skip the pipeline
 * entirely before reaching this path.
 *
 * LOOK family: a global color matrix. SKIN family: the mask-conditioned grade
 * above. Both write nothing else — one decode, one per-pixel pass, one encode.
 */
export function applySelfieGrade(input: Uint8Array, filter: SelfieFilter): Uint8Array {
  const preset = filterPreset(filter);
  if (filter === 'none') return input;

  const raw = decode(input, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 100,
    maxMemoryUsageInMB: 1024,
  });
  const { data, width, height } = raw;

  if (isEnhancementFilter(filter)) {
    applySelfieEnhancementRGBA(data, filter);
    return encode({ data, width, height }, 88).data as unknown as Uint8Array;
  }

  const m = preset.matrix;
  const a0 = m[0], a1 = m[1], a2 = m[2], a4 = m[4] * 255;
  const b0 = m[5], b1 = m[6], b2 = m[7], b4 = m[9] * 255;
  const c0 = m[10], c1 = m[11], c2 = m[12], c4 = m[14] * 255;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    data[i] = clamp255(a0 * r + a1 * g + a2 * b + a4);
    data[i + 1] = clamp255(b0 * r + b1 * g + b2 * b + b4);
    data[i + 2] = clamp255(c0 * r + c1 * g + c2 * b + c4);
    // Alpha untouched — JPEGs are opaque.
  }

  return encode({ data, width, height }, 88).data as unknown as Uint8Array;
}