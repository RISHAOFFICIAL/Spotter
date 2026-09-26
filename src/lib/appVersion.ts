/**
 * The ONE definition of the version string this app stamps onto its own rows.
 *
 * WHO READS IT: `analytics_events.app_version` (src/lib/analytics.ts) and
 * `push_devices.app_version` (src/lib/pushRegistration.ts). Nothing else. The
 * crash breadcrumb (src/lib/diagnostics.ts) reads the embedded config directly
 * for the same purpose and was already correct, so it is left alone.
 *
 * WHY THIS EXISTS (2026-09-26): all three stamp sites were hardcoded as 1.1.0
 * while app.json declared 1.0.0, so the 1.0.0 launch build would have
 * mislabelled every row it wrote as 1.1.0 — version-segmented retention data
 * unattributable, and a real future 1.1.0 indistinguishable from launch. The
 * value is now DERIVED from the version the app declares in app.json, which
 * Expo resolves into `Constants.expoConfig.version` at build time (the same
 * read diagnostics.ts uses), so the number a build stamps cannot disagree with
 * the number it shipped as.
 *
 * SAFETY: this module is imported by the core loop, so it must never throw —
 * every read is optional-chained inside a try/catch. There is deliberately NO
 * version-shaped literal here (the guard's src sweep forbids one anywhere under
 * src/, so a stale copy of the number cannot come back, even a currently-correct
 * one, because it would silently drift at the next release). If the embedded
 * config carries no version — an environment where app.json is not knowable
 * either — the stamp is APP_VERSION_UNKNOWN rather than a plausible but wrong
 * number: an unattributable row is honest, a mislabelled one is not.
 *
 * GUARD: scripts/smoke/app-version-guard.cjs (offline gate 0f) — it asserts the
 * value actually reaching an event row and a push row equals app.json's, proves
 * the value follows the embedded config, and negative-controls itself against
 * the pre-fix pattern.
 */
import Constants from 'expo-constants';

/**
 * Stamped only when the running build exposes no version at all. Deliberately
 * NOT version-shaped, so it can never be read as a release number.
 */
export const APP_VERSION_UNKNOWN = 'unknown';

/** Trimmed non-empty strings only — a blank config field is not a version. */
function readVersion(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * app.json's `expo.version` as resolved into this build, or null when the
 * running bundle does not expose it. Never throws, never blocks.
 */
export function readDeclaredAppVersion(): string | null {
  try {
    const fromExpoConfig = readVersion(Constants?.expoConfig?.version);
    if (fromExpoConfig) return fromExpoConfig;
    // Older manifest shapes (Expo Go / web) that the current types no longer
    // describe; read defensively so a missing config can never throw here.
    const legacy = (Constants as { manifest?: { version?: unknown } | null }).manifest;
    return readVersion(legacy?.version);
  } catch {
    return null;
  }
}

/** The version this build stamps onto every row it writes. */
export const APP_VERSION: string = readDeclaredAppVersion() ?? APP_VERSION_UNKNOWN;
