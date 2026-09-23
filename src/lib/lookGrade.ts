/**
 * SPOTTER look engine — the tone-first per-pixel pipeline behind the selfie
 * proof grade (`LookId`s live in src/lib/filters.ts, the live-preview model in
 * src/lib/lookPreviews.ts).
 *
 * WHY TONE FIRST (this is the quality fix, measured 2026-09-22):
 * the retired presets applied a matrix first (`1.08 · 255 + 11.5 = 287`) so the
 * highlights clipped and every look converged on the same mid-tone. Here the
 * order is `LUT → 3×4 matrix → splitTone → highlightDesat`:
 *
 *   LUT      a 256-entry table interpolated through 5 control points at
 *            x = 0, 64, 128, 192, 255. Because the top control point is < 255
 *            for every shipped look, no channel can reach 255 downstream — the
 *            whole head-room question disappears instead of being clipped away.
 *            Built LAZILY and memoised (never at module scope): this module is
 *            imported by a camera screen and launch-path weight is not free.
 *   matrix   3×4, [Rr, Rg, Rb, offset] per output channel, offsets in 0–255
 *            units (same convention the old presets used).
 *   splitTone
 *            luma-weighted blend of a shadow offset and a highlight offset —
 *            warm shadows / cool highlights without touching exposure.
 *   highlightDesat
 *            between `start` and `end` luma, pull the channels toward their own
 *            luma by `amount`. This is what keeps a saturated look from
 *            clipping a bright highlight, and it is a TONAL roll-off only.
 *
 * Honesty law (unchanged): the grade is baked into the JPEG on-device at
 * capture time. Nothing here blurs, smooths, masks, warps or is face-aware —
 * the selfie is the proof you showed up, so a tonal grade is the product limit.
 * The environment (back) shot never touches this module.
 *
 * Pure: no React Native imports, no globals beyond a lazily built cache, so the
 * exact bake path is executable under Node (scripts/looks/*.mjs).
 */

/** Rec.709 luma weights — the only luma definition in the app. */
export const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/** Where the LUT's five control points sit on the 0–255 input axis. */
export const LUT_STOPS: readonly [number, number, number, number, number] = [0, 64, 128, 192, 255];

/**
 * Split-tone pivots (luma, 0–255). The shadow tint is at full strength at
 * black and fades linearly to zero at SPLIT_SHADOW_PIVOT; the highlight tint
 * fades in from SPLIT_HIGHLIGHT_PIVOT to full at white. That is a plain
 * "lift the shadows only / tint the highlights only" pair of ramps.
 */
export const SPLIT_SHADOW_PIVOT = 160;
export const SPLIT_HIGHLIGHT_PIVOT = 160;

/** One output row: [Rr, Rg, Rb, offset] — offset in 0–255 units. */
export type MatrixRow = readonly [number, number, number, number];

export interface LookMatrix {
  readonly r: MatrixRow;
  readonly g: MatrixRow;
  readonly b: MatrixRow;
}

export interface SplitTone {
  /** Added at full strength on black, fading to zero at the shadow pivot. */
  readonly shadow: readonly [number, number, number];
  /** Added at full strength on white, fading in above the highlight pivot. */
  readonly highlight: readonly [number, number, number];
}

export interface HighlightDesat {
  readonly start: number;
  readonly end: number;
  readonly amount: number;
}

export interface LookGrade {
  /** Five control points at LUT_STOPS — piecewise-linear tone curve. */
  readonly lut: readonly [number, number, number, number, number];
  readonly matrix: LookMatrix;
  readonly splitTone?: SplitTone;
  readonly highlightDesat?: HighlightDesat;
  /**
   * Identity look: the raw capture IS the result. The bake returns the input
   * buffer untouched (same reference) and never re-encodes. Driven by this flag
   * — never by comparing the id to a legacy string.
   */
  readonly identity?: boolean;
}

/** Luma of a 0–255 triple. */
export function lumaOf(r: number, g: number, b: number): number {
  return LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
}

/**
 * Luma-preserving saturation matrix: `M = (1 − s)·L + s·I`, where L is the 3×3
 * matrix whose every row is the luma weights. Grey in → grey out for any s, so
 * a saturation change can never shift exposure. `s = 1` is the identity,
 * `s = 0` is a monochrome luma mix.
 */
export function satMatrix(s: number, offsets: readonly [number, number, number] = [0, 0, 0]): LookMatrix {
  const k = 1 - s;
  return {
    r: [k * LUMA[0] + s, k * LUMA[1], k * LUMA[2], offsets[0]],
    g: [k * LUMA[0], k * LUMA[1] + s, k * LUMA[2], offsets[1]],
    b: [k * LUMA[0], k * LUMA[1], k * LUMA[2] + s, offsets[2]],
  };
}

/** The identity 3×4 matrix (used by the tone-only looks). */
export const IDENTITY_MATRIX: LookMatrix = {
  r: [1, 0, 0, 0],
  g: [0, 1, 0, 0],
  b: [0, 0, 1, 0],
};

// --------------------------------------------------------------------------
// LUT — lazily built, memoised per control-point tuple
// --------------------------------------------------------------------------
const lutCache = new Map<string, Float64Array>();

/**
 * Builds (once per distinct control tuple) the 256-entry tone table by
 * piecewise-linear interpolation through the five control points.
 *
 * Throws when the control points are not monotone non-decreasing: a
 * non-monotone curve would invert tone order in the baked photo, so it is a
 * build-time error, not a runtime surprise.
 */
export function getLut(control: readonly number[]): Float64Array {
  if (!Array.isArray(control) || control.length !== LUT_STOPS.length) {
    throw new Error(`LUT needs ${LUT_STOPS.length} control points, got ${control.length}`);
  }
  for (let i = 0; i < control.length; i += 1) {
    const v = control[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 255) {
      throw new Error(`LUT control point ${i} out of range: ${v}`);
    }
    if (i > 0 && v < control[i - 1]) {
      throw new Error(`LUT control points must be monotone non-decreasing: ${control.join(',')}`);
    }
  }
  const key = control.join(',');
  const hit = lutCache.get(key);
  if (hit) return hit;
  const table = new Float64Array(256);
  for (let x = 0; x < 256; x += 1) {
    let seg = 0;
    while (seg < LUT_STOPS.length - 2 && x > LUT_STOPS[seg + 1]) seg += 1;
    const x0 = LUT_STOPS[seg];
    const x1 = LUT_STOPS[seg + 1];
    const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    table[x] = control[seg] + t * (control[seg + 1] - control[seg]);
  }
  lutCache.set(key, table);
  return table;
}

/** Samples a LUT, linearly interpolating for non-integer inputs. */
function lutSample(table: Float64Array, x: number): number {
  if (x <= 0) return table[0];
  if (x >= 255) return table[255];
  const i = Math.floor(x);
  const f = x - i;
  return f === 0 ? table[i] : table[i] + f * (table[i + 1] - table[i]);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function roundClamp255(v: number): number {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

// --------------------------------------------------------------------------
// The pipeline
// --------------------------------------------------------------------------

/**
 * The whole pipeline for one pixel, unrounded — the same numbers the bake
 * quantises at the very end. Kept exact (not folded into gradeRgba) so the
 * offline proofs can compare against decimal spec targets.
 */
export function gradeRgbF(grade: LookGrade, r: number, g: number, b: number): [number, number, number] {
  const lut = getLut(grade.lut);
  const lr = lutSample(lut, r);
  const lg = lutSample(lut, g);
  const lb = lutSample(lut, b);

  const m = grade.matrix;
  let R = m.r[0] * lr + m.r[1] * lg + m.r[2] * lb + m.r[3];
  let G = m.g[0] * lr + m.g[1] * lg + m.g[2] * lb + m.g[3];
  let B = m.b[0] * lr + m.b[1] * lg + m.b[2] * lb + m.b[3];

  const split = grade.splitTone;
  if (split) {
    const l = LUMA[0] * R + LUMA[1] * G + LUMA[2] * B;
    const ws = clamp01((SPLIT_SHADOW_PIVOT - l) / SPLIT_SHADOW_PIVOT);
    const wh = clamp01((l - SPLIT_HIGHLIGHT_PIVOT) / (255 - SPLIT_HIGHLIGHT_PIVOT));
    R += split.shadow[0] * ws + split.highlight[0] * wh;
    G += split.shadow[1] * ws + split.highlight[1] * wh;
    B += split.shadow[2] * ws + split.highlight[2] * wh;
  }

  const desat = grade.highlightDesat;
  if (desat) {
    const l = LUMA[0] * R + LUMA[1] * G + LUMA[2] * B;
    const span = desat.end - desat.start;
    const t = (span === 0 ? 0 : clamp01((l - desat.start) / span)) * desat.amount;
    if (t > 0) {
      R += (l - R) * t;
      G += (l - G) * t;
      B += (l - B) * t;
    }
  }

  return [R, G, B];
}

/** The pipeline for one pixel, quantised the way a JPEG pixel is (0–255 int). */
export function gradeRgb(grade: LookGrade, r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = gradeRgbF(grade, r, g, b);
  return [roundClamp255(R), roundClamp255(G), roundClamp255(B)];
}

/**
 * Applies the grade to an RGBA byte buffer IN PLACE (alpha untouched — JPEGs
 * are opaque). Two loops: the tone+matrix fast path, and the general path for
 * looks that carry splitTone / highlightDesat.
 *
 * Returns the number of pixels whose R, G or B changed — the bake's own
 * "did anything happen" signal, used by the offline bake proof.
 */
export function gradeRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  grade: LookGrade,
): number {
  const lut = getLut(grade.lut);
  const m = grade.matrix;
  const a0 = m.r[0], a1 = m.r[1], a2 = m.r[2], a3 = m.r[3];
  const b0 = m.g[0], b1 = m.g[1], b2 = m.g[2], b3 = m.g[3];
  const c0 = m.b[0], c1 = m.b[1], c2 = m.b[2], c3 = m.b[3];
  const split = grade.splitTone;
  const desat = grade.highlightDesat;
  const pixels = Math.min(data.length >> 2, width * height);
  let changed = 0;

  if (!split && !desat) {
    for (let i = 0; i < pixels; i += 1) {
      const o = i << 2;
      const lr = lut[data[o]];
      const lg = lut[data[o + 1]];
      const lb = lut[data[o + 2]];
      const nr = roundClamp255(a0 * lr + a1 * lg + a2 * lb + a3);
      const ng = roundClamp255(b0 * lr + b1 * lg + b2 * lb + b3);
      const nb = roundClamp255(c0 * lr + c1 * lg + c2 * lb + c3);
      if (nr !== data[o] || ng !== data[o + 1] || nb !== data[o + 2]) changed += 1;
      data[o] = nr;
      data[o + 1] = ng;
      data[o + 2] = nb;
    }
    return changed;
  }

  for (let i = 0; i < pixels; i += 1) {
    const o = i << 2;
    const lr = lut[data[o]];
    const lg = lut[data[o + 1]];
    const lb = lut[data[o + 2]];
    let R = a0 * lr + a1 * lg + a2 * lb + a3;
    let G = b0 * lr + b1 * lg + b2 * lb + b3;
    let B = c0 * lr + c1 * lg + c2 * lb + c3;
    if (split) {
      const l = LUMA[0] * R + LUMA[1] * G + LUMA[2] * B;
      const ws = clamp01((SPLIT_SHADOW_PIVOT - l) / SPLIT_SHADOW_PIVOT);
      const wh = clamp01((l - SPLIT_HIGHLIGHT_PIVOT) / (255 - SPLIT_HIGHLIGHT_PIVOT));
      R += split.shadow[0] * ws + split.highlight[0] * wh;
      G += split.shadow[1] * ws + split.highlight[1] * wh;
      B += split.shadow[2] * ws + split.highlight[2] * wh;
    }
    if (desat) {
      const l = LUMA[0] * R + LUMA[1] * G + LUMA[2] * B;
      const span = desat.end - desat.start;
      const t = (span === 0 ? 0 : clamp01((l - desat.start) / span)) * desat.amount;
      if (t > 0) {
        R += (l - R) * t;
        G += (l - G) * t;
        B += (l - B) * t;
      }
    }
    const nr = roundClamp255(R);
    const ng = roundClamp255(G);
    const nb = roundClamp255(B);
    if (nr !== data[o] || ng !== data[o + 1] || nb !== data[o + 2]) changed += 1;
    data[o] = nr;
    data[o + 1] = ng;
    data[o + 2] = nb;
  }
  return changed;
}
