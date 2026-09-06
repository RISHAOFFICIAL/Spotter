#!/usr/bin/env node
/**
 * Transpile the app's src/lib TS modules to CommonJS so the smoke test can
 * exercise the REAL app logic (devMock, invites, workoutStore, supabase facade)
 * under Node — no Metro, no RN runtime. Type-system-only imports (database.types)
 * are elided by TypeScript transpileModule automatically.
 */
const ts = require('typescript');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'scripts', 'smoke', '.compiled');

const FILES = [
  'src/lib/mock.ts',
  'src/lib/invites.ts',
  'src/lib/supabase.ts',
  'src/lib/workouts.ts',
  'src/lib/settings.ts',
  'src/lib/storage.ts',
  'src/lib/workoutStore.ts',
  'src/lib/naming.ts',
];

function stripUnused(moduleMap) {
  const used = new Set();
  for (const root of FILES) {
    const src = fs.readFileSync(path.join(ROOT, root), 'utf8');
    for (const m of Object.keys(moduleMap)) {
      if (src.includes(`from '${m}'`) || src.includes(`from "${m}"`)) used.add(m);
    }
  }
  return Object.fromEntries(Object.entries(moduleMap).filter(([m]) => used.has(m)));
}

const depMap = stripUnused(require('./deps.json'));

function compile() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: rel,
    });
    const name = rel.replace(/^src\/lib\//, '').replace(/\.ts$/, '.js');
    fs.writeFileSync(path.join(OUT, name), out.outputText);
  }
  // Require-map file the runner uses to resolve bare imports to harness stubs.
  fs.writeFileSync(
    path.join(OUT, '_deps.json'),
    JSON.stringify({ map: depMap, files: FILES.map((f) => f.replace(/^src\/lib\//, '').replace(/\.ts$/, '.js')) }, null, 2),
  );
  console.log(`[compile] ${FILES.length} modules -> ${OUT}`);
}

compile();