/**
 * Selfie filter presets + the on-device color-grade bake (v1.0 dual-capture).
 *
 * Product law (groups-copy-spec §5 / onboarding addendum §2.4): filters are
 * TONAL-ONLY grades for the selfie shot — amber lift (Warm), exposure lift
 * (Bright), gentle contrast roll-off (Soft). Nothing blurs, masks, or alters
 * geometry; the environment stay fully legible and the proof is never weakened.
 * The back (environment) shot is ALWAYS unfiltered.
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

export type SelfieFilter = 'none' | 'warm' | 'bright' | 'soft';

export const SELFIE_FILTER_IDS: readonly SelfieFilter[] = ['none', 'warm', 'bright', 'soft'];

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
  /** Chip label (surface text only; a11y label = `Filter: {label}`). */
  label: string;
  /** Live-preview overlay tint approximating the baked grade on the camera feed. */
  previewTint: string | null;
  /** The baked per-pixel grade. */
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
  none: { id: 'none', label: 'None', previewTint: null, matrix: identity },
  warm: { id: 'warm', label: 'Warm', previewTint: 'rgba(255, 168, 64, 0.12)', matrix: warmMatrix },
  bright: { id: 'bright', label: 'Bright', previewTint: 'rgba(255, 255, 255, 0.08)', matrix: brightMatrix },
  soft: { id: 'soft', label: 'Soft', previewTint: 'rgba(0, 0, 0, 0.06)', matrix: softMatrix },
};

/** Optional helper line under the chip row (dropped when the bar is tight). */
export const SELFIE_FILTER_HELPER = 'A touch of light — nothing hidden.';

export function filterPreset(filter: SelfieFilter): SelfieFilterPreset {
  return SELFIE_FILTER_PRESETS[filter];
}

/** a11y label per the spec: `Filter: None` / `Filter: Warm` / … */
export function filterA11yLabel(filter: SelfieFilter): string {
  return `Filter: ${SELFIE_FILTER_PRESETS[filter].label}`;
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

/**
 * Bake ONE tonal grade into a JPEG's pixels — the exact bytes that get logged.
 * Pure (no RN/device dependencies): `input` is a JPEG byte buffer, the result
 * is a re-encoded JPEG buffer with the color matrix applied per pixel.
 * Returns the SAME buffer reference when the matrix is the identity (filter
 * 'none' — callers skip the pipeline entirely before reaching this path).
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