#!/usr/bin/env node
/**
 * THE LOOK-PREVIEW CHECK — the guard that keeps the camera feed and the baked
 * photo one thing. The retired preview was a hand-typed tint that did not match
 * the bake and sometimes moved the WRONG WAY; this check is what makes that
 * class of bug impossible to merge, and it runs in the smoke suite as flow 0c.
 *
 * For every look and every reference tone (7 greys + 2 skin tones) it asserts
 * that the DERIVED preview stack (src/lib/lookPreviews.ts) tracks the REAL grade
 * (src/lib/filters.ts → src/lib/lookGrade.ts) in direction, magnitude and at the
 * ramp ends. It also asserts the chip swatches are the real grade's own output,
 * that the transitional legacy flat tint still matches the grade it describes,
 * and — the point of the exercise — that the check REJECTS the shapes it is
 * supposed to reject:
 *   · a deliberately sign-flipped stack,
 *   · a stack of no layers at all,
 *   · the retired 4-preset table that shipped in build 28,
 *   · a non-monotone LUT (rejected at build time by the engine).
 *
 * RUN:  node scripts/looks/check-look-previews.mjs
 *       node scripts/looks/check-look-previews.mjs --demo-fail=bright   (RED demo)
 *       node scripts/looks/check-look-previews.mjs --demo-fail=legacy   (RED demo)
 *       node scripts/looks/check-look-previews.mjs --print-tints        (devel)
 */
import { FILTERS, ENGINE, PREVIEWS, REF_TONES, EPS, SIG, RATIO_MIN, RATIO_MAX, evaluateLook, severity, fmtDelta } from './look-rules.mjs';

const FLOW = 'look-previews';
let passes = 0;
let fails = 0;

function check(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`);
}

const ALLOWED_BLENDS = ['normal', 'multiply', 'screen', 'darken', 'soft-light', 'saturation'];
const MAX_LAYERS = 3;

// --------------------------------------------------------------------------
// variants used by the teeth demos and the --demo-fail mode
// --------------------------------------------------------------------------
/** Flips a stack's direction: every layer becomes a NORMAL layer of the complement colour. */
function flipSign(layers) {
  return layers.map((l) => {
    const [r, g, b] = PREVIEWS.parseHex(l.color);
    const c = (v) => (255 - v).toString(16).padStart(2, '0');
    return { color: `#${c(r)}${c(g)}${c(b)}`, alpha: l.alpha, blend: 'normal' };
  });
}

/**
 * The retired 4-preset table (v1.0/build 28): a matrix-first bake with NO tone
 * LUT, previewed by one flat tint. Its bake is exactly this grade — a straight
 * LUT composed with the old matrix — so the comparison is apples to apples.
 */
const STRAIGHT_LUT = [0, 64, 128, 192, 255];
const LEGACY = {
  none: { matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], tint: null },
  warm: {
    matrix: [[1.06, 0.02, 0, 0.045 * 255], [0, 1, 0, 0.028 * 255], [0, 0.02, 0.96, 0]],
    tint: { color: '#FFA840', alpha: 0.12 },
  },
  bright: {
    matrix: [[1.08, 0, 0, 0.045 * 255], [0, 1.08, 0, 0.045 * 255], [0, 0, 1.08, 0.045 * 255]],
    tint: { color: '#FFFFFF', alpha: 0.08 },
  },
  soft: {
    matrix: [[0.9, 0, 0, 0.05 * 255], [0, 0.9, 0, 0.05 * 255], [0, 0, 0.9, 0.05 * 255]],
    tint: { color: '#000000', alpha: 0.06 },
  },
};

function legacyGrade(id) {
  const m = LEGACY[id].matrix;
  return {
    lut: STRAIGHT_LUT,
    matrix: { r: m[0], g: m[1], b: m[2] },
  };
}

/**
 * The one flat layer the un-migrated camera screens draw, derived from the real
 * grade (never hand-typed).
 *
 * A flat NORMAL layer composites as `out = (1−α)·in + α·C` — a straight line
 * through the bake's response — so the honest line is the SECANT through the
 * ramp ends (tones 16 and 245): the flattened preview then matches the real bake
 * exactly at the dark end and the bright end and differs only where the bake's
 * curve bends (at most ~16/255 at a mid tone, for every shipped look).
 *
 * A layer has ONE alpha, so the alpha is the mean of the three per-channel
 * secant gains and each channel's colour is that channel's value at the dark
 * end; `C` is clamped to 0–255, the only approximation left, worth ≤ 1/255.
 */
function legacyTintFor(id) {
  const grade = FILTERS.lookGrade(id);
  const LO = 16;
  const HI = 245;
  const dark = ENGINE.gradeRgbF(grade, LO, LO, LO);
  const bright = ENGINE.gradeRgbF(grade, HI, HI, HI);
  const gains = [0, 1, 2].map((c) => (bright[c] - dark[c]) / (HI - LO));
  const alpha = 1 - gains.reduce((s, g) => s + g, 0) / 3;
  if (alpha <= 0.001) return { alpha: 0, color: null, channels: null };
  const channels = [0, 1, 2].map((c) => clamp255((dark[c] - (1 - alpha) * LO) / alpha));
  return { alpha, color: PREVIEWS.toHex(channels), channels };
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function parseRgba(s) {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)$/.exec(String(s));
  if (!m) return null;
  return { alpha: Number(m[4]), channels: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

// --------------------------------------------------------------------------
// the check itself
// --------------------------------------------------------------------------
function evaluateTable(layersFor) {
  const out = {};
  for (const id of FILTERS.LOOK_IDS) {
    out[id] = evaluateLook(id, FILTERS.lookGrade(id), layersFor(id));
  }
  return out;
}

function reportViolations(id, result) {
  for (const v of result.violations) {
    console.log(`     • ${v.tone} ${v.channel} ${v.kind}: ${v.detail}`);
  }
}

function main() {
  const demo = process.argv.find((a) => a.startsWith('--demo-fail='));
  const printTints = process.argv.includes('--print-tints');

  console.log('=== check-look-previews: the live preview tracks the bake ===');
  console.log(
    `rule: |Δbake| > ${SIG}/255 → same direction + magnitude inside [${RATIO_MIN}, ${RATIO_MAX}]× the bake's; ` +
      `|Δbake| ≤ ${SIG}/255 → |Δpreview| ≤ ${SIG}/255 (no invented movement); ` +
      `the overall level must never move the other way`,
  );

  if (printTints) {
    for (const id of FILTERS.LOOK_IDS) {
      const t = legacyTintFor(id);
      console.log(
        `tint ${id.padEnd(7)} alpha=${t.alpha.toFixed(4)} channels=` +
          `${t.channels ? t.channels.map((v) => v.toFixed(1)).join(',') : 'none'}`,
      );
    }
    return;
  }

  if (demo) {
    const which = demo.split('=')[1];
    if (which === 'legacy') {
      for (const id of Object.keys(LEGACY)) {
        const layers = LEGACY[id].tint ? [LEGACY[id].tint] : [];
        const r = evaluateLook(id, legacyGrade(id), layers);
        check(
          `retired look '${id}' preview tracks its bake`,
          r.violations.length === 0,
          `${r.violations.length} violation(s) with the retired flat tint ${JSON.stringify(LEGACY[id].tint)}`,
        );
        reportViolations(id, r);
      }
    } else {
      const base = PREVIEWS.LOOK_PREVIEWS[which];
      const r = evaluateLook(which, FILTERS.lookGrade(which), flipSign(base.layers));
      check(
        `sign-flipped '${which}' preview tracks its bake`,
        r.violations.length === 0,
        `${r.violations.length} violation(s) for ${JSON.stringify(flipSign(base.layers))}`,
      );
      reportViolations(which, r);
    }
    console.log(`\nSUMMARY: ${passes} PASS / ${fails} FAIL`);
    process.exit(fails > 0 ? 1 : 0);
  }

  // ---- 1. every look's derived stack tracks the real grade ----
  for (const id of FILTERS.LOOK_IDS) {
    const layers = PREVIEWS.LOOK_PREVIEWS[id].layers;
    const result = evaluateLook(id, FILTERS.lookGrade(id), layers);
    const strict = evaluateLook(id, FILTERS.lookGrade(id), layers, EPS);
    check(
      `${id}: derived preview tracks the real bake at all ${REF_TONES.length} reference tones`,
      result.violations.length === 0,
      `${layers.length} layer(s) ${JSON.stringify(layers)}; ${result.violations.length} violation(s); ` +
        `strict-gap readout |Δbake|>2: ${strict.violations.length} residual`,
    );
    reportViolations(id, result);
  }

  // ---- 2. the stack obeys the model's own contract ----
  for (const id of FILTERS.LOOK_IDS) {
    const layers = PREVIEWS.LOOK_PREVIEWS[id].layers;
    const ok =
      layers.length <= MAX_LAYERS &&
      layers.every((l) => {
        try {
          PREVIEWS.parseHex(l.color);
        } catch {
          return false;
        }
        return l.alpha >= 0 && l.alpha <= 1 && ALLOWED_BLENDS.includes(l.blend ?? 'normal');
      }) &&
      (FILTERS.lookGrade(id).identity ? layers.length === 0 : true);
    check(
      `${id}: preview stack is ≤ ${MAX_LAYERS} flat layers with RN mixBlendMode names`,
      ok,
      `${layers.length} layer(s): ${layers.map((l) => `${l.blend ?? 'normal'} ${l.color} @${l.alpha}`).join(' | ') || '(none)'}`,
    );
  }

  // ---- 3. the chip swatch IS the look's tonal response ----
  for (const id of FILTERS.LOOK_IDS) {
    const expected = PREVIEWS.lookSwatch(id);
    const got = PREVIEWS.LOOK_PREVIEWS[id].swatch;
    check(
      `${id}: swatch is the real grade sampled at the shadow and skin/mid tones`,
      expected.from === got.from && expected.to === got.to,
      `from ${got.from} (shadow ${PREVIEWS.SWATCH_SHADOW_TONE}) to ${got.to} (${PREVIEWS.SWATCH_MID_TONE.join(',')})`,
    );
  }

  // ---- 4. the transitional legacy flat tint still matches the grade ----
  for (const id of FILTERS.LOOK_IDS) {
    const want = legacyTintFor(id);
    const preset = FILTERS.SELFIE_FILTER_PRESETS[id];
    const got = preset.previewTint === null ? { alpha: 0, channels: null } : parseRgba(preset.previewTint);
    const ok =
      got !== null &&
      Math.abs(got.alpha - want.alpha) <= 0.006 &&
      (want.channels === null
        ? got.channels === null
        : got.channels.every((v, i) => Math.abs(v - want.channels[i]) <= 1.5));
    check(
      `legacy shim (${id}): flat previewTint still matches the grade's secant flatten`,
      ok,
      `shim ${JSON.stringify(preset.previewTint)} vs derived alpha=${want.alpha.toFixed(3)} ` +
        `${want.channels ? want.channels.map((v) => v.toFixed(1)).join(',') : 'none'}`,
    );
  }

  // ---- 5. teeth: the check rejects what it must reject ----
  const flipped = FILTERS.LOOK_IDS.filter((id) => !FILTERS.lookGrade(id).identity);
  const flippedMissed = flipped.filter(
    (id) => evaluateLook(id, FILTERS.lookGrade(id), flipSign(PREVIEWS.LOOK_PREVIEWS[id].layers)).violations.length === 0,
  );
  check(
    'TEETH: a sign-flipped stack is REJECTED for every non-clean look',
    flippedMissed.length === 0,
    `${flipped.length - flippedMissed.length}/${flipped.length} looks rejected` +
      (flippedMissed.length ? `; MISSED ${flippedMissed.join(', ')}` : ''),
  );

  const emptyMissed = flipped.filter((id) => evaluateLook(id, FILTERS.lookGrade(id), []).violations.length === 0);
  check(
    'TEETH: a preview that does nothing is REJECTED for every non-clean look',
    emptyMissed.length === 0,
    `${flipped.length - emptyMissed.length}/${flipped.length} looks rejected`,
  );

  // The retired table's identity entry ('none' → no grade, no tint) is NOT a
  // teeth case: its bake moves nothing, so "preview moves nothing" is correct
  // and the rule must accept it. The three *graded* retired looks are.
  const legacyGraded = Object.keys(LEGACY).filter((id) => id !== 'none');
  const legacyAccepted = legacyGraded.filter(
    (id) => evaluateLook(id, legacyGrade(id), LEGACY[id].tint ? [LEGACY[id].tint] : []).violations.length === 0,
  );
  let legacyDetail = '';
  for (const id of Object.keys(LEGACY)) {
    const r = evaluateLook(id, legacyGrade(id), LEGACY[id].tint ? [LEGACY[id].tint] : []);
    legacyDetail += `${id}:${r.violations.length} `;
  }
  check(
    'TEETH: the retired 4-preset table (shipped in build 28) is REJECTED',
    legacyGraded.length === 3 && legacyAccepted.length === 0,
    `violations per retired look — ${legacyDetail}(identity 'none' accepted by design)`,
  );

  // A stack that shouts far louder than the bake it stands for: one flat white
  // layer at 50%. Every shipped look moves by ≤ ~18/255 somewhere, so this must
  // be caught by the magnitude window, or by the no-invented-movement cap at a
  // tone where the bake is still. It is the tooth for the rule change that lets
  // the ramp ends use the same magnitude window as everywhere else.
  const OVERLOUD = [{ color: '#FFFFFF', alpha: 0.5, blend: 'normal' }];
  const loudAccepted = flipped.filter(
    (id) => evaluateLook(id, FILTERS.lookGrade(id), OVERLOUD).violations.length === 0,
  );
  check(
    'TEETH: an over-loud flat layer (white @ 50%) is REJECTED for every non-clean look',
    loudAccepted.length === 0,
    `${flipped.length - loudAccepted.length}/${flipped.length} looks rejected` +
      (loudAccepted.length ? `; MISSED ${loudAccepted.join(', ')}` : ''),
  );

  let lutThrew = false;
  try {
    ENGINE.getLut([0, 80, 60, 192, 255]);
  } catch {
    lutThrew = true;
  }
  check(
    'TEETH: a non-monotone LUT is rejected at build time by the engine',
    lutThrew,
    'getLut([0, 80, 60, 192, 255]) throws',
  );

  // ---- readout ----
  console.log('\n[readout] per tone: bake vs preview (Δ/255), worst ratio first');
  for (const id of FILTERS.LOOK_IDS) {
    const r = evaluateLook(id, FILTERS.lookGrade(id), PREVIEWS.LOOK_PREVIEWS[id].layers);
    const strict = evaluateLook(id, FILTERS.lookGrade(id), PREVIEWS.LOOK_PREVIEWS[id].layers, EPS);
    console.log(`  ${id}: severity=${severity(r).toFixed(3)} strict-residual=${strict.violations.length}`);
    for (const t of r.tones) {
      console.log(`    ${t.tone.padEnd(9)} bake=${fmtDelta(t.db).padEnd(26)} preview=${fmtDelta(t.dp)}`);
    }
  }

  console.log(`\nSUMMARY: ${passes} PASS / ${fails} FAIL`);
  process.exit(fails > 0 ? 1 : 0);
}

main();
