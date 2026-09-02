/**
 * Verify src/theme/tokens.ts is in sync with design/tokens.json (source of truth).
 * Fails with a diff hint if stale. Run: npm run tokens:check
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DESIGN = process.env.DESIGN_TOKENS_PATH || '/home/team/shared/design/tokens.json';
const OUT = resolve(ROOT, 'src', 'theme', 'tokens.ts');

if (!existsSync(OUT)) {
  console.error('tokens.ts missing — run `npm run tokens` first.');
  process.exit(1);
}
if (!existsSync(DESIGN)) {
  console.error(`design tokens not found at ${DESIGN} — set DESIGN_TOKENS_PATH.`);
  process.exit(1);
}

// Regenerate to a temp file and compare byte-for-byte with the committed one.
const tmp = OUT + '.tmpcheck';
execSync(`node "${resolve(ROOT, 'scripts', 'generate-tokens.mjs')}" >/dev/null`, {
  env: { ...process.env, TOKENS_OUT: tmp },
});

const a = readFileSync(OUT, 'utf8');
const b = readFileSync(tmp, 'utf8');
// Cleanup temp
try {
  execSync(`rm -f "${tmp}"`);
} catch {}

if (a === b) {
  console.log('tokens.ts is in sync with design/tokens.json ✓');
  process.exit(0);
}
console.error('tokens.ts is STALE — run `npm run tokens` and commit the regenerated file.');
process.exit(1);