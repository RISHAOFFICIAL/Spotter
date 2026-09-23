#!/usr/bin/env node
/**
 * THE OFFLINE BAKE PROOF — the strongest evidence available without a device.
 *
 * Builds a synthetic 64×64 JPEG in Node (a 16-step grey ramp + two skin-tone
 * patches), runs it through the REAL `applySelfieGrade` for all 8 looks, and
 * asserts on what comes back:
 *
 *   · per-channel ramp response is monotone non-decreasing — no reversal, so
 *     the grade cannot invert tone order in a logged photo;
 *   · no hard 255 plateau before the top of the ramp — the tone-first LUT
 *     (top control point < 255) is what buys this; the retired matrix-first
 *     bake clipped (`1.08 · 255 + 11.5 = 287`);
 *   · `clean` is the identity: same buffer reference AND byte-identical pixels
 *     (no resize, no re-encode, nothing);
 *   · every non-clean look actually changes the pixels (a look that graded
 *     nothing would be a lie in the chip row);
 *   · the shipped grade reproduces the spec's worked mid-tone numbers.
 *
 * RUN:  node scripts/looks/bake-harness.mjs            (exit 1 on any FAIL)
 * Wired into the smoke suite as flow 0b — see scripts/real-mode-smoke/run_smoke.py.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { load } = require('./load-libs.cjs');
const { decode, encode } = require('jpeg-js');

const FILTERS = load('filters');
const ENGINE = load('lookGrade');

// --------------------------------------------------------------------------
// reporter (PASS/FAIL lines are parsed by the smoke runner — keep the format)
// --------------------------------------------------------------------------
let passes = 0;
let fails = 0;
const FLOW = 'looks-bake';

function check(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`);
}

// --------------------------------------------------------------------------
// the bake cap (asserted from the source text, not from behaviour)
// --------------------------------------------------------------------------
/**
 * The 1600 px working width is a product + performance limit, not a nice-to-have:
 * it is what keeps the pure-JS per-pixel pass sub-second on Hermes. It cannot be
 * *loaded* here — src/lib/selfieBake.ts imports expo-file-system and
 * expo-image-manipulator, which are device-only — so it is asserted from that
 * module's own source text. Raising the cap must be a deliberate, reviewed change
 * to the constant; this check makes such a change fail loudly instead of shipping
 * silently. NEVER raise it to make anything else pass.
 */
const BAKE_CAP_PX = 1600;
const SELFIE_BAKE_SRC = readFileSync(new URL('../../src/lib/selfieBake.ts', import.meta.url), 'utf8');
{
  const declared = /const\s+BAKE_MAX_WIDTH\s*=\s*(\d+)\s*;/.exec(SELFIE_BAKE_SRC);
  const usedInResize = /resize:\s*\{\s*width:\s*BAKE_MAX_WIDTH\s*\}/.test(SELFIE_BAKE_SRC);
  check(
    `bake cap: src/lib/selfieBake.ts works at ${BAKE_CAP_PX} px (never raise it)`,
    declared !== null && Number(declared[1]) === BAKE_CAP_PX && usedInResize,
    `BAKE_MAX_WIDTH=${declared ? declared[1] : 'NOT FOUND'} (cap ${BAKE_CAP_PX}); ` +
      `resize uses the constant: ${usedInResize}`,
  );
}

// --------------------------------------------------------------------------
// the fixture: 64×64, ramp across the whole width + two skin patches
// --------------------------------------------------------------------------
const SIZE = 64;
const RAMP_ROWS = 48;
const BANDS = 16;
const BAND_W = SIZE / BANDS; // 4 px per step
const SKIN_LIGHT = [222, 178, 150];
const SKIN_DEEP = [120, 80, 60];
const JPEG_Q = 92; // the bake's own quality — the fixture must not be softer

function buildFixture() {
  const data = Buffer.alloc(SIZE * SIZE * 4, 255);
  const bandValue = (i) => i * (255 / BANDS) + 255 / BANDS / 2; // 7.97, 23.9, …, 247.97
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const o = (y * SIZE + x) * 4;
      let rgb;
      if (y < RAMP_ROWS) {
        const v = Math.round(bandValue(Math.floor(x / BAND_W)));
        rgb = [v, v, v];
      } else {
        rgb = x < SIZE / 2 ? SKIN_LIGHT : SKIN_DEEP;
      }
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
  return data;
}

const fixtureRgba = buildFixture();
const inputJpeg = encode({ data: fixtureRgba, width: SIZE, height: SIZE }, JPEG_Q).data;
const inputDecoded = decode(inputJpeg, { useTArray: true, formatAsRGBA: true });
check(
  'fixture built (64x64 JPEG: 16-step grey ramp + 2 skin patches)',
  inputDecoded.width === SIZE && inputDecoded.height === SIZE && inputJpeg[0] === 0xff && inputJpeg[1] === 0xd8,
  `${inputJpeg.length} bytes, ${inputDecoded.width}x${inputDecoded.height}`,
);

/** Mean of each channel over a rectangle of a decoded image. */
function meanRect(img, x0, y0, x1, y1) {
  const sums = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * img.width + x) * 4;
      sums[0] += img.data[o];
      sums[1] += img.data[o + 1];
      sums[2] += img.data[o + 2];
      n += 1;
    }
  }
  return sums.map((v) => v / n);
}

function bandMeans(img) {
  const out = [];
  for (let i = 0; i < BANDS; i += 1) out.push(meanRect(img, i * BAND_W, 0, (i + 1) * BAND_W, RAMP_ROWS));
  return out;
}

const inputBands = bandMeans(inputDecoded);
const inputRampValues = inputBands.map((m) => m[0]);
const skinLightIn = meanRect(inputDecoded, 0, RAMP_ROWS, SIZE / 2, SIZE);
const skinDeepIn = meanRect(inputDecoded, SIZE / 2, RAMP_ROWS, SIZE, SIZE);

const px = (v) => v.toFixed(2).padStart(7);

// --------------------------------------------------------------------------
// the per-look proof
// --------------------------------------------------------------------------
const RAMP_SLACK = 2; // /255 — block-mean JPEG noise; every real step is ≥10
const TOP_HEADROOM = 1; // /255 — the top band must stay below clipping
const results = {};

for (const id of FILTERS.LOOK_IDS) {
  const grade = FILTERS.lookGrade(id);
  const out = FILTERS.applySelfieGrade(inputJpeg, id);
  const outDecoded = decode(out, { useTArray: true, formatAsRGBA: true });
  const bands = bandMeans(outDecoded);
  const skinLight = meanRect(outDecoded, 0, RAMP_ROWS, SIZE / 2, SIZE);
  const skinDeep = meanRect(outDecoded, SIZE / 2, RAMP_ROWS, SIZE, SIZE);

  // did anything change at all?
  let diff = 0;
  for (let i = 0; i < inputDecoded.data.length; i += 1) {
    if (inputDecoded.data[i] !== outDecoded.data[i]) diff += 1;
  }

  if (grade.identity) {
    check(
      `${id}: identity look returns the SAME buffer reference (no re-encode)`,
      out === inputJpeg,
      `sameReference=${out === inputJpeg}, bytes=${out.length}`,
    );
    check(
      `${id}: output pixels byte-identical to the input capture`,
      diff === 0,
      `${diff} differing byte(s) across ${inputDecoded.data.length}`,
    );
  } else {
    check(
      `${id}: grade actually changes the pixels (a look that grades nothing is a lie)`,
      diff > 0 && out !== inputJpeg,
      `${diff}/${inputDecoded.data.length} bytes changed, re-encoded=${out !== inputJpeg}`,
    );
  }

  // monotone ramp, per channel
  let reversal = null;
  let worstDrop = 0;
  for (let c = 0; c < 3 && !reversal; c += 1) {
    for (let i = 1; i < BANDS; i += 1) {
      const d = bands[i][c] - bands[i - 1][c];
      if (d < -RAMP_SLACK) {
        reversal = { channel: 'RGB'[c], from: i - 1, to: i, drop: d };
        break;
      }
      worstDrop = Math.min(worstDrop, d);
    }
  }
  check(
    `${id}: ramp response monotone non-decreasing (R,G,B)`,
    reversal === null,
    reversal
      ? `REVERSAL ${reversal.channel} band ${reversal.from}->${reversal.to}: ${reversal.drop.toFixed(2)}`
      : `16 bands, worst step ${worstDrop.toFixed(2)}/255 (slack ${RAMP_SLACK})`,
  );

  // head-room at the top of the ramp: no hard 255 plateau
  const top = bands[BANDS - 1];
  const prev = bands[BANDS - 2];
  const maxTop = Math.max(...top);
  const flatAt255 = Math.max(...top) >= 255 - TOP_HEADROOM;
  check(
    `${id}: no 255 plateau before the top of the ramp (head-room kept)`,
    !flatAt255 && top.every((v, c) => v > prev[c] + 0.5),
    `top band (${top.map((v) => v.toFixed(1)).join(', ')}) < 255-${TOP_HEADROOM}; ` +
      `top > previous: ${top.every((v, c) => v > prev[c] + 0.5)}`,
  );

  results[id] = { bands, skinLight, skinDeep, outDecoded };
}

// --------------------------------------------------------------------------
// the spec's worked numbers, straight off the real grade (unrounded pipeline)
// --------------------------------------------------------------------------
const SPEC = [
  { id: 'bright', expected: [13, 13, 13], target: 'mid +13' },
  { id: 'amber', expected: [18.36, 9, -1.68], target: 'mid (+18.4R, +9G, -1.7B)' },
  { id: 'film', expected: [7, 5, 2], target: 'mid (+7R, +5G, +2B)' },
  { id: 'mono', expected: [6, 6, 6], target: 'mid +6 per channel' },
  { id: 'dusk', expected: [3.5, null, null], target: 'mid ~+3.5 (warm shadow / cool highlight)' },
  { id: 'cool', expected: [null, 8, 25.44], target: 'mid (+8G, +25.4B)' },
];
const TOL = 0.05;
for (const spec of SPEC) {
  const grade = FILTERS.lookGrade(spec.id);
  const out = ENGINE.gradeRgbF(grade, 128, 128, 128);
  const got = out.map((v) => v - 128);
  const ok = spec.expected.every((e, i) => e === null || Math.abs(got[i] - e) <= TOL);
  check(
    `${spec.id}: shipped grade reproduces the spec mid-tone ${spec.target}`,
    ok,
    `got (${got.map((v) => v.toFixed(2)).join(', ')}) at tone 128 (tol ${TOL})`,
  );
}

// --------------------------------------------------------------------------
// the response readout — black / mid / white, per look
// --------------------------------------------------------------------------
console.log('\n[readout] real bake, band means off the decoded re-encode (Δ from the input band):');
console.log('  look       black(8)      mid(120)      white(248)    | float@16    float@128    float@245');
for (const id of FILTERS.LOOK_IDS) {
  const r = results[id];
  // `arr` is one band (3 channel means); the baseline is the SAME band of the
  // input, so the band index has to travel with it.
  const d = (arr, band) => arr[0] - inputRampValues[band];
  const grade = FILTERS.lookGrade(id);
  const f = [16, 128, 245].map((t) => ENGINE.gradeRgbF(grade, t, t, t)[0] - t);
  console.log(
    `  ${id.padEnd(9)} ${px(d(r.bands[0], 0))}  ${px(d(r.bands[7], 7))}  ${px(d(r.bands[15], 15))}` +
      `    | ${px(f[0])} ${px(f[1])} ${px(f[2])}`,
  );
}
console.log('[readout] skin patches (Δ per channel):');
for (const id of FILTERS.LOOK_IDS) {
  const r = results[id];
  const dl = r.skinLight.map((v, i) => v - skinLightIn[i]);
  const dd = r.skinDeep.map((v, i) => v - skinDeepIn[i]);
  console.log(
    `  ${id.padEnd(9)} light(${JSON.stringify(SKIN_LIGHT)}) (${dl.map((v) => v.toFixed(1)).join(', ')})` +
      `   deep(${JSON.stringify(SKIN_DEEP)}) (${dd.map((v) => v.toFixed(1)).join(', ')})`,
  );
}
console.log('[readout] dusk is warm in the shadows and cool in the highlights:');
{
  const r = results['dusk'];
  // Baseline per CHANNEL of the same band — `inputRampValues` is the red channel
  // across bands, so indexing it by the channel number would compare band 15 of
  // red against band 0/1/2 of the ramp (it did, and it reported the wrong verdict).
  const black = r.bands[0].map((v, c) => v - inputBands[0][c]);
  const white = r.bands[15].map((v, c) => v - inputBands[15][c]);
  console.log(`  black band Δ (${black.map((v) => v.toFixed(1)).join(', ')})  R>B: ${black[0] > black[2]}`);
  console.log(`  white band Δ (${white.map((v) => v.toFixed(1)).join(', ')})  B>R: ${white[2] > white[0]}`);
  check(
    'dusk: warm shadows (R lift > B lift at black) and cool highlights (B > R at white)',
    black[0] > black[2] && white[2] > white[0],
    `black R-B=${(black[0] - black[2]).toFixed(2)}, white B-R=${(white[2] - white[0]).toFixed(2)}`,
  );
}

console.log(`\nSUMMARY: ${passes} PASS / ${fails} FAIL`);
process.exit(fails > 0 ? 1 : 0);
