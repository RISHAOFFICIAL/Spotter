#!/usr/bin/env node
/**
 * DEVEL TOOL (not part of the runtime, not run by the smoke suite):
 * the deterministic search that produced the layer values in
 * src/lib/lookPreviews.ts, kept in-tree so those numbers are reproducible
 * instead of folklore.
 *
 *   node scripts/looks/tune-look-previews.mjs            # fit all looks, write the TS block
 *   node scripts/looks/tune-look-previews.mjs bright     # fit one look, print only
 *
 * It minimises exactly the rule set in scripts/looks/look-rules.mjs — the same
 * one check-look-previews.mjs asserts — with a seeded random-restart coordinate
 * descent. No least-squares fit, no hand-waving: a candidate either satisfies
 * the contract or it does not.
 *
 * The objective is lexicographic in practice:
 *   1. fewer violations (the rule set, squared in severity) — dominates;
 *   2. fewer layers — a three-layer stack that only *just* beats a one-layer
 *      stack is not worth rendering on a camera preview;
 *   3. larger slack from every boundary — so the committed table is not a
 *      boundary case that flips on a rounding.
 * `saturation` is only offered as a last resort: the first pass runs without it
 * and only a look that cannot be previewed any other way (Mono) gets it.
 */
import { writeFileSync } from 'node:fs';
import { FILTERS, ENGINE, PREVIEWS, REF_TONES, EPS, SIG, evaluateLook, severity, fmtDelta } from './look-rules.mjs';

const BLOCK_OUT = '/tmp/look-preview-block.ts';
const BASE_MODES = ['normal', 'multiply', 'screen', 'darken', 'soft-light'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Layer-stack shapes tried per look: a shape layer, optionally plus a tint. */
function structures(allowSat) {
  const modes = allowSat ? [...BASE_MODES, 'saturation'] : BASE_MODES;
  const out = [];
  for (const m of modes) {
    out.push([m]);
    out.push([m, 'normal']);
    out.push(['normal', m]);
    for (const other of ['soft-light', 'darken', 'multiply']) {
      out.push([m, other]);
      out.push([other, m]);
    }
  }
  if (allowSat) {
    out.push(['saturation', 'soft-light', 'multiply']);
    out.push(['saturation', 'multiply', 'soft-light']);
    out.push(['saturation', 'soft-light', 'darken']);
    out.push(['saturation', 'normal', 'multiply']);
  }
  return out;
}

function toStack(modes, params) {
  const layers = [];
  for (let i = 0; i < modes.length; i += 1) {
    const o = i * 4;
    layers.push({
      color: hex([params[o], params[o + 1], params[o + 2]]),
      alpha: clamp(params[o + 3], 0, 1),
      blend: modes[i],
    });
  }
  return layers;
}

function hex(c) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** Slack of a passing solution: how far it sits from every boundary it touches. */
function margin(result, sig = SIG) {
  let m = Infinity;
  for (const t of result.tones) {
    for (let c = 0; c < 3; c += 1) {
      const b = Math.abs(t.db[c]);
      const p = Math.abs(t.dp[c]);
      if (b <= sig) {
        m = Math.min(m, (SIG - p) / SIG);
        continue;
      }
      const r = p / b;
      m = Math.min(m, (r - 0.4) / 0.4, (1.8 - r) / 1.8);
    }
  }
  for (const l of result.level) {
    if (Math.abs(l.dbl) <= sig) m = Math.min(m, (SIG - Math.abs(l.dpl)) / SIG);
    else m = Math.min(m, Math.abs(l.dpl) / (Math.abs(l.dbl) + 1e-9));
  }
  return m;
}

function score(id, grade, modes, params) {
  const result = evaluateLook(id, grade, toStack(modes, params));
  const satLayers = modes.filter((m) => m === 'saturation').length;
  const structural = modes.length * 0.5 + satLayers * 1.5;
  return { result, s: severity(result) * 1e6 + structural - Math.min(margin(result), 1) };
}

function descend(id, grade, modes, params) {
  let best = params.slice();
  let cur = score(id, grade, modes, best);
  let stepC = 64;
  let stepA = 0.12;
  for (let pass = 0; pass < 6; pass += 1) {
    for (let i = 0; i < best.length; i += 1) {
      const step = i % 4 === 3 ? stepA : stepC;
      for (const dir of [1, -1]) {
        const trial = best.slice();
        trial[i] = clamp(trial[i] + step * dir, 0, i % 4 === 3 ? 1 : 255);
        const sc = score(id, grade, modes, trial);
        if (sc.s < cur.s) {
          cur = sc;
          best = trial;
        }
      }
    }
    stepC *= 0.45;
    stepA *= 0.45;
  }
  return { params: best, ...cur };
}

function seedsFor(id, grade, modeCount, rand) {
  const seeds = [];
  const mid = [128, 128, 128];
  const greys = [[255, 255, 255], [0, 0, 0], [64, 64, 64], [96, 96, 96], [160, 160, 160], [200, 200, 200]];
  const dMid = ENGINE.gradeRgbF(grade, 128, 128, 128).map((v, i) => v - mid[i]);
  const dDeep = ENGINE.gradeRgbF(grade, 40, 40, 40).map((v) => v - 40);
  const alphas = [0.04, 0.07, 0.1, 0.16, 0.25, 0.4];
  const colours = [...greys];
  for (const a of alphas) {
    colours.push(mid.map((v, i) => clamp(v + dMid[i] / a, 0, 255)));
    colours.push(mid.map((v) => clamp(v + dDeep[0] / a, 0, 255)));
  }
  for (const c of colours) {
    for (const a of alphas) {
      const p = [];
      for (let i = 0; i < modeCount; i += 1) p.push(c[0], c[1], c[2], a);
      seeds.push(p);
      // first layer carries the colour, later layers stay near-neutral
      const q = [];
      for (let i = 0; i < modeCount; i += 1) q.push(c[0], c[1], c[2], i === 0 ? a : 0.03);
      seeds.push(q, q.map((v, i) => (i % 4 === 3 ? v : clamp(v + 20, 0, 255))));
    }
  }
  for (let n = 0; n < 14; n += 1) {
    const p = [];
    for (let i = 0; i < modeCount; i += 1) p.push(rand() * 255, rand() * 255, rand() * 255, rand() * 0.5);
    seeds.push(p);
  }
  return seeds.slice(0, 30);
}

function fitLook(id, allowSat) {
  const grade = FILTERS.lookGrade(id);
  const rand = lcg(id.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7) ^ 0x5eed);
  let best = null;
  for (const modes of structures(allowSat)) {
    for (const seed of seedsFor(id, grade, modes.length, rand)) {
      const r = descend(id, grade, modes, seed);
      if (!best || r.s < best.s) best = { modes, ...r };
    }
  }
  return best;
}

function report(label, id, best) {
  const result = best.result;
  console.log(
    `\n${label} ${id}: ${best.modes.length} layer(s) [${best.modes.join(' + ')}]  ` +
      `violations=${result.violations.length}  severity=${severity(result).toExponential(2)}  margin=${margin(result).toFixed(3)}`,
  );
  console.log(
    `  layers: ${best.modes
      .map((m, i) => `${m} ${hex(best.params.slice(i * 4, i * 4 + 3))} a=${best.params[i * 4 + 3].toFixed(3)}`)
      .join(' | ')}`,
  );
  for (const t of result.tones) {
    console.log(`  ${t.tone.padEnd(9)} bake=${fmtDelta(t.db).padEnd(26)} preview=${fmtDelta(t.dp)}`);
  }
  for (const v of result.violations) console.log(`  VIOLATION ${v.tone} ${v.channel} ${v.kind}: ${v.detail}`);
}

const only = process.argv[2];
const ids = FILTERS.LOOK_IDS.filter((id) => !only || id === only);
const chosen = {};

console.log('=== tune-look-previews: seeded coordinate descent against look-rules.mjs ===');
for (const id of ids) {
  if (FILTERS.lookGrade(id).identity) {
    chosen[id] = { modes: [], params: [], violations: [] };
    console.log(`\n${id}: identity look — zero layers by construction`);
    continue;
  }
  let best = fitLook(id, false);
  let stage = 'plain';
  if (best.result.violations.length > 0) {
    const withSat = fitLook(id, true);
    if (withSat.result.violations.length < best.result.violations.length) {
      best = withSat;
      stage = 'saturation-needed';
    }
  }
  chosen[id] = { modes: best.modes, params: best.params, violations: best.result.violations };
  report(`[${stage}]`, id, best);
}

const lines = [];
lines.push('export const LOOK_PREVIEWS: Record<LookId, LookPreview> = {');
for (const id of FILTERS.LOOK_IDS) {
  const c = chosen[id];
  if (!c) continue; // single-look runs only emit that look
  const swatch = PREVIEWS.lookSwatch(id);
  lines.push(`  ${id}: {`);
  lines.push('    layers: [');
  for (let i = 0; i < c.modes.length; i += 1) {
    const o = i * 4;
    lines.push(
      `      { color: '${hex(c.params.slice(o, o + 3))}', alpha: ${c.params[o + 3].toFixed(3)}, blend: '${c.modes[i]}' },`,
    );
  }
  lines.push('    ],');
  lines.push(`    swatch: { from: '${swatch.from}', to: '${swatch.to}' },`);
  lines.push('  },');
}
lines.push('};');
if (!only) {
  writeFileSync(BLOCK_OUT, `${lines.join('\n')}\n`);
  console.log(`\n[block] wrote ${BLOCK_OUT}`);
}
