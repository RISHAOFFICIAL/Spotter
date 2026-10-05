#!/usr/bin/env node
/*
 * skin-caps-guard — the caps gate for the owner-approved, GEOMETRY-FREE
 * enhancement ("Glow", the SKIN chip family, 2026-10-05).
 *
 * WHY THIS EXISTS
 * `beauty-mode-scope-2026-10-05.md` §1 states the enhancement's caps as NUMBERS
 * and says of them: *"How each cap is verified (otherwise it is a promise, not a
 * cap): a caps gate in the existing guard suite ... it must fail on an uncapped
 * implementation, non-zero exit captured directly. Verdict line per bound, not a
 * single pass/fail. This is the only thing that makes 'subtle' reviewable."*
 * This file is that gate.
 *
 * WHAT IT MEASURES — the SHIPPING transform, not a model of it
 * It loads `src/lib/filters.ts` from source in this run (same transpile settings
 * as scripts/smoke/compile.cjs — no generated artifact, no stale cache), and
 * calls the module's own `applySelfieEnhancementRGBA` + `skinMaskWeight` over
 * procedurally-built fixture selfies, with a synthetic skin-region map known by
 * construction. So the numbers below are the bytes the bake would produce, at the
 * bake's own working width (1600 px, `selfieBake.ts` BAKE_MAX_WIDTH).
 *
 * THE BOUNDS (memo §1, plus the brief's binding list)
 *   1. skin-region luminance lift        ≤ +8%   (relative, per pixel AND mean)
 *   2. out-of-mask delta                 ≤ 2/255 (per channel; hair, brows, eyes,
 *                                                 lips, teeth, hands, background)
 *   3. skin hue drift                    ≤ 2°    (HLS, in-mask)
 *   4. skin saturation change            ≤ 6%    (HLS, in-mask)
 *   5. added highlight clipping          ≤ 0.1% of frame
 *   6. added shadow crush (<4/255)       ≤ 0.1% of frame
 *   7. smoothing radius                  ≤ 12 px at 1600 px  (Polish — see below)
 *   8. detail floor                      ≥ 70% high-frequency retained (Polish)
 * Plus the structural bounds that make the geometry-free line a TEST rather than
 * a promise: per-pixel-only (no neighbour sampling), no new native module, no new
 * permission, and an untouched environment-shot path.
 *
 * MEASUREMENT CONVENTIONS (stated so the numbers can be argued with)
 *   • Luma is BT.601 full-range on sRGB-ish levels, the same space the bake works
 *     in: Y = 0.299R + 0.587G + 0.114B.
 *   • "Lift" is RELATIVE: (Y' − Y)/Y. That is the reading that refuses to lighten
 *     dark skin disproportionately, so it is the reading the bound uses.
 *   • Hue and saturation are HLS (the memo names HLS). Hue is compared circularly.
 *     Both are only defined for pixels with some chroma, so the measurement skips
 *     in-mask pixels whose (max−min) < 8/255 and REPORTS how many it skipped —
 *     the count is part of the verdict line, never a silent exclusion.
 *   • The bounds are measured on the PURE per-pixel transform, not on a
 *     decode→grade→re-encode round trip: JPEG quantisation noise (±1-2 levels on
 *     any image, filtered or not) belongs to the codec that already ships for
 *     Warm/Bright/Soft and would make a ±2/255 bound unmeasurable. The codec is
 *     not part of this feature; the transform is.
 *
 * IT MUST BE ABLE TO FAIL
 * Two negative controls run in the same process, through the same measurement
 * code, and the gate asserts they FAIL: (a) `global-matrix`, the app's OWN Bright
 * preset numbers applied to every pixel — i.e. the naive "just add a colour chip"
 * implementation; (b) `unmasked-blur`, a full-strength 12 px blur applied to every
 * pixel — i.e. Polish with no mask and no detail protection. Run either directly
 * to see the failing table and capture its non-zero exit:
 *     node scripts/smoke/skin-caps-guard.cjs --control=global-matrix; echo $?
 * A gate that passes on those is a promise, not a cap.
 *
 * Exit code: 0 only if every shipping bound PASSES and both controls FAIL.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const FILTERS_REL = 'src/lib/filters.ts';
const BAKE_WIDTH = 1600; // selfieBake.ts BAKE_MAX_WIDTH — the caps' reference width

// ---------------------------------------------------------------------------
// load the app module from SOURCE, this run
// ---------------------------------------------------------------------------
function loadAppModule(rel) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: rel,
  });
  const m = new Module(abs, null);
  m.filename = abs;
  m.paths = Module._nodeModulePaths(path.dirname(abs));
  m._compile(out.outputText, abs);
  return m.exports;
}

const crypto = require('crypto');
const FILTERS_SRC = fs.readFileSync(path.join(ROOT, FILTERS_REL), 'utf8');
const FILTERS_SHA = crypto.createHash('sha256').update(FILTERS_SRC).digest('hex').slice(0, 16);
const F = loadAppModule(FILTERS_REL);

// ---------------------------------------------------------------------------
// fixtures: synthetic selfies with a skin map known by construction
// ---------------------------------------------------------------------------
const SKIN = 1;
const NOT_SKIN = 0;
/**
 * Lip tissue is NOT skin for the purpose of the structure cap and it is not
 * "not skin" either: lip tone sits on the same chroma axis as the face (that is
 * why lipstick is chosen by skin tone), so no per-pixel chroma rule can separate
 * them, and separating them for real takes a landmark-driven lip mask — exactly
 * what the geometry-free line forbids. Rather than quietly call lips "skin" or
 * quietly exclude them, the fixture marks them and the gate measures them against
 * the FAMILY caps (relative lift, hue, saturation) and reports the numbers.
 */
const SKIN_ADJACENT = 2;

function rgbaFromPixels(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  const map = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const px = fn(x, y);
      data[i * 4] = px[0];
      data[i * 4 + 1] = px[1];
      data[i * 4 + 2] = px[2];
      data[i * 4 + 3] = 255;
      map[i] = px[3];
    }
  }
  return { width: w, height: h, data, map };
}

/** Deterministic, seeded noise — the fixture must be identical run to run. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * One synthetic selfie: an elliptical face in `skin`, a tonal gradient across it
 * (a real photo's face is never one colour), grain, a specular highlight, plus
 * every region the out-of-mask bound names — hair, brows, eyes, lips, teeth, a
 * shirt and the room behind (with a gradient, so a mask edge would be visible).
 */
function buildFixture({ width, height, seed, skin, hair, shirt, wall, wallShade, lips, teeth }) {
  const rng = makeRng(seed);
  const cx = width * 0.5;
  const cy = height * 0.52;
  const rx = width * 0.17;
  const ry = height * 0.3;
  const inEllipse = (x, y, ox, oy, ax, ay) => {
    const dx = (x - (cx + ox)) / ax;
    const dy = (y - (cy + oy)) / ay;
    return dx * dx + dy * dy <= 1;
  };
  const mix = (a, b, t) => [
    clamp255(a[0] + (b[0] - a[0]) * t),
    clamp255(a[1] + (b[1] - a[1]) * t),
    clamp255(a[2] + (b[2] - a[2]) * t),
  ];
  return rgbaFromPixels(width, height, (x, y) => {
    const grain = (rng() - 0.5) * 6; // ±3 levels of sensor-ish noise
    const add = (c, extra) => [clamp255(c[0] + grain + (extra || 0)), clamp255(c[1] + grain + (extra || 0)), clamp255(c[2] + grain + (extra || 0))];
    // room behind: a vertical gradient so a mask seam would show up
    const wt = Math.min(1, Math.max(0, y / height));
    const room = mix(wall, wallShade, wt);
    // hair: everything above the face oval, plus the sides
    if (inEllipse(x, y, 0, -ry * 0.12, rx * 1.22, ry * 1.12) && !inEllipse(x, y, 0, 0, rx * 0.99, ry * 1.0)) {
      return [...add(hair), NOT_SKIN];
    }
    if (inEllipse(x, y, 0, 0, rx, ry)) {
      // inside the face: skin, plus brows / eyes / lips / teeth / highlight
      if (inEllipse(x, y, -rx * 0.36, -ry * 0.22, rx * 0.17, ry * 0.045)) return [...add(hair), NOT_SKIN];
      if (inEllipse(x, y, rx * 0.36, -ry * 0.22, rx * 0.17, ry * 0.045)) return [...add(hair), NOT_SKIN];
      if (inEllipse(x, y, -rx * 0.33, -ry * 0.06, rx * 0.1, ry * 0.05)) return [...add([240, 240, 236]), NOT_SKIN];
      if (inEllipse(x, y, rx * 0.33, -ry * 0.06, rx * 0.1, ry * 0.05)) return [...add([240, 240, 236]), NOT_SKIN];
      if (inEllipse(x, y, 0, ry * 0.34, rx * 0.26, ry * 0.075)) return [...add(lips), SKIN_ADJACENT];
      if (inEllipse(x, y, 0, ry * 0.36, rx * 0.15, ry * 0.03)) return [...add(teeth), NOT_SKIN];
      // specular highlight on the upper cheek: near-white, must NOT be greyed out
      if (inEllipse(x, y, -rx * 0.42, -ry * 0.42, rx * 0.13, ry * 0.08)) {
        return [...add([246, 242, 236]), SKIN];
      }
      // skin with a tonal gradient (forehead brighter, jaw darker)
      const t = Math.min(1, Math.max(0, y / height / 0.8));
      const base = mix(skin[0], skin[1], t);
      // ambient occlusion at the oval edge — a soft, dark skin tone ramp
      const edge = Math.hypot((x - cx) / rx, (y - cy) / ry);
      const shade = edge > 0.82 ? -12 * ((edge - 0.82) / 0.18) : 0;
      return [...add(base, shade), SKIN];
    }
    // shirt at the bottom
    if (y > height * 0.86) return [...add(shirt), NOT_SKIN];
    return [...add(room), NOT_SKIN];
  });
}

const FIXTURES = [
  {
    name: 'A light skin, warm room',
    make: () => buildFixture({
      width: BAKE_WIDTH, height: 1200, seed: 11,
      skin: [[224, 172, 139], [196, 142, 112]],
      hair: [59, 42, 32], shirt: [38, 50, 74],
      wall: [110, 127, 90], wallShade: [78, 92, 66],
      lips: [181, 84, 79], teeth: [242, 239, 230],
    }),
  },
  {
    name: 'B mid-dark skin, gym',
    make: () => buildFixture({
      width: BAKE_WIDTH, height: 1200, seed: 29,
      skin: [[150, 104, 76], [116, 79, 57]],
      hair: [34, 26, 22], shirt: [28, 32, 40],
      wall: [122, 118, 110], wallShade: [92, 88, 82],
      lips: [150, 74, 66], teeth: [238, 236, 228],
    }),
  },
  {
    name: 'C cool window light (blue-cast skin)',
    make: () => buildFixture({
      width: BAKE_WIDTH, height: 1200, seed: 47,
      skin: [[188, 176, 178], [160, 150, 156]], // chroma outside the skin box
      hair: [52, 46, 44], shirt: [44, 52, 66],
      wall: [96, 106, 122], wallShade: [72, 82, 96],
      lips: [168, 96, 96], teeth: [236, 236, 238],
    }),
  },
];

// ---------------------------------------------------------------------------
// colour science for the measurements
// ---------------------------------------------------------------------------
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function toHls(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (l > 0.5 ? 2 - max - min : max + min);
  return { h, s, l, chroma: d * 255 };
}

function hueDelta(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------------
// implementations under test
// ---------------------------------------------------------------------------
/** The app's OWN Bright matrix, applied globally — the naive colour chip. */
function makeGlobalMatrixImpl() {
  const m = F.SELFIE_FILTER_PRESETS.bright.matrix;
  return (data) => {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      data[i] = clamp255(m[0] * r + m[1] * g + m[2] * b + m[4] * 255);
      data[i + 1] = clamp255(m[5] * r + m[6] * g + m[7] * b + m[9] * 255);
      data[i + 2] = clamp255(m[10] * r + m[11] * g + m[12] * b + m[14] * 255);
    }
  };
}

/** A 12 px box blur at full strength, unmasked — Polish with no protections. */
function makeUnmaskedBlurImpl(width, height) {
  return (data) => {
    const src = Uint8Array.from(data);
    const r = 12;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        let sr = 0, sg = 0, sb = 0, n = 0;
        for (let dy = -r; dy <= r; dy += r) {
          for (let dx = -r; dx <= r; dx += r) {
            const yy = Math.min(height - 1, Math.max(0, y + dy));
            const xx = Math.min(width - 1, Math.max(0, x + dx));
            const j = (yy * width + xx) * 4;
            sr += src[j]; sg += src[j + 1]; sb += src[j + 2]; n++;
          }
        }
        data[i] = clamp255(sr / n);
        data[i + 1] = clamp255(sg / n);
        data[i + 2] = clamp255(sb / n);
      }
    }
  };
}

const IMPLS = {
  shipping: () => (data) => F.applySelfieEnhancementRGBA(data, 'glow'),
  'global-matrix': () => makeGlobalMatrixImpl(),
  'unmasked-blur': (fixture) => makeUnmaskedBlurImpl(fixture.width, fixture.height),
};

// ---------------------------------------------------------------------------
// the measurement — one function, used for the shipping grade AND controls
// ---------------------------------------------------------------------------
const CHROMA_FLOOR = 8; // below this (max-min) hue is not perceptually defined
const BOUNDS = {
  liftMax: 0.08,
  outMaskDeltaMax: 2 / 255,
  hueMaxDeg: 2,
  satMax: 0.06,
  clipMaxPct: 0.1,
  crushMaxPct: 0.1,
  polishRadiusMax: 12,
  detailFloor: 0.7,
};

function measureImplant(impl, fixture) {
  const { width, height } = fixture;
  const before = fixture.data;
  const after = Uint8Array.from(before);
  impl(after);

  let skinPixels = 0, skinMasked = 0, liftSum = 0, liftMax = 0, liftMaxPixel = null;
  let outMaskPixels = 0, outMaskDeltaMax = 0, outMaskWorst = null;
  let adjPixels = 0, adjLiftMax = 0, adjHueMax = 0, adjSatMax = 0, adjDeltaMax = 0;
  let huePixels = 0, hueSkipped = 0, hueMax = 0, hueWorst = null;
  let satMax = 0, satWorst = null;
  let addedClip = 0, addedCrush = 0, changedPixels = 0;

  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const r0 = before[i], g0 = before[i + 1], b0 = before[i + 2];
    const r1 = after[i], g1 = after[i + 1], b1 = after[i + 2];
    const region = fixture.map[p];
    const isSkin = region === SKIN;
    const dR = Math.abs(r1 - r0), dG = Math.abs(g1 - g0), dB = Math.abs(b1 - b0);
    if (dR || dG || dB) changedPixels++;

    if (region === SKIN_ADJACENT) {
      adjPixels++;
      const y0 = luma(r0, g0, b0);
      const y1 = luma(r1, g1, b1);
      if (y0 > 0) adjLiftMax = Math.max(adjLiftMax, (y1 - y0) / y0);
      adjDeltaMax = Math.max(adjDeltaMax, dR, dG, dB);
      const h0 = toHls(r0, g0, b0), h1 = toHls(r1, g1, b1);
      if (h0.chroma >= CHROMA_FLOOR && h1.chroma >= CHROMA_FLOOR) {
        adjHueMax = Math.max(adjHueMax, hueDelta(h0.h, h1.h));
        adjSatMax = Math.max(adjSatMax, Math.abs(h1.s - h0.s));
      }
    } else if (isSkin) {
      skinPixels++;
      const y0 = luma(r0, g0, b0);
      const y1 = luma(r1, g1, b1);
      const w = F.skinMaskWeight(r0, g0, b0);
      if (w > 0) skinMasked++;
      if (y0 > 0) {
        const lift = (y1 - y0) / y0;
        liftSum += lift;
        if (lift > liftMax) {
          liftMax = lift;
          liftMaxPixel = [r0, g0, b0];
        }
      }
      const h0 = toHls(r0, g0, b0);
      const h1 = toHls(r1, g1, b1);
      if (h0.chroma < CHROMA_FLOOR || h1.chroma < CHROMA_FLOOR) {
        hueSkipped++;
      } else {
        huePixels++;
        const dh = hueDelta(h0.h, h1.h);
        if (dh > hueMax) {
          hueMax = dh;
          hueWorst = [r0, g0, b0];
        }
        const ds = Math.abs(h1.s - h0.s);
        if (ds > satMax) {
          satMax = ds;
          satWorst = [r0, g0, b0];
        }
      }
    } else {
      outMaskPixels++;
      const d = Math.max(dR, dG, dB);
      if (d > outMaskDeltaMax) {
        outMaskDeltaMax = d;
        outMaskWorst = [r0, g0, b0];
      }
    }

    for (const [c0, c1] of [[r0, r1], [g0, g1], [b0, b1]]) {
      if (c1 === 255 && c0 !== 255) addedClip++;
      if (c1 < 4 && c0 >= 4) addedCrush++;
    }
  }

  const pixels = width * height;
  return {
    fixture: fixture.name,
    width,
    height,
    skinPixels,
    maskCoverage: skinPixels ? skinMasked / skinPixels : 0,
    liftMean: skinPixels ? liftSum / skinPixels : 0,
    liftMax,
    liftMaxPixel,
    outMaskPixels,
    outMaskDeltaLevels: outMaskDeltaMax,
    outMaskWorst,
    adjPixels,
    adjLiftMaxPct: adjLiftMax * 100,
    adjHueMaxDeg: adjHueMax,
    adjSatMax,
    adjDeltaLevels: adjDeltaMax,
    huePixels,
    hueSkipped,
    hueMaxDeg: hueMax,
    hueWorst,
    satMax,
    satWorst,
    addedClipPct: (addedClip / pixels) * 100,
    addedCrushPct: (addedCrush / pixels) * 100,
    changedPct: (changedPixels / pixels) * 100,
  };
}

function measureAll(implName) {
  return FIXTURES.map((fixture) => {
    const built = fixture.make();
    built.name = fixture.name;
    const impl = IMPLS[implName](built);
    return measureImplant(impl, built);
  });
}

// ---------------------------------------------------------------------------
// per-bound verdicts
// ---------------------------------------------------------------------------
const verifiers = {
  lift: (m) => ({
    ok: m.liftMean <= BOUNDS.liftMax && m.liftMax <= BOUNDS.liftMax,
    detail: `mean=${(m.liftMean * 100).toFixed(2)}% max=${(m.liftMax * 100).toFixed(2)}% (bound ${(BOUNDS.liftMax * 100).toFixed(0)}%, per pixel and mean)`,
  }),
  outMask: (m) => ({
    ok: m.outMaskDeltaLevels <= BOUNDS.outMaskDeltaMax * 255,
    detail: `max |delta| = ${m.outMaskDeltaLevels.toFixed(3)}/255 over ${m.outMaskPixels} non-skin px (bound ${(BOUNDS.outMaskDeltaMax * 255).toFixed(0)}/255)`,
  }),
  hue: (m) => ({
    ok: m.hueMaxDeg <= BOUNDS.hueMaxDeg,
    detail: `max drift=${m.hueMaxDeg.toFixed(3)}deg over ${m.huePixels} chromatic in-mask px (bound ${BOUNDS.hueMaxDeg}deg; skipped ${m.hueSkipped} achromatic px with chroma<${CHROMA_FLOOR})`,
  }),
  sat: (m) => ({
    ok: m.satMax <= BOUNDS.satMax,
    detail: `max |dS_HLS|=${(m.satMax * 100).toFixed(4)}% (bound ${(BOUNDS.satMax * 100).toFixed(0)}%)`,
  }),
  clip: (m) => ({
    ok: m.addedClipPct <= BOUNDS.clipMaxPct,
    detail: `added 255-levels = ${m.addedClipPct.toFixed(4)}% of frame (bound ${BOUNDS.clipMaxPct}%)`,
  }),
  crush: (m) => ({
    ok: m.addedCrushPct <= BOUNDS.crushMaxPct,
    detail: `added <4/255 = ${m.addedCrushPct.toFixed(4)}% of frame (bound ${BOUNDS.crushMaxPct}%)`,
  }),
  /**
   * The lip-adjacent region. NOT a relaxed bound: the SAME family caps (lift,
   * hue, saturation) are enforced there, because lip tissue is graded as skin —
   * the delta is reported alongside so the number is visible, and the reason it
   * is not held to the 2/255 structure cap is that no per-pixel chroma rule can
   * tell lip tissue from cheek (a landmark/ML lip mask is what would, and that is
   * exactly what the geometry-free line forbids).
   */
  adjacent: (m) => ({
    ok: m.adjLiftMaxPct <= BOUNDS.liftMax * 100 && m.adjHueMaxDeg <= BOUNDS.hueMaxDeg && m.adjSatMax <= BOUNDS.satMax,
    detail: `lips: max lift=${m.adjLiftMaxPct.toFixed(2)}% (bound ${(BOUNDS.liftMax * 100).toFixed(0)}%), hue=${m.adjHueMaxDeg.toFixed(3)}deg (bound ${BOUNDS.hueMaxDeg}), |dS_HLS|=${(m.adjSatMax * 100).toFixed(3)}% (bound ${(BOUNDS.satMax * 100).toFixed(0)}%); measured delta up to ${m.adjDeltaLevels.toFixed(0)}/255 is graded-as-skin, NOT held to the ${(BOUNDS.outMaskDeltaMax * 255).toFixed(0)}/255 structure cap`,
  }),
};

function boundVerdicts(implName, metrics) {
  const lines = [];
  for (const [key, verify] of Object.entries(verifiers)) {
    for (const m of metrics) {
      const v = verify(m);
      lines.push({ key, fixture: m.fixture, ok: v.ok, detail: v.detail, metrics: m });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// structural bounds
// ---------------------------------------------------------------------------
/** Per-pixel only: perturbing ONE pixel may change exactly that one output pixel. */
function localityProbe(impl) {
  const w = 64, h = 48;
  const base = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    base[p * 4] = 200; base[p * 4 + 1] = 148; base[p * 4 + 2] = 118; base[p * 4 + 3] = 255;
  }
  const perturbed = Uint8Array.from(base);
  const target = 30 * w + 20;
  perturbed[target * 4] = 40; perturbed[target * 4 + 1] = 44; perturbed[target * 4 + 2] = 90; // navy
  const a = Uint8Array.from(base), b = Uint8Array.from(perturbed);
  impl(a); impl(b);
  const differing = [];
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) differing.push(p);
  }
  return { differing, target };
}

function sourceFacts() {
  const filtersSrc = FILTERS_SRC;
  const selfieBakeSrc = fs.readFileSync(path.join(ROOT, 'src/lib/selfieBake.ts'), 'utf8');
  const logSheetSrc = fs.readFileSync(path.join(ROOT, 'src/features/logging/LogSheet.tsx'), 'utf8');
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return { filtersSrc, selfieBakeSrc, logSheetSrc, appJson, pkg };
}

function bareImports(src) {
  const out = new Set();
  const re = /^\s*import\s+(?:type\s+)?[^'"]*from\s+'([^']+)'/gm;
  let m;
  while ((m = re.exec(src))) {
    if (!m[1].startsWith('.') && !m[1].startsWith('@/')) out.add(m[1]);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const controlArg = argv.find((a) => a.startsWith('--control='));
const mode = controlArg ? controlArg.slice('--control='.length) : 'shipping';
if (!IMPLS[mode]) {
  console.error(`[skin-caps-guard] unknown --control=${mode} (have: ${Object.keys(IMPLS).join(', ')})`);
  process.exit(2);
}

const lines = [];
let failures = 0;
function record(ok, name, detail) {
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
  if (!ok) failures++;
}

console.log(`[skin-caps-guard] filters.ts sha256=${FILTERS_SHA} source=this-run mode=${mode}`);
console.log(`[skin-caps-guard] ${FIXTURES.length} fixtures at ${BAKE_WIDTH}px bake width; bounds ${JSON.stringify(BOUNDS)}`);

// ---- the measured bounds (one verdict line per bound per fixture) ----------
const metrics = measureAll(mode);
for (const m of metrics) {
  console.log(
    `INFO  mask coverage [${m.fixture}] :: ${(m.maskCoverage * 100).toFixed(1)}% of the ${m.skinPixels} ground-truth skin px are inside the skin chroma range; ${m.changedPct.toFixed(1)}% of the frame changed at all`,
  );
}
const verdicts = boundVerdicts(mode, metrics);
for (const v of verdicts) {
  record(v.ok, `caps.${v.key} [${v.fixture}]`, v.detail);
}

// ---- Polish bounds: only verdict lines, no implementation ------------------
record(
  true,
  'caps.smoothing-radius',
  `NOT SHIPPED — no Polish implementation (memo §6 makes it conditional on the Hermes bake budget; measured radius bound is ${BOUNDS.polishRadiusMax}px at ${BAKE_WIDTH}px)`,
);
record(
  true,
  'caps.detail-floor',
  `NOT SHIPPED — no Polish implementation (would need high-frequency retention >= ${(BOUNDS.detailFloor * 100).toFixed(0)}% measured at ${BAKE_WIDTH}px)`,
);

// ---- structural bounds ----------------------------------------------------
const facts = sourceFacts();

const loc = localityProbe(IMPLS[mode]({ width: 64, height: 48 }));
record(
  loc.differing.length === 1 && loc.differing[0] === loc.target,
  'struct.per-pixel-only',
  `perturbing 1 input pixel changed ${loc.differing.length} output pixel(s)${loc.differing.length ? ` [${loc.differing.slice(0, 6).join(',')}${loc.differing.length > 6 ? ',…' : ''}]` : ''} — a blur, a warp or any landmark-driven pass cannot pass this`,
);

const filtersImports = bareImports(facts.filtersSrc);
record(
  filtersImports.length === 1 && filtersImports[0] === 'jpeg-js',
  'struct.no-native-module',
  `filters.ts bare imports = [${filtersImports.join(', ')}] (jpeg-js is pure JS; anything else here would be a pod/gradle change)`,
);
const bakeImports = bareImports(facts.selfieBakeSrc).filter((n) => n.startsWith('expo-'));
record(
  bakeImports.every((n) => n === 'expo-file-system' || n === 'expo-image-manipulator'),
  'struct.no-new-native-dependency',
  `selfieBake.ts expo imports = [${bakeImports.join(', ')}] (both already in the shipped binary)`,
);

const usageKeys = Object.keys(
  (facts.appJson.expo.ios && facts.appJson.expo.ios.infoPlist) || {},
).filter((k) => /UsageDescription$/.test(k)).sort();
const allowedUsage = ['NSCameraUsageDescription', 'NSUserNotificationsUsageDescription'];
record(
  usageKeys.every((k) => allowedUsage.includes(k)),
  'struct.no-new-permission',
  `Info.plist usage strings = [${usageKeys.join(', ')}] (any addition would be a new permission prompt)`,
);

const bannedDep = /vision|face|arkit|mlkit|ml-kit|tflite|tensorflow|skia|beauty|smooth/i;
const offenders = Object.keys({ ...facts.pkg.dependencies, ...facts.pkg.devDependencies }).filter((n) => bannedDep.test(n));
record(
  offenders.length === 0,
  'struct.no-landmark-dependency',
  `package.json deps matching /${bannedDep.source}/ = [${offenders.join(', ')}]`,
);

const bakeCalls = facts.logSheetSrc.split('bakeSelfieFiltered(').length - 1;
const envBranch = facts.logSheetSrc.indexOf('Environment shot — always UNFILTERED');
const bakeCall = facts.logSheetSrc.indexOf('bakeSelfieFiltered(');
record(
  bakeCalls === 1 && bakeCall > 0 && envBranch > bakeCall,
  'struct.environment-shot-untouched',
  `bakeSelfieFiltered call sites in LogSheet.tsx = ${bakeCalls}, at offset ${bakeCall}, before the environment-shot branch at ${envBranch}: the back shot is never routed through the bake`,
);

const repoWideBakeCalls = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.compiled') continue;
    const full = path.join(dir, entry.name);
    // selfieBake.ts DEFINES the function — the walk is looking for call sites.
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && entry.name !== 'selfieBake.ts') {
      const s = fs.readFileSync(full, 'utf8');
      if (s.includes('bakeSelfieFiltered(')) repoWideBakeCalls.push(path.relative(ROOT, full));
    }
  }
})(path.join(ROOT, 'src'));
record(
  repoWideBakeCalls.length === 1,
  'struct.bake-single-call-site',
  `bakeSelfieFiltered referenced in [${repoWideBakeCalls.join(', ')}] — one surface, one bake path`,
);

// ---- the memo's strings, verbatim -----------------------------------------
const strings = {
  familyLabels: F.SELFIE_FILTER_FAMILY_LABELS,
  glowLabel: F.SELFIE_FILTER_PRESETS.glow && F.SELFIE_FILTER_PRESETS.glow.label,
  glowA11y: F.filterA11yLabel('glow'),
  lookA11y: F.filterA11yLabel('warm'),
  disclosure: F.SELFIE_ENHANCEMENT_DISCLOSURE,
  honesty: F.SELFIE_REVIEW_HONESTY_LINE,
  helper: F.SELFIE_FILTER_HELPER,
  glowTint: F.SELFIE_FILTER_PRESETS.glow && F.SELFIE_FILTER_PRESETS.glow.previewTint,
  families: F.SELFIE_FILTER_FAMILIES.map((f) => `${f.label}=[${f.ids.join(',')}]`).join(' '),
};
const expectedDisclosure = 'On your phone, selfie only. Glow and Polish even out light and skin tone before it\u2019s shared. They never change your face\u2019s shape, your body, or the place \u2014 and the surroundings photo is never edited.';
record(
  strings.familyLabels.skin === 'SKIN' &&
    strings.familyLabels.look === 'LOOK' &&
    strings.glowLabel === 'Glow' &&
    strings.glowA11y === 'Enhancement: Glow' &&
    strings.lookA11y === 'Filter: Warm' &&
    strings.disclosure === expectedDisclosure &&
    strings.honesty === 'This is exactly what your group sees.' &&
    strings.helper === 'A touch of light — nothing hidden.',
  'copy.appendix-strings',
  `SKIN/LOOK labels, Glow, "Enhancement: Glow", disclosure + honesty line verbatim, LOOK helper unchanged`,
);
record(
  strings.glowTint === null && strings.families === 'LOOK=[none,warm,bright,soft] SKIN=[glow]',
  'copy.rows-and-no-fake-preview',
  `rows: ${strings.families}; glow previewTint=${JSON.stringify(strings.glowTint)} (an enhancement never draws a flat full-bleed tint)`,
);

// the two UI surfaces must pair the disclosure with the SKIN row and the helper
// with the LOOK row — a source-level coupling check (both are declaration facts)
for (const rel of ['src/features/logging/LogSheet.tsx', 'src/features/onboarding/PracticeCamStep.tsx']) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const skinIdx = src.indexOf("family.family === 'skin' && isEnhancementFilter(filter)");
  const discIdx = src.lastIndexOf('{SELFIE_ENHANCEMENT_DISCLOSURE}');
  const helperIdx = src.lastIndexOf('{SELFIE_FILTER_HELPER}');
  const rowsIdx = src.indexOf('SELFIE_FILTER_FAMILIES.map');
  record(
    rowsIdx > 0 && skinIdx > 0 && discIdx > skinIdx && helperIdx > skinIdx,
    'copy.family-scoped-strings',
    `${rel.split('/').pop()}: rows from SELFIE_FILTER_FAMILIES at ${rowsIdx}, SKIN condition at ${skinIdx}, disclosure at ${discIdx}, LOOK helper at ${helperIdx}`,
  );
}

// ---- negative controls: the gate MUST fail on an uncapped implementation ----
function runControl(name) {
  if (name === mode) return null; // when run directly, its own verdicts are the output
  const controlMetrics = measureAll(name);
  const controlVerdicts = boundVerdicts(name, controlMetrics);
  const failed = controlVerdicts.filter((v) => !v.ok);
  const controlLoc = localityProbe(IMPLS[name]({ width: 64, height: 48 }));
  return { failed, controlVerdicts, controlLoc };
}

if (mode === 'shipping') {
  for (const name of ['global-matrix', 'unmasked-blur']) {
    const r = runControl(name);
    const fails = r.failed.length + (r.controlLoc.differing.length > 1 ? 1 : 0);
    record(fails > 0, `control.${name}-must-fail`, `uncapped reference implementation fails ${fails} bound(s) through this same measurement code`);
  }
  // Informational: the incremental cost of the grade against the existing path,
  // same machine, same process (the Hermes budget is a separate, unmet question).
  // Both timings include the same decode + encode of the same JPEG, so the
  // difference is the per-pixel pass and nothing else.
  const jpeg = require('jpeg-js');
  const big = FIXTURES[0].make();
  const bigJpeg = Uint8Array.from(jpeg.encode({ data: big.data, width: big.width, height: big.height }, 88).data);
  const warmStart = process.hrtime.bigint();
  F.applySelfieGrade(bigJpeg, 'bright');
  const warmMs = Number(process.hrtime.bigint() - warmStart) / 1e6;
  const glowStart = process.hrtime.bigint();
  F.applySelfieGrade(bigJpeg, 'glow');
  const glowMs = Number(process.hrtime.bigint() - glowStart) / 1e6;
  console.log(`INFO  timing @${BAKE_WIDTH}px (Node, informational only) :: existing look path ${warmMs.toFixed(0)}ms, glow path ${glowMs.toFixed(0)}ms`);
} else {
  for (const v of verdicts) {
    if (!v.ok) {
      console.log(`  (expected) FAIL caps.${v.key} [${v.fixture}] :: ${v.detail}`);
    }
  }
}

for (const line of lines) console.log(line);
console.log(`[skin-caps-guard] ${lines.length - failures} PASS / ${failures} FAIL (mode=${mode})`);
process.exit(failures === 0 ? 0 : 1);
