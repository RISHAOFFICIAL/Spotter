/**
 * OpenSettingsButton — the in-app escape hatch for a denied OS permission.
 *
 * WHY THIS EXISTS (App Review first-run audit, 2026-09-23, finding R3)
 * -------------------------------------------------------------------
 * Both camera-denial surfaces told the user to allow the camera "in Settings"
 * and gave them no control to get there: `Linking` / `openSettings` appeared
 * nowhere in `src/`. Guideline 5.1.1 expects a way forward from a denial, and a
 * reviewer who denies the camera on the first run otherwise has only text.
 * This is the one control both surfaces use, so the label and the behaviour
 * cannot drift apart.
 */
import React from 'react';
import { Linking, Pressable, StyleSheet, Text } from 'react-native';

import { colors, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

/** Accessible name + visible label — the guard asserts on exactly this string. */
export const OPEN_SETTINGS_LABEL = 'Open Settings';

export function OpenSettingsButton({ color = colors.text.secondary.hex }: { color?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={OPEN_SETTINGS_LABEL}
      hitSlop={8}
      onPress={() => {
        // Returns a promise (and rejects if no settings UI exists); the user
        // leaving the app is the whole outcome, so it is fire-and-forget.
        void Linking.openSettings().catch(() => undefined);
      }}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <Text style={[textStyles.captionStrong.style, { color }]}>{OPEN_SETTINGS_LABEL}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: spacing.sm },
});
