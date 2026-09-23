/**
 * The DERIVED live-preview model for the selfie looks.
 *
 * Why this file exists (measured 2026-09-22): the old preview was a hand-typed
 * flat rgba tint per preset that did not match the bake and sometimes moved the
 * WRONG WAY — picking Soft darkened the preview while the baked photo got a
 * milky lift; Warm previewed pink highlights while the bake clipped yellow.
 *
 * The preview is therefore DERIVED from the real grade (src/lib/filters.ts /
 * lookGrade.ts) and verified against it offline
 * (scripts/looks/check-look-previews.mjs → smoke flow 0c): for every look and
 * every reference tone, the preview's per-channel movement must agree in
 * DIRECTION with the bake's, sit inside [0.4, 1.8] × its magnitude, and never
 * move the overall level the other way. The camera feed and the baked photo are
 * one thing or the checker is red.
 *
 * THE MODEL (one model, on screen and in the checker — never two):
 *   a stack of at most 3 flat layers over the live camera feed, each
 *   `{ color: '#RRGGBB', alpha, blend? }`, composited source-over with the
 *   standard blend function B(base, src):
 *     normal      out = (1−a)·base + a·src
 *     multiply    out = (1−a)·base + a·(base·src)
 *     screen      out = (1−a)·base + a·(base + src − base·src)
 *     darken      out = (1−a)·base + a·min(base, src)
 *     soft-light  out = (1−a)·base + a·SL(base, src)       (PDF / W3C formula)
 *     saturation  out = (1−a)·base + a·Sat_blend(base, src) (PDF / W3C, non-separable)
 *   A normal-only stack (the common case) reduces exactly to the flat composite
 *   `out = (1−w)·((1−a)·((1−k)·in + a·C) + w·255)` — black scrim k, tint C at
 *   alpha a, white veil w — which is the same algebra written the long way.
 *
 *   The non-normal modes are not decoration. They are the only shapes that can
 *   track this bake:
 *     · soft-light lifts the mid-tones while leaving black and white fixed —
 *       exactly Bright's tone curve, and no stack of normal/multiply/screen
 *       layers can do it (those compose to a monotone per-channel affine map,
 *       `out = A·in + B` with `B ≤ 255·(1−A)`, which has no mid-tone peak);
 *     · darken is flat-then-plunge, which is how a highlight roll-off previews;
 *     · saturation with a GREY source is a true luma-preserving desaturation,
 *       the only way Mono can preview at all (a flat grey layer would move the
 *       greys, and Mono's bake leaves greys untouched).
 *   The checker proves that per look and per tone rather than asserting it; the
 *   layer ids here are exactly React Native's `mixBlendMode` names.
 *
 * `LOOK_PREVIEWS` is a LITERAL table (no module-scope maths — this file is
 * imported by a camera screen, and launch-path discipline is not negotiable):
 * the values come from scripts/looks/tune-look-previews.mjs and the swatches
 * from the real grade. The checker recomputes both and fails on drift.
 */
import { lookGrade, type LookId } from './filters';
import { gradeRgb } from './lookGrade';

export type PreviewBlend = 'normal' | 'multiply' | 'screen' | 'darken' | 'soft-light' | 'saturation';

export interface PreviewLayer {
  /** '#RRGGBB' — parsed exactly (no rgba strings: alpha lives in `alpha`). */
  readonly color: string;
  readonly alpha: number;
  readonly blend?: PreviewBlend;
}

export interface LookPreview {
  readonly layers: readonly PreviewLayer[];
  /** The look's tonal response: real grade output at a shadow and a mid tone. */
  readonly swatch: { readonly from: string; readonly to: string };
}

/** Maximum layers in one look's preview stack. */
export const MAX_PREVIEW_LAYERS = 3;

type RGB = readonly [number, number, number];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Rec.709 luma weights — the same definition the grade engine uses. */
const LUMA: RGB = [0.2126, 0.7152, 0.0722];

function lum(c: RGB): number {
  return LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
}

/** PDF / W3C soft-light's D(base) helper. */
function softLightD(b: number): number {
  return b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
}

/** The separable blend function of the layer model — the single definition. */
export function blendChannel(mode: PreviewBlend, base: number, src: number): number {
  switch (mode) {
    case 'multiply':
      return base * src;
    case 'screen':
      return base + src - base * src;
    case 'darken':
      return Math.min(base, src);
    case 'soft-light':
      return src <= 0.5 ? base - (1 - 2 * src) * base * (1 - base) : base + (2 * src - 1) * (softLightD(base) - base);
    case 'normal':
      return src;
    default:
      throw new Error(`blendChannel does not handle the non-separable mode '${mode}'`);
  }
}

// --------------------------------------------------------------------------
// Non-separable saturation blend (PDF 1.7 / W3C compositing, Rec.709 luma)
// --------------------------------------------------------------------------
function sat(c: RGB): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

function setSat(c: RGB, s: number): RGB {
  if (c[0] <= c[1] && c[0] <= c[2]) {
    const [mn, md, mx] = [c[0], Math.min(c[1], c[2]), Math.max(c[1], c[2])];
    return mx > mn ? [0, ((md - mn) * s) / (mx - mn), s] : [0, 0, 0];
  }
  if (c[1] <= c[0] && c[1] <= c[2]) {
    const [mn, md, mx] = [c[1], Math.min(c[0], c[2]), Math.max(c[0], c[2])];
    return mx > mn ? [((md - mn) * s) / (mx - mn), s, 0] : [0, 0, 0];
  }
  const [mn, md, mx] = [c[2], Math.min(c[0], c[1]), Math.max(c[0], c[1])];
  return mx > mn ? [s, ((md - mn) * s) / (mx - mn), 0] : [0, 0, 0];
}

function clipColor(c: RGB): RGB {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0) {
    const d = l - n;
    c = d > 0 ? (c.map((v) => l + ((v - l) * l) / d) as unknown as RGB) : [l, l, l];
  }
  if (x > 1) {
    const d = x - l;
    c = d > 0 ? (c.map((v) => l + ((v - l) * (1 - l)) / d) as unknown as RGB) : [l, l, l];
  }
  return c;
}

function setLum(c: RGB, l: number): RGB {
  const d = l - lum(c);
  return clipColor(c.map((v) => v + d) as unknown as RGB);
}

/** `Blend_saturation(Cb, Cs) = SetLum(SetSat(Cb, Sat(Cs)), Lum(Cb))`. */
export function blendSaturation(base: RGB, src: RGB): RGB {
  return setLum(setSat(base, sat(src)), lum(base));
}

/**
 * Composites the layer stack over an incoming camera pixel (0–255 per channel).
 * This is the function the checker uses; the camera screen must render the same
 * stack with the same `mixBlendMode` values.
 */
export function compositePreview(rgb: RGB, layers: readonly PreviewLayer[]): [number, number, number] {
  let cur: RGB = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  for (const layer of layers) {
    const hexRgb = parseHex(layer.color);
    const src: RGB = [hexRgb[0] / 255, hexRgb[1] / 255, hexRgb[2] / 255];
    const a = clamp01(layer.alpha);
    if (a === 0) continue;
    const mode = layer.blend ?? 'normal';
    const blended: RGB =
      mode === 'saturation'
        ? blendSaturation(cur, src)
        : [
            blendChannel(mode, cur[0], src[0]),
            blendChannel(mode, cur[1], src[1]),
            blendChannel(mode, cur[2], src[2]),
          ];
    cur = [
      (1 - a) * cur[0] + a * blended[0],
      (1 - a) * cur[1] + a * blended[1],
      (1 - a) * cur[2] + a * blended[2],
    ];
  }
  return [cur[0] * 255, cur[1] * 255, cur[2] * 255];
}

export function parseHex(color: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(color).trim());
  if (!m) throw new Error(`preview layer colour must be '#RRGGBB', got ${color}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: RGB): string {
  const h = (v: number) => {
    const r = Math.round(v);
    return (r < 0 ? 0 : r > 255 ? 255 : r).toString(16).padStart(2, '0');
  };
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

/** The tones the swatch gradient is sampled at: a shadow, then skin/mid. */
export const SWATCH_SHADOW_TONE = 40;
export const SWATCH_MID_TONE: RGB = [222, 178, 150];

/**
 * The look's swatch, taken from the REAL grade (never hand-typed). The checker
 * recomputes this through the loaded engine and compares it to the literals in
 * LOOK_PREVIEWS, so a stale swatch is a failed check, not a slow drift.
 */
export function lookSwatch(id: LookId): { from: string; to: string } {
  const grade = lookGrade(id);
  const shadow = SWATCH_SHADOW_TONE;
  return {
    from: toHex(gradeRgb(grade, shadow, shadow, shadow)),
    to: toHex(gradeRgb(grade, SWATCH_MID_TONE[0], SWATCH_MID_TONE[1], SWATCH_MID_TONE[2])),
  };
}

/**
 * The derived table the camera UI renders. LITERAL on purpose: zero module-eval
 * maths on a launch-path module. Values come from
 * scripts/looks/tune-look-previews.mjs; swatches are the real grade sampled at
 * `SWATCH_SHADOW_TONE` and `SWATCH_MID_TONE`. Do not hand-edit a number here
 * without re-running scripts/looks/check-look-previews.mjs.
 */
export const LOOK_PREVIEWS: Record<LookId, LookPreview> = {
  clean: { layers: [], swatch: { from: '#282828', to: '#DEB296' } },
  bright: { layers: [], swatch: { from: '#313131', to: '#E7C3A5' } },
  amber: { layers: [], swatch: { from: '#373737', to: '#EEC1A0' } },
  vivid: { layers: [], swatch: { from: '#292929', to: '#DFB196' } },
  film: { layers: [], swatch: { from: '#333231', to: '#DDB4A1' } },
  dusk: { layers: [], swatch: { from: '#302F31', to: '#D5AFA7' } },
  cool: { layers: [], swatch: { from: '#232A2F', to: '#D4B7B2' } },
  mono: { layers: [], swatch: { from: '#2E2E2E', to: '#B3B3B3' } },
};

export function lookPreview(id: LookId): LookPreview {
  return LOOK_PREVIEWS[id];
}
