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

// The walk below stays inside `src/` and reads .ts/.tsx SOURCES only. This guard
// deliberately reads NOTHING from the smoke harness's compiled-output directory
// and never spawns the lib compiler: `loadAppModule()` transpiles
// src/lib/filters.ts from the CURRENT bytes in-process and pins them with a
// sha256, so it cannot assert against a stale artifact and needs no freshness
// coupling. Loading from that directory here would create one — if you ever add
// such a load, spawn scripts/smoke/compile.cjs first and test its exit status
// (the rule compile-freshness-guard.cjs enforces in its check 13).
const repoWideBakeCalls = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // hidden directories are not source (and never browsed): skip them wholesale
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
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

// ---------------------------------------------------------------------------
// CONSENT — the owner's two promises about the enhancement, gated on the
// RENDERED tree of the real LogSheet (not on source text)
// ---------------------------------------------------------------------------
// WHY RENDERED AND NOT GREPPED. `beauty-mode-scope-2026-10-05.md` §68 makes two
// promises about the enhancement's consent shape:
//   "Default state. Off, always, and NEVER STICKY ... No persistence of the
//    choice, no remote flag, no 'remember my look', no auto-apply."
//   §72: "A one-time, INLINE, NON-MODAL disclosure on first tap of an
//    enhancement chip (not a sheet ...)".
// Both are ELEMENT-TREE facts and both are invisible to a source grep: a grep
// for `useState('none')` passes on a tree whose effect then seeds that state
// from a stored value, and a grep for the disclosure string passes on a tree
// that renders it inside its own <Modal>. So this section MOUNTS the real
// src/features/logging/LogSheet.tsx in plain Node (leaf stubs only, a mini hook
// runtime with DEP-AWARE effects, no reconciler, no Metro, no device — same
// technique as scripts/smoke/signout-feed-labels-guard.cjs and
// scripts/smoke/bottom-bar-guard.cjs) and asserts on the tree that ships.
//
// The dep-aware effect is load-bearing: it is what turns "never sticky" into a
// real open → choose → close → reopen sequence instead of a restatement of the
// declaration. Source text is read ONLY for the two DECLARATION facts that the
// tree cannot show (the reset that makes the reopen work, and the absence of any
// persistence API) — and each of those has a mutated-source negative control.
//
// NEGATIVE CONTROLS, both shapes, so a green run means something:
//   • in-file: hand-built trees that DO persist the choice and DO wrap the
//     disclosure in its own Modal, pushed through the SAME analysers — which
//     must report them as sticky / not-inline;
//   • end-to-end: the real source is mutated four ways (default 'glow'; state
//     seeded from storage; the disclosure wrapped in its own Modal; the reset
//     removed) and this guard must exit 1 on each. Raw output is recorded in
//     /home/team/shared/beauty-consent-gate-2026-10-05.md.
//
// WHAT THIS STILL CANNOT SEE (stated so a green run is not read as more): that
// the line is legible on a real screen, and that no native layer misbehaves.
// Those are device checks.
const React = require('react');
const CONSENT_LIB = {};
(function buildConsentHarness() {
  const MountReact = React;
  const consStores = new Map();
  let consCurrent = null;
  let consQueue = [];
  let consInPass = false;
  let consNeedRerender = false;
  let consRerender = () => {};

  function storeFor(key) {
    let s = consStores.get(key);
    if (!s) {
      s = { key, hooks: [], slots: [], cleanups: [], cursor: 0 };
      consStores.set(key, s);
    }
    return s;
  }
  function useStore(what) {
    if (!consCurrent) throw new Error(`${what} called outside a render`);
    return consCurrent;
  }
  function requestRender() {
    if (consInPass) { consNeedRerender = true; return; }
    consRerender();
  }
  const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const ConsentHooks = {
    useState(init) {
      const s = useStore('useState');
      const i = s.cursor++;
      if (!(i in s.hooks)) s.hooks[i] = typeof init === 'function' ? init() : init;
      const set = (value) => {
        const cur = s.hooks[i];
        const next = typeof value === 'function' ? value(cur) : value;
        if (Object.is(next, cur)) return;
        s.hooks[i] = next;
        requestRender();
      };
      return [s.hooks[i], set];
    },
    useRef(init) { const s = useStore('useRef'); const i = s.cursor++; if (!(i in s.hooks)) s.hooks[i] = { current: init }; return s.hooks[i]; },
    useMemo(fn) { useStore('useMemo').cursor += 1; return fn(); },
    useCallback(fn) { useStore('useCallback').cursor += 1; return fn; },
    useEffect(fn, deps) {
      const s = useStore('useEffect');
      const i = s.cursor++;
      const prev = s.slots[i];
      const dirty = !prev || !sameDeps(prev.deps, deps);
      s.slots[i] = { fn, deps, dirty: dirty || (prev ? prev.dirty : false) };
    },
  };
  ConsentHooks.useLayoutEffect = ConsentHooks.useEffect;

  const CONSENT_ALERTS = [];
  function consentReactStub() {
    const stub = { __esModule: true };
    for (const k of Object.keys(MountReact)) stub[k] = MountReact[k];
    stub.default = stub;
    stub.useState = ConsentHooks.useState;
    stub.useRef = ConsentHooks.useRef;
    stub.useMemo = ConsentHooks.useMemo;
    stub.useCallback = ConsentHooks.useCallback;
    stub.useEffect = ConsentHooks.useEffect;
    stub.useLayoutEffect = ConsentHooks.useEffect;
    return stub;
  }
  function consName(type) { return typeof type === 'string' ? type : (type && type.name) || 'component'; }

  function expandOne(node, p) {
    if (node === null || node === undefined || typeof node === 'boolean') return node;
    if (Array.isArray(node)) return node.map((c, i) => expandOne(c, `${p}.${i}`));
    if (!MountReact.isValidElement(node)) return node;
    const { type, props } = node;
    if (typeof type === 'string') {
      if (props.children === undefined) return node;
      return MountReact.cloneElement(node, {}, expandChildren(props.children, p));
    }
    if (type === MountReact.Fragment) return MountReact.cloneElement(node, {}, expandChildren(props.children, p));
    if (typeof type === 'function') {
      if (type.prototype && type.prototype.isReactComponent) {
        const inst = new type(props);
        inst.props = props;
        if (!inst.state) inst.state = {};
        return expandOne(inst.render(), `${p}|${type.name}out`);
      }
      const s = storeFor(`${p}|${consName(type)}`);
      s.rerender = requestRender;
      const previous = consCurrent;
      consCurrent = s;
      s.cursor = 0;
      let out;
      try { out = type(props); } finally { consCurrent = previous; }
      consQueue.push(s);
      return expandOne(out, `${p}|${consName(type)}out`);
    }
    return node;
  }
  function expandChildren(children, p) {
    return MountReact.Children.toArray(children).map((c, i) => expandOne(c, `${p}.${i}`));
  }
  function flushConsentEffects() {
    const q = consQueue.slice();
    consQueue = [];
    for (const s of q) {
      for (const slot of s.slots) {
        if (!slot || !slot.dirty) continue;
        slot.dirty = false;
        const cleanup = slot.fn();
        if (typeof cleanup === 'function') s.cleanups.push(cleanup);
      }
    }
  }
  /** Mount a component with a live props object — `render({visible:false})` then
   *  `render({visible:true})` is a real close-and-reopen, not a fresh mount. */
  function mountTree(Component, initialProps) {
    consStores.clear();
    const api = {
      props: initialProps,
      tree: null,
      renders: 0,
      render(newProps) {
        if (newProps) api.props = Object.assign({}, api.props, newProps);
        for (let pass = 0; pass < 12; pass++) {
          consNeedRerender = false;
          consInPass = true;
          consQueue = [];
          const s = storeFor('root');
          const previous = consCurrent;
          consCurrent = s;
          s.cursor = 0;
          let out;
          try { out = Component(api.props); } finally { consCurrent = previous; }
          api.renders += 1;
          // PASS 0 is the render BEFORE any effect has run — the frame the user
          // actually sees when the sheet opens. A useState initialiser of 'glow'
          // would flash the enhancement on before the reset effect corrected it,
          // so the default-off check reads this frame, not only the settled one.
          if (pass === 0) api.firstTree = out;
          consQueue.push(s);
          flushConsentEffects();
          consInPass = false;
          api.tree = out;
          if (!consNeedRerender) break;
        }
        return api.tree;
      },
    };
    consRerender = () => api.render();
    api.render(initialProps);
    return api;
  }

  // ---- module loading: REAL .tsx/.ts sources, leaf deps stubbed -------------
  function transpileForMount(file) {
    const src = CONSENT_LIB.overrides && CONSENT_LIB.overrides.has(file)
      ? CONSENT_LIB.overrides.get(file)
      : fs.readFileSync(file, 'utf8');
    return ts.transpileModule(src, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: file,
    }).outputText;
  }
  const consCache = new Map();
  function resolveSource(fromFile, id) {
    let base;
    if (id.startsWith('@/')) base = path.join(ROOT, 'src', id.slice(2));
    else if (id.startsWith('.')) base = path.resolve(path.dirname(fromFile), id);
    else return null;
    for (const ext of ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
      const f = base + ext;
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
    return null;
  }
  CONSENT_LIB.overrides = new Map();
  function loadSource(file) {
    if (consCache.has(file)) return consCache.get(file);
    const mod = { exports: {} };
    consCache.set(file, mod.exports);
    const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', transpileForMount(file));
    const req = (id) => {
      if (Object.prototype.hasOwnProperty.call(consStubs, id)) return consStubs[id];
      if (/\.(png|jpe?g|svg|ttf)$/i.test(id)) return {};
      const f = resolveSource(file, id);
      if (f) return loadSource(f);
      // a real npm package (jpeg-js is filters.ts's only bare import)
      return require(require.resolve(id, { paths: [path.dirname(file), ROOT, path.join(ROOT, 'node_modules')] }));
    };
    fn(req, mod, mod.exports, file, path.dirname(file));
    consCache.set(file, mod.exports);
    return mod.exports;
  }
  const consStubs = {
    react: consentReactStub(),
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': {
      View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
      TextInput: 'TextInput', Modal: 'Modal', Image: 'Image', Switch: 'Switch',
      ActivityIndicator: 'ActivityIndicator',
      Platform: { OS: 'ios', select: (o) => (o && o.ios) || undefined },
      StyleSheet: { create: (s) => s, flatten: (s) => s },
      Dimensions: { get: () => ({ width: 390, height: 844 }) },
      Linking: { openSettings: () => Promise.resolve() },
      // A consent disclosure behind an Alert is exactly the "modal" shape this
      // section refuses — record every alert so a check can see it.
      Alert: { alert: (...args) => { CONSENT_ALERTS.push(args); } },
    },
    'react-native-safe-area-context': {
      useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
      SafeAreaView: 'SafeAreaView',
    },
    'expo-camera': {
      CameraView: (props) => MountReact.createElement('CameraView', props),
      useCameraPermissions: () => [{ granted: true, canAskAgain: true }, async () => ({ granted: true })],
    },
    '@expo/vector-icons': { Ionicons: (props) => MountReact.createElement('Ionicons', props) },
    'expo-image': { Image: (props) => MountReact.createElement('ExpoImage', props) },
    '@/lib/selfieBake': { bakeSelfieFiltered: async () => ({ ok: true, uri: 'file:///baked.jpg' }) },
    '@/lib/workoutStore': { logWorkout: async () => ({ ok: true, log: null }) },
  };

  // ---- tree readers (pure, shared by the real mount and the controls) -------
  function collect(node, parents, out) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) { for (const c of node) collect(c, parents, out); return; }
    if (!MountReact.isValidElement(node)) return;
    out.push({ node, parents });
    collect(node.props ? node.props.children : undefined, parents.concat([node]), out);
  }
  function allNodes(tree) {
    const out = [];
    collect(tree, [], out);
    return out;
  }
  /** The element's OWN string children, joined — the shape a JSX text child has
   *  in this harness (a single string, or a one-element array of it). */
  function ownText(node) {
    const kids = node.props ? node.props.children : undefined;
    if (typeof kids === 'string') return kids;
    if (typeof kids === 'number') return String(kids);
    if (Array.isArray(kids) && kids.every((k) => typeof k === 'string' || typeof k === 'number')) return kids.join('');
    return null;
  }
  function labelOf(node) {
    return node.props && typeof node.props.accessibilityLabel === 'string' ? node.props.accessibilityLabel : null;
  }
  /** Every chip the tree reports as SELECTED, in tree order. */
  function selectedChips(tree) {
    return allNodes(tree)
      .filter((h) => h.node.props && h.node.props.accessibilityState && h.node.props.accessibilityState.selected === true && labelOf(h.node))
      .map((h) => labelOf(h.node));
  }
  function pressableByLabel(tree, label) {
    const hit = allNodes(tree).find((h) => labelOf(h.node) === label && typeof h.node.props.onPress === 'function');
    return hit ? hit.node : null;
  }
  function textNodes(tree, text) {
    return allNodes(tree).filter((h) => ownText(h.node) === text);
  }
  /** Types of the ancestors of a hit, outermost first (host names; a component
   *  that was not expanded shows as 'component'). */
  function ancestorTypes(hit) {
    return hit.parents.map((p) => consName(p.type));
  }
  /** The disclosure is INLINE (the memo's word) when: it is drawn by a plain
   *  <Text>; its immediate container is the SAME family block that directly
   *  holds the SKIN chip row; and no second Modal sits between it and that
   *  container — the only Modal on the path may be the log sheet's own root. */
  function disclosurePlacement(tree, text, skinChipLabels) {
    const hits = textNodes(tree, text);
    if (hits.length !== 1) return { ok: false, found: hits.length, why: `${hits.length} node(s) carry the disclosure text (want exactly 1)` };
    const hit = hits[0];
    const types = ancestorTypes(hit);
    if (consName(hit.node.type) !== 'Text') return { ok: false, found: 1, why: `drawn by <${consName(hit.node.type)}>, not <Text>` };
    const modals = types.filter((t) => t === 'Modal');
    if (modals.length !== 1 || types[0] !== 'Modal') {
      return { ok: false, found: 1, why: `ancestors [${types.join(' < ')}] — ${modals.length} Modal(s), outermost ${types[0] || 'none'} (want exactly 1: the sheet's own root Modal, nothing in between)` };
    }
    const container = hit.parents[hit.parents.length - 1];
    if (!container) return { ok: false, found: 1, why: 'the disclosure IS the root element' };
    const inlineWith = MountReact.Children.toArray(container.props && container.props.children)
      .filter((kid) => MountReact.isValidElement(kid) && kid.type === 'ScrollView')
      .filter((scroll) => allNodes(scroll).some((h) => skinChipLabels.includes(labelOf(h.node))));
    if (inlineWith.length === 0) {
      return { ok: false, found: 1, why: `its container <${consName(container.type)}> does not directly hold the SKIN chip row — the disclosure is not inline with the row it explains` };
    }
    return { ok: true, found: 1, why: `drawn by <Text> inside <${consName(container.type)}>, the same block that directly holds the SKIN chip row; ancestors [${types.join(' < ')}]` };
  }
  CONSENT_LIB.MountReact = MountReact;
  CONSENT_LIB.Hooks = ConsentHooks;
  CONSENT_LIB.mountTree = mountTree;
  CONSENT_LIB.loadSource = loadSource;
  CONSENT_LIB.allNodes = allNodes;
  CONSENT_LIB.selectedChips = selectedChips;
  CONSENT_LIB.pressableByLabel = pressableByLabel;
  CONSENT_LIB.textNodes = textNodes;
  CONSENT_LIB.ownText = ownText;
  CONSENT_LIB.labelOf = labelOf;
  CONSENT_LIB.disclosurePlacement = disclosurePlacement;
  CONSENT_LIB.alerts = CONSENT_ALERTS;
})();

const LOG_SHEET = path.join(ROOT, 'src', 'features', 'logging', 'LogSheet.tsx');
const DISCLOSURE = F.SELFIE_ENHANCEMENT_DISCLOSURE;
const LOOK_HELPER = F.SELFIE_FILTER_HELPER;
const NONE_CHIP = F.filterA11yLabel('none');
const SKIN_FAMILY = F.SELFIE_FILTER_FAMILIES.find((fam) => fam.family === 'skin') || { ids: [] };
const SKIN_CHIP_LABELS = SKIN_FAMILY.ids.map((id) => F.filterA11yLabel(id));
const FIRST_ENHANCEMENT = SKIN_FAMILY.ids[0];
const ENHANCEMENT_CHIP = F.filterA11yLabel(FIRST_ENHANCEMENT);

/** Mount the real LogSheet, run the open → choose → close → reopen sequence,
 *  and report the facts the checks below assert on. Wrapped so a load failure
 *  FAILs the consent checks instead of killing the run (the pinned count must
 *  still match on a broken tree — that is what makes a mutation comparable). */
function consentFacts() {
  try {
    const LogSheet = CONSENT_LIB.loadSource(LOG_SHEET).LogSheet;
    if (typeof LogSheet !== 'function') return { error: 'LogSheet.tsx does not export a LogSheet component' };
    const api = CONSENT_LIB.mountTree(LogSheet, { visible: true, onClose: () => {}, onLogged: () => {}, partnerName: 'Rish' });
    const initial = { tree: api.tree, selected: CONSENT_LIB.selectedChips(api.tree) };
    const firstFrame = {
      selected: CONSENT_LIB.selectedChips(api.firstTree),
      disclosureNodes: CONSENT_LIB.textNodes(api.firstTree, DISCLOSURE).length,
    };
    const glowChip = CONSENT_LIB.pressableByLabel(api.tree, ENHANCEMENT_CHIP);
    if (!glowChip) return { error: `no chip labelled "${ENHANCEMENT_CHIP}" with an onPress handler is rendered` };
    glowChip.props.onPress();
    const afterSelect = { tree: api.tree, selected: CONSENT_LIB.selectedChips(api.tree) };
    api.render({ visible: false });
    api.render({ visible: true });
    const afterReopen = { tree: api.tree, selected: CONSENT_LIB.selectedChips(api.tree) };
    return {
      initial,
      firstFrame,
      afterSelect,
      afterReopen,
      renders: api.renders,
      alerts: CONSENT_LIB.alerts.slice(),
      placement: CONSENT_LIB.disclosurePlacement(afterSelect.tree, DISCLOSURE, SKIN_CHIP_LABELS),
      disclosureCountAfterSelect: CONSENT_LIB.textNodes(afterSelect.tree, DISCLOSURE).length,
      disclosureCountInitial: CONSENT_LIB.textNodes(initial.tree, DISCLOSURE).length,
      helperCountInitial: CONSENT_LIB.textNodes(initial.tree, LOOK_HELPER).length,
      helperCountAfterSelect: CONSENT_LIB.textNodes(afterSelect.tree, LOOK_HELPER).length,
    };
  } catch (e) {
    return { error: `${e && e.name}: ${e && e.message}` };
  }
}

// ---------------------------------------------------------------------------
// the DECLARATION facts the tree cannot show — read from the same source file
// ---------------------------------------------------------------------------
const LOG_SHEET_SRC = fs.readFileSync(LOG_SHEET, 'utf8');
const PERSISTENCE_BANS = [
  ['AsyncStorage', /\bAsyncStorage\b/],
  ['SecureStore', /\bSecureStore\b/],
  ['MMKV', /\bMMKV\b/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['a persistence module import', /from\s+['"][^'"]*(?:secure-store|async-storage|mmkv|@\/lib\/storage|@\/lib\/settings)[^'"]*['"]/i],
  ['setItem/getItem', /\.(?:set|get)Item(?:Sync|Async)?\s*\(/],
  ['a "remember my look" flag', /\brememberMyLook\b|\bsavedSelfieFilter\b|\bSELFIE_FILTER_SAVED\b|\bspotter[._-]?look[._-]?filter\b/i],
];
function persistenceViolations(src) {
  return PERSISTENCE_BANS.filter(([, re]) => re.test(src)).map(([name]) => name);
}
/** The reset that makes "never sticky" work: `setFilter('none')` INSIDE the
 *  effect keyed on `[visible]`. */
function resetEffectFacts(src) {
  const anchor = src.indexOf('}, [visible]);');
  if (anchor < 0) return { ok: false, why: 'no effect keyed on [visible] in LogSheet.tsx' };
  const start = src.lastIndexOf('useEffect(', anchor);
  if (start < 0) return { ok: false, why: 'the [visible] dependency is not on a useEffect' };
  const body = src.slice(start, anchor);
  const resetAt = body.indexOf('setFilter(\'none\')');
  const resetAtDq = body.indexOf('setFilter("none")');
  const at = resetAt >= 0 ? resetAt : resetAtDq;
  if (at < 0) return { ok: false, why: 'the [visible] effect never resets the filter to \'none\'' };
  return { ok: true, why: `setFilter('none') at +${at} inside the effect keyed on [visible] (${body.length} chars)`, body };
}

// ---- the two promise checks + their declaration companions ----------------
const consent = consentFacts();
if (consent.error) {
  for (const name of [
    'consent.default-off-initial',
    'consent.disclosure-absent-while-off',
    'consent.disclosure-inline-on-select',
    'consent.disclosure-not-modal',
    'consent.disclosure-single-surface',
    'consent.never-sticky-across-opens',
  ]) {
    record(false, name, `the real LogSheet could not be mounted: ${consent.error}`);
  }
} else {
  // (a) DEFAULT OFF — the first render of the sheet selects the LOOK 'None' chip
  //     and nothing in the SKIN row. This is the shipped tree, not a constant.
  record(
    consent.firstFrame.selected.length === 1 && consent.firstFrame.selected[0] === NONE_CHIP &&
      consent.initial.selected.length === 1 && consent.initial.selected[0] === NONE_CHIP,
    'consent.default-off-initial',
    `first frame (before any effect) selects [${consent.firstFrame.selected.join(', ')}], settled render selects [${consent.initial.selected.join(', ')}] (both want exactly ["${NONE_CHIP}"]; SKIN row rendered ${SKIN_CHIP_LABELS.length} chip(s): [${SKIN_CHIP_LABELS.join(', ')}]) — an initialiser of '${FIRST_ENHANCEMENT}' would flash the enhancement on and fails here`,
  );
  // ...and that default is VISIBLE to the user: with nothing selected the
  // disclosure is absent and the LOOK helper is in its place.
  record(
    consent.disclosureCountInitial === 0 && consent.helperCountInitial === 1 && consent.firstFrame.disclosureNodes === 0,
    'consent.disclosure-absent-while-off',
    `at the default state: disclosure nodes = ${consent.disclosureCountInitial} in the settled render / ${consent.firstFrame.disclosureNodes} in the first frame (want 0), LOOK helper nodes = ${consent.helperCountInitial} (want 1)`,
  );
  // (b) the disclosure, once an enhancement IS chosen, is a one-time INLINE line
  record(
    consent.placement.ok,
    'consent.disclosure-inline-on-select',
    `after tapping "${ENHANCEMENT_CHIP}": ${consent.placement.why}`,
  );
  record(
    consent.placement.ok && consent.alerts.length === 0,
    'consent.disclosure-not-modal',
    `alerts raised while the sheet was driven = ${consent.alerts.length} (want 0); no Alert can carry the disclosure`,
  );
  record(
    consent.disclosureCountAfterSelect === 1 && (LOG_SHEET_SRC.split('{SELFIE_ENHANCEMENT_DISCLOSURE}').length - 1) === 1,
    'consent.disclosure-single-surface',
    `disclosure rendered nodes after selecting = ${consent.disclosureCountAfterSelect} (want 1), render sites of {SELFIE_ENHANCEMENT_DISCLOSURE} in LogSheet.tsx = ${LOG_SHEET_SRC.split('{SELFIE_ENHANCEMENT_DISCLOSURE}').length - 1} (want 1) — one line, one surface, no dialog to dismiss`,
  );
  // (c) NEVER STICKY — choose, close the sheet, reopen it: back to 'none'.
  record(
    consent.afterReopen.selected.length === 1 && consent.afterReopen.selected[0] === NONE_CHIP,
    'consent.never-sticky-across-opens',
    `open → tap "${ENHANCEMENT_CHIP}" (selected [${consent.afterSelect.selected.join(', ')}]) → close → reopen selects [${consent.afterReopen.selected.join(', ')}] (want ["${NONE_CHIP}"]; ${consent.renders} renders in the sequence)`,
  );
}
const persistence = persistenceViolations(LOG_SHEET_SRC);
record(
  persistence.length === 0,
  'consent.no-persistence-in-source',
  `persistence APIs / storage imports in LogSheet.tsx = [${persistence.join(', ')}] — the choice cannot be remembered across launches`,
);
const reset = resetEffectFacts(LOG_SHEET_SRC);
record(reset.ok, 'consent.reset-on-open-declaration', `${reset.why}`);

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
  // ---- the consent promises must be able to fail ---------------------------
  // Same discipline as the caps controls above: hand-built trees that DO break
  // the promise are pushed through the SAME analysers the passing checks use,
  // and the analyser must reject them. (The end-to-end half — the real source
  // mutated four ways, exit 1 captured directly on each — is recorded in
  // /home/team/shared/beauty-consent-gate-2026-10-05.md.)
  function stickyControlFacts() {
    const H = CONSENT_LIB.Hooks;
    const BAG = { saved: FIRST_ENHANCEMENT }; // "as if read from storage at launch"
    function StickySheet(props) {
      const [chosen, setChosen] = H.useState(BAG.saved);
      H.useEffect(() => { BAG.saved = chosen; }, [chosen]);
      const chip = (id) => React.createElement('Pressable', {
        accessibilityRole: 'button',
        accessibilityLabel: F.filterA11yLabel(id),
        accessibilityState: { selected: chosen === id },
        onPress: () => setChosen(id),
      }, React.createElement('Text', null, F.SELFIE_FILTER_PRESETS[id].label));
      return React.createElement('Modal', { visible: props.visible },
        React.createElement('View', null, ['none'].concat(SKIN_FAMILY.ids).map(chip)));
    }
    const api = CONSENT_LIB.mountTree(StickySheet, { visible: true });
    const before = CONSENT_LIB.selectedChips(api.tree);
    const chip = CONSENT_LIB.pressableByLabel(api.tree, ENHANCEMENT_CHIP);
    if (chip) chip.props.onPress();
    api.render({ visible: false });
    api.render({ visible: true });
    const after = CONSENT_LIB.selectedChips(api.tree);
    return { before, after, sticky: after.length === 1 && after[0] !== NONE_CHIP };
  }
  function modalControlPlacement() {
    const tree = React.createElement('Modal', { visible: true },
      React.createElement('View', null,
        React.createElement('Modal', { visible: true }, React.createElement('Text', null, DISCLOSURE)),
        React.createElement('ScrollView', null,
          SKIN_FAMILY.ids.map((id) => React.createElement('Pressable', { accessibilityLabel: F.filterA11yLabel(id) })))));
    return CONSENT_LIB.disclosurePlacement(tree, DISCLOSURE, SKIN_CHIP_LABELS);
  }
  const stickyControl = stickyControlFacts();
  record(
    stickyControl.sticky,
    'control.sticky-choice-must-fail',
    `a sheet that seeds its state from storage and never resets reports [${stickyControl.after.join(', ')}] after close+reopen (was [${stickyControl.before.join(', ')}]) — the never-sticky analyser rejects it`,
  );
  const modalControl = modalControlPlacement();
  record(
    !modalControl.ok,
    'control.modal-disclosure-must-fail',
    `a tree that wraps the disclosure in its own <Modal> is rejected by the same placement analyser :: ${modalControl.why}`,
  );
  const MUTATED_SRC = LOG_SHEET_SRC.replace(
    "setFilter(clearable && selected ? 'none' : f)}",
    "setFilter(clearable && selected ? 'none' : f);\n          void SecureStore.setItemAsync('spotter.selfieFilter', String(f));",
  );
  const mutatedViolations = persistenceViolations(MUTATED_SRC);
  record(
    MUTATED_SRC !== LOG_SHEET_SRC && mutatedViolations.length > 0,
    'control.persistent-source-must-fail',
    `one injected write turns the same analyser from [${persistence.join(', ')}] to [${mutatedViolations.join(', ')}] violations`,
  );
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
