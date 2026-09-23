/**
 * The ONE definition of "does the live preview track the bake?" — imported by
 * scripts/looks/check-look-previews.mjs (which prints PASS/FAIL) and by
 * scripts/looks/tune-look-previews.mjs (which searched for the layer values).
 * Two implementations of this rule would be two opinions; there is one.
 *
 * THE RULES, per look, per reference tone, per channel and for the overall level
 * (Rec.709 luma):
 *
 *   |Δbake| > SIG (a move worth previewing — 8/255 ≈ 3%):
 *       · the preview moves in the SAME DIRECTION (sign);
 *       · its magnitude sits inside [0.4, 1.8] × the bake's — right order of
 *         magnitude, wide enough to survive a live feed whose white balance and
 *         exposure we do not control, and tight enough that a preview cannot
 *         shout a look the photo does not have.
 *   |Δbake| ≤ SIG: only |Δpreview| ≤ SIG — the preview must not invent movement
 *       where the bake does not move. (Above 3% the shape of a look is what the
 *       eye reads; below it, a preview difference is not a look, it is drift.)
 *
 * There is deliberately NO weaker rule at the ramp ends (tones 16 and 245). An
 * earlier revision capped the preview's movement there at an absolute 8/255
 * "so a flat-layer stack gets no licence to fake a tone curve" — but the bake
 * itself moves far more than that at those tones (Amber +14.4 R at 16, Cool
 * −24.9 B at 245), so the cap forbade the preview from showing movement the
 * photo actually has. Measured 2026-09-23: with the cap in place the deterministic
 * tuner could not fit Amber (2 residual violations) or Cool (6) with 1-, 2- or
 * 3-layer stacks, plain or saturation-based; without it, every look fits exactly.
 * The no-invention rule above is what actually protects the ends: a stack cannot
 * manufacture shadow/white movement where the bake is still, and it cannot
 * exceed 1.8× the bake's own move anywhere. That is the invariant this file
 * enforces, and the checker proves it has teeth by rejecting sign-flipped
 * stacks, empty stacks and the retired 4-preset table.
 *
 * WHY SIG EXISTS — measured, not a tune-to-pass:
 * A flat-layer preview is a PER-CHANNEL map of the pixel's own channel value.
 * The bake is not: its 3×4 matrix and its saturation mix channels, so at a
 * coloured tone the bake's red response depends on green and blue too. On the
 * two skin tones the two models therefore cannot agree per channel in general —
 * and on greys the same limit bites for looks whose per-channel curve turns
 * over (Vivid's blue: +6 and +7.5 at the mid tones, −3.1 and −13 at the top,
 * which no monotone map plus a mid-peaked blend can produce while also matching
 * Vivid's −5 on the dark skin tone). 3% is the smallest move a viewer reads on
 * a live feed, so it is the honest floor for "the preview must show this".
 *
 * The rules are still not free: the checker REJECTS the retired 4-preset table
 * (flow 0c, teeth section) and any sign-flipped stack, and the strict variant
 * (SIG = EPS) is printed per look as a readout so the residual gap is visible.
 *
 * The LEVEL rule stays direction-only, exactly as specified: the preview must
 * never move the overall level the opposite way to the bake — this is the
 * invariant the retired table broke (Soft's preview darkened while its bake
 * lifted) — plus the same don't-invent-movement cap where the bake's level is
 * still.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load } = require('./load-libs.cjs');

export const FILTERS = load('filters');
export const ENGINE = load('lookGrade');
export const PREVIEWS = load('lookPreviews');

/** Numeric noise floor (quantisation) — below this the bake is "not moving". */
export const EPS = 2;
/** The smallest move worth previewing (8/255 ≈ 3%). */
export const SIG = 8;
export const RATIO_MIN = 0.4;
export const RATIO_MAX = 1.8;

/** Reference tones: the ramp the checker walks, plus two skin tones. */
export const REF_TONES = [
  { name: 'grey16', rgb: [16, 16, 16] },
  { name: 'grey40', rgb: [40, 40, 40] },
  { name: 'grey80', rgb: [80, 80, 80] },
  { name: 'grey128', rgb: [128, 128, 128] },
  { name: 'grey176', rgb: [176, 176, 176] },
  { name: 'grey220', rgb: [220, 220, 220] },
  { name: 'grey245', rgb: [245, 245, 245] },
  { name: 'skinLight', rgb: [222, 178, 150] },
  { name: 'skinDeep', rgb: [120, 80, 60] },
];

/** The real grade's unrounded delta at a tone: the reference the preview owes. */
export function bakeDelta(grade, rgb) {
  const out = ENGINE.gradeRgbF(grade, rgb[0], rgb[1], rgb[2]);
  return [out[0] - rgb[0], out[1] - rgb[1], out[2] - rgb[2]];
}

/** The preview model's unrounded delta at a tone. */
export function previewDelta(layers, rgb) {
  const out = PREVIEWS.compositePreview(rgb, layers);
  return [out[0] - rgb[0], out[1] - rgb[1], out[2] - rgb[2]];
}

function sign(v) {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function luma(rgb) {
  return ENGINE.lumaOf(rgb[0], rgb[1], rgb[2]);
}

/**
 * Evaluates one look's layer stack against its real grade.
 * `sig` is the significance floor (SIG by default; EPS for the strict readout).
 * Returns { violations, tones, level } — violations is empty when it tracks.
 */
export function evaluateLook(id, grade, layers, sig = SIG) {
  const violations = [];
  const tones = [];
  const level = [];
  const CH = ['R', 'G', 'B'];
  const cap = SIG; // the absolute cap at the ends / for insignificant moves

  const push = (tone, channel, kind, db, dp, detail) => {
    violations.push({ tone, channel, kind, db, dp, detail });
  };

  for (const tone of REF_TONES) {
    const db = bakeDelta(grade, tone.rgb);
    const dp = previewDelta(layers, tone.rgb);
    tones.push({ tone: tone.name, rgb: tone.rgb, db, dp });
    for (let c = 0; c < 3; c += 1) {
      const b = db[c];
      const p = dp[c];
      const ch = CH[c];
      if (Math.abs(b) <= sig) {
        if (Math.abs(p) > cap) {
          push(tone.name, ch, 'no-move drift', b, p, `bake ${fmt(b)} but preview ${fmt(p)} (cap ${cap})`);
        }
        continue;
      }
      if (sign(p) !== sign(b)) {
        push(tone.name, ch, 'sign', b, p, `bake ${fmt(b)} vs preview ${fmt(p)} — opposite direction`);
        continue;
      }
      const ratio = Math.abs(p) / Math.abs(b);
      if (ratio < RATIO_MIN || ratio > RATIO_MAX) {
        push(tone.name, ch, 'ratio', b, p, `|preview|/|bake| = ${ratio.toFixed(2)} outside [${RATIO_MIN}, ${RATIO_MAX}]`);
      }
    }
    const inLuma = luma(tone.rgb);
    const dbL = luma(tone.rgb.map((v, i) => v + db[i])) - inLuma;
    const dpL = luma(tone.rgb.map((v, i) => v + dp[i])) - inLuma;
    level.push({ tone: tone.name, dbl: dbL, dpl: dpL });
    if (Math.abs(dbL) <= sig) {
      if (Math.abs(dpL) > cap) {
        push(tone.name, 'Y', 'level no-move', dbL, dpL, `level bake ${fmt(dbL)} but preview ${fmt(dpL)}`);
      }
    } else if (sign(dpL) !== sign(dbL)) {
      push(tone.name, 'Y', 'level direction', dbL, dpL, `level bake ${fmt(dbL)} vs preview ${fmt(dpL)} — opposite direction`);
    }
  }

  return { id, violations, tones, level };
}

/** Continuous severity of the same rule set — the tuner's objective. */
export function severity(result, sig = SIG) {
  let s = 0;
  for (const v of result.violations) {
    let x;
    if (v.kind === 'sign' || v.kind === 'level direction') x = Math.abs(v.dp) + Math.abs(v.db);
    else if (v.kind === 'ratio') {
      const ratio = Math.abs(v.dp) / Math.abs(v.db);
      x = ratio < RATIO_MIN ? RATIO_MIN * Math.abs(v.db) - Math.abs(v.dp) : Math.abs(v.dp) - RATIO_MAX * Math.abs(v.db);
    } else x = Math.abs(v.dp) - SIG;
    s += x * x;
  }
  return s;
}

export function fmt(v) {
  return Number(v).toFixed(2);
}

export function fmtDelta(d) {
  return `(${d.map((v) => fmt(v)).join(', ')})`;
}
