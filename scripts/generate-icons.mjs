#!/usr/bin/env node
/**
 * Generates platform icon sets from the design source icon.png:
 *  - iOS: Assets.xcassets/AppIcon.appiconset/*.png (all required sizes)
 *  - Android: mipmap-<density>/ic_launcher.png + ic_launcher_round.png
 *             + adaptive foreground/background/monochrome (anydpi-v26 XML)
 *  - web favicon: favicon.png (48px)
 *
 * Source: assets/branding/icon-source.png (design package, 1024x1024).
 * Run:  npm run icons      (regenerate)
 *       npm run icons:check (verify freshness — compare mtime of output dir
 *                            against the source png and generic config hash)
 */
import { readFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'assets', 'branding', 'icon-source.png');
const OUT = join(ROOT, 'assets', 'generated', 'icons');

const BG = '#0A0C08'; // tokens: colors.background.base
const FG = '#C6F135'; // tokens: colors.brand.primary (volt)
const MONO = '#FFFFFF';

// iOS AppIcon sizes (points x scale) -> px
const IOS_SIZES = [
  { w: 40, h: 40, s: 2 }, { w: 60, h: 60, s: 2 }, { w: 58, h: 58, s: 2 },
  { w: 87, h: 87, s: 2 }, { w: 80, h: 80, s: 2 }, { w: 120, h: 120, s: 2 },
  { w: 180, h: 180, s: 2 }, { w: 20, h: 20, s: 1 }, { w: 20, h: 20, s: 2 },
  { w: 20, h: 20, s: 3 }, { w: 29, h: 29, s: 1 }, { w: 29, h: 29, s: 2 },
  { w: 29, h: 29, s: 3 }, { w: 40, h: 40, s: 1 }, { w: 40, h: 40, s: 3 },
  { w: 60, h: 60, s: 3 }, { w: 76, h: 76, s: 1 }, { w: 76, h: 76, s: 2 },
  { w: 83.5, h: 83.5, s: 2 }, { w: 1024, h: 1024, s: 1 },
];

const ANDROID_DENSITIES = [
  { name: 'mdpi', d: 48 }, { name: 'hdpi', d: 72 }, { name: 'xhdpi', d: 96 },
  { name: 'xxhdpi', d: 144 }, { name: 'xxxhdpi', d: 192 },
];

function iosFilename(w, s) {
  const f = (w * s);
  const px = Number.isInteger(f) ? f : Math.round(f * 10) / 10;
  return `icon-${px}@${s}x.png`;
}

async function main() {
  if (!existsSync(SRC)) {
    console.error(`icon source not found: ${SRC}`);
    process.exit(1);
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // iOS
  const iosDir = join(OUT, 'ios');
  mkdirSync(iosDir, { recursive: true });
  const iconMeta = [];
  for (const { w, h, s } of IOS_SIZES) {
    const px = Math.round(w * s);
    const file = iosFilename(w, s);
    await sharp(SRC).resize(px, px).png().toFile(join(iosDir, file));
    iconMeta.push({ filename: file, size: `${w}x${h}`, scale: `${s}x` });
  }
  writeFileSync(
    join(iosDir, 'Contents.json'),
    JSON.stringify({
      images: iconMeta.map((m) => ({ filename: m.filename, idiom: 'universal', platform: 'ios', size: m.size, scale: m.scale })),
      info: { author: 'xcode', version: 1 },
    }, null, 2) + '\n'
  );

  // Android mipmaps (legacy launcher + round)
  const andDir = join(OUT, 'android');
  mkdirSync(andDir, { recursive: true });
  for (const { name, d } of ANDROID_DENSITIES) {
    const dir = join(andDir, `mipmap-${name}`);
    mkdirSync(dir, { recursive: true });
    await sharp(SRC).resize(d, d).png().toFile(join(dir, 'ic_launcher.png'));
    await sharp(SRC).resize(d, d).png().toFile(join(dir, 'ic_launcher_round.png'));
  }
  // Adaptive icon foreground/background/monochrome (108dp @ all densities)
  for (const { name } of ANDROID_DENSITIES) {
    const dir = join(andDir, `mipmap-${name}`);
    await sharp(SRC)
      .resize(108, 108)
      .flatten({ background: BG })
      .toFile(join(dir, 'ic_launcher_foreground.png'));
    // plain volt slice on base for background
    await sharp({ create: { width: 108, height: 108, channels: 4, background: BG } })
      .png().toFile(join(dir, 'ic_launcher_background.png'));
    const mono = await sharp(SRC).resize(108, 108).removeAlpha().toColourspace('b-w').png().toBuffer();
    writeFileSync(join(dir, 'ic_launcher_monochrome.png'), mono);
  }
  // anydpi-v26 adaptive XML
  const xmlDir = join(andDir, 'mipmap-anydpi-v26');
  mkdirSync(xmlDir, { recursive: true });
  const xml = (name) => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
  writeFileSync(join(xmlDir, 'ic_launcher.xml'), xml('launcher'));
  writeFileSync(join(xmlDir, 'ic_launcher_round.xml'), xml('launcher_round'));

  // Web favicon 48px
  mkdirSync(join(OUT, 'web'), { recursive: true });
  await sharp(SRC).resize(48, 48).png().toFile(join(OUT, 'web', 'favicon.png'));

  console.log(`icons generated in ${OUT}`);
  console.log(`  iOS: ${IOS_SIZES.length} sizes + Contents.json`);
  console.log(`  Android: 5 densities (launcher/round/adaptive fg/bg/mono) + anydpi-v26 xml`);
  console.log(`  web: favicon 48px`);
}

main().catch((e) => { console.error(e); process.exit(1); });