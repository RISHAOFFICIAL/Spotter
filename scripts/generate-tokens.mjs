#!/usr/bin/env node
/**
 * Generates src/theme/tokens.ts from the single source of truth:
 * /home/team/shared/design/tokens.json (or DESIGN_TOKENS_PATH override).
 *
 * Tokens are machine-read, never hand-transcribed: if you edit tokens.json,
 * re-run `npm run tokens` and commit the regenerated src/theme/tokens.ts.
 * Verification: `npm run tokens:check` fails if the generated file is stale.
 *
 * All string values are escaped for TS single-quote literals via q().
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESIGN_TOKENS_PATH =
  process.env.DESIGN_TOKENS_PATH || '/home/team/shared/design/tokens.json';
const OUT =
  process.env.TOKENS_OUT || resolve(__dirname, '..', 'src', 'theme', 'tokens.ts');

const json = JSON.parse(readFileSync(DESIGN_TOKENS_PATH, 'utf8'));

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const q = (s) => `'${esc(s)}'`;

function buildLines() {
  const L = [];
  const push = (s = '', indent = 0) => L.push(' '.repeat(indent) + s);

  push('/* eslint-disable */');
  push('// AUTO-GENERATED from design/tokens.json — do not edit by hand.');
  push('// Run `npm run tokens` to regenerate; `npm run tokens:check` verifies sync.');
  push('// Source of truth: /home/team/shared/design/tokens.json');
  push('');
  push('export const meta = {');
  push(`  appName: ${q(json.meta.app_name)},`);
  push(`  theme: ${q(json.meta.theme)},`);
  push(`  platforms: ${q(json.meta.platforms)},`);
  push(`  updated: ${q(json.meta.updated)},`);
  push('};');
  push('');

  const colors = json.color;
  push('export const colors = {');
  for (const group of ['background', 'brand', 'text', 'status', 'reaction']) {
    push(`  ${group}: {`);
    for (const key of Object.keys(colors[group])) {
      const c = colors[group][key];
      push(`    ${key}: {`);
      push(`      hex: ${q(c.hex.toLowerCase())},`);
      push(`      rgba: ${q(c.rgba)},`);
      push(`      use: ${q(c.use)},`);
      push('    },');
    }
    push('  },');
  }
  push('};');
  push('');

  push('export const fontStack = {');
  push(`  ios: ${q(json.type.fontStack.ios)},`);
  push(`  android: ${q(json.type.fontStack.android)},`);
  push(`  note: ${q(json.type.fontStack.note)},`);
  push('};');
  push('');
  push('export type TypeStep = { name: string; size: number; lineHeight: number; weight: number; tracking: number; use: string; uppercase?: boolean };');
  push('export const typeScale: TypeStep[] = [');
  for (const t of json.type.scale) {
    push('  {');
    push(`    name: ${q(t.name)}, size: ${t.size}, lineHeight: ${t.lineHeight}, weight: ${t.weight}, tracking: ${t.tracking}, use: ${q(t.use)}${t.uppercase ? ', uppercase: true' : ''},`);
    push('  },');
  }
  push('];');
  push('');

  const sp = json.spacing;
  push('export const spacing = {');
  push(`  grid: ${sp.grid},`);
  push('  sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, giant: 40, huge: 48, mega: 64,');
  push('  scale: {');
  for (const k of Object.keys(sp.scale)) push(`    ${k}: ${sp.scale[k]},`);
  push('  },');
  push('  screen: {');
  push(`    paddingX: ${sp.screen.paddingX},`);
  push(`    paddingTop: ${sp.screen.paddingTop},`);
  push(`    sectionGap: ${sp.screen.sectionGap},`);
  push(`    feedItemGap: ${sp.screen.feedItemGap},`);
  push(`    rowGap: ${sp.screen.rowGap},`);
  push('  },');
  push('  safeArea: {');
  push(`    note: ${q(sp.safeArea)},`);
  push('  },');
  push('};');
  push('');

  const rd = json.radius;
  push('export const radius = {');
  push(`  sm: ${rd.sm},`);
  push(`  md: ${rd.md},`);
  push(`  lg: ${rd.lg},`);
  push(`  xl: ${rd.xl},`);
  push(`  sheetTop: ${rd.sheetTop},`);
  push(`  pill: ${rd.pill},`);
  push(`  circle: ${q(rd.circle)},`);
  push('};');
  push('');

  const ic = json.icon;
  push('export const icons = {');
  push('  lengths: {');
  push(`    tab: ${ic.lengths.tab},`);
  push(`    navHeader: ${ic.lengths.navHeader},`);
  push(`    action: ${ic.lengths.action},`);
  push(`    badge: ${ic.lengths.badge},`);
  push(`    emptyState: ${ic.lengths.emptyState},`);
  push('  },');
  push(`  cameraGlyph: ${ic.cameraGlyph},`);
  push('  stroke: {');
  push(`    regular: ${ic.stroke.regular},`);
  push(`    bold: ${ic.stroke.bold},`);
  push(`    fill: ${ic.stroke.fill},`);
  push('  },');
  push('};');
  push('');

  const wr = json.weeklyRing;
  push('export const weeklyRing = {');
  push(`  outerDiameter: ${wr.outerDiameter},`);
  push(`  trackStroke: ${wr.trackStroke},`);
  push(`  progressStroke: ${wr.progressStroke},`);
  push(`  lineCap: ${q(wr.lineCap)},`);
  push(`  trackColor: ${q(wr.trackColor)},`);
  push(`  trackColorAlpha: ${wr.trackColorAlpha},`);
  push(`  progressColor: ${q(wr.progressColor)},`);
  push(`  progressMissedColor: ${q(wr.progressMissedColor)},`);
  push(`  glowShadow: ${q(wr.glowShadow)},`);
  push(`  rotationStart: ${wr.rotationStart},`);
  push(`  centerLayout: ${q(wr.centerLayout)},`);
  push('  numeral: {');
  push(`    text: ${q(wr.numeral.text)},`);
  push(`    type: ${q(wr.numeral.type)},`);
  push(`    color: ${q(wr.numeral.color)},`);
  push('  },');
  push('  label: {');
  push(`    text: ${q(wr.label.text)},`);
  push(`    type: ${q(wr.label.type)},`);
  push(`    color: ${q(wr.label.color)},`);
  push('  },');
  push('};');
  push('');

  const cb = json.cameraButton;
  push('export const cameraButton = {');
  push(`  tapTarget: ${cb.tapTarget},`);
  push(`  visualDiameter: ${cb.visualDiameter},`);
  push(`  strokeOuter: ${cb.strokeOuter},`);
  push(`  strokeOuterColor: ${q(cb.strokeOuterColor)},`);
  push(`  strokeOuterAlpha: ${cb.strokeOuterAlpha},`);
  push(`  fill: ${q(cb.fill)},`);
  push(`  lensDiameter: ${cb.lensDiameter},`);
  push(`  lensColor: ${q(cb.lensColor)},`);
  push(`  glyph: ${q(cb.glyph)},`);
  push(`  shadow: ${q(cb.shadow)},`);
  push(`  pressedScale: ${cb.pressedScale},`);
  push(`  pressedDurationMs: ${cb.pressedDurationMs},`);
  push('  badge: {');
  push(`    diameter: ${cb.badge.diameter},`);
  push('    offsetFromEdge: {');
  push(`      x: ${cb.badge.offsetFromEdge.x},`);
  push(`      y: ${cb.badge.offsetFromEdge.y},`);
  push('    },');
  push(`    background: ${q(cb.badge.background)},`);
  push(`    border: ${q(cb.badge.border)},`);
  push('    text: {');
  push(`      type: ${q(cb.badge.text.type)},`);
  push(`      size: ${cb.badge.text.size},`);
  push(`      color: ${q(cb.badge.text.color)},`);
  push('    },');
  push(`    visibleWhen: ${q(cb.badge.visibleWhen)},`);
  push(`    counts: ${q(cb.badge.counts)},`);
  push('  },');
  push('};');
  push('');

  const bt = json.buttons;
  push('export const buttons = {');
  push('  primary: {');
  push(`    height: ${bt.primary.height},`);
  push(`    radius: ${bt.primary.radius},`);
  push(`    background: ${q(bt.primary.background)},`);
  push('    label: {');
  push(`      type: ${q(bt.primary.label.type)},`);
  push(`      color: ${q(bt.primary.label.color)},`);
  push('    },');
  push(`    shadow: ${q(bt.primary.shadow)},`);
  push(`    pressedBackground: ${q(bt.primary.pressedBackground)},`);
  push('  },');
  push('  secondary: {');
  push(`    height: ${bt.secondary.height},`);
  push(`    radius: ${bt.secondary.radius},`);
  push(`    background: ${q(bt.secondary.background)},`);
  push(`    border: ${q(bt.secondary.border)},`);
  push('    label: {');
  push(`      type: ${q(bt.secondary.label.type)},`);
  push(`      color: ${q(bt.secondary.label.color)},`);
  push('    },');
  push('  },');
  push('  ghost: {');
  push(`    height: ${bt.ghost.height},`);
  push(`    radius: ${bt.ghost.radius},`);
  push(`    background: ${q(bt.ghost.background)},`);
  push('    label: {');
  push(`      type: ${q(bt.ghost.label.type)},`);
  push(`      color: ${q(bt.ghost.label.color)},`);
  push('    },');
  push('  },');
  push('  chip: {');
  push(`    height: ${bt.chip.height},`);
  push(`    radius: ${bt.chip.radius},`);
  push(`    background: ${q(bt.chip.background)},`);
  push(`    selectedBackground: ${q(bt.chip.selectedBackground)},`);
  push(`    selectedLabel: ${q(bt.chip.selectedLabel)},`);
  push(`    unselectedLabel: ${q(bt.chip.unselectedLabel)},`);
  push(`    border: ${q(bt.chip.border)},`);
  push(`    gap: ${bt.chip.gap},`);
  push('  },');
  push('};');
  push('');

  const sc = json.statusColors;
  push('export const statusColors = {');
  push('  loggedOk: {');
  push(`    dot: ${q(sc.loggedOk.dot)},`);
  push(`    label: ${q(sc.loggedOk.label)},`);
  push('  },');
  push('  missed: {');
  push(`    dot: ${q(sc.missed.dot)},`);
  push(`    label: ${q(sc.missed.label)},`);
  push('  },');
  push('  pending: {');
  push(`    dot: ${q(sc.pending.dot)},`);
  push(`    label: ${q(sc.pending.label)},`);
  push('  },');
  push('};');
  push('');

  const sh = json.shadows;
  push('export const shadows = {');
  push(`  card: ${q(sh.card)},`);
  push(`  tabBar: ${q(sh.tabBar)},`);
  push(`  camera: ${q(sh.camera)},`);
  push('};');
  push('');

  const mo = json.motion;
  push('export const motion = {');
  push(`  pageTransitionMs: ${mo.pageTransitionMs},`);
  push(`  ringFillMs: ${mo.ringFillMs},`);
  push(`  ringFillEasing: ${q(mo.ringFillEasing)},`);
  push(`  pressMs: ${mo.pressMs},`);
  push(`  reactionPopMs: ${mo.reactionPopMs},`);
  push('};');
  push('');

  push('// ---- Derived aliases (tokens.md): success == brand.primary, onVolt == brand.onPrimary ----');
  push('export const success = colors.status.success;');
  push('export const onVolt = colors.text.onVolt;');
  push('export const trackInactive = colors.status.trackInactive;');
  push('');
  push('export const tokens = {');
  push('  meta, colors, fontStack, typeScale, spacing, radius, icons, weeklyRing, cameraButton, buttons, statusColors, shadows, motion,');
  push('};');
  push('');
  push('export type Tokens = typeof tokens;');
  push('');
  push('export default tokens;');
  return L.join('\n') + '\n';
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buildLines());
console.log(`tokens.ts regenerated from ${DESIGN_TOKENS_PATH} -> ${OUT}`);