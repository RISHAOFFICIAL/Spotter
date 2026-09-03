/**
 * BottomBar — the fixed 5-slot tab bar (home-screen.md §5). Home + Feed both
 * point at the same single screen in MVP (Home = Feed, design README #2);
 * Calendar + Profile are dimmed inert placeholders (no locked-badge/upsell
 * language — free-first). The center camera slot is the 80pt primary action
 * that overflows the bar; it always wins.
 */
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, shadows, spacing } from '@/theme/tokens';
import { CameraButton } from './CameraButton';

const SLOT_WIDTH = 56;

export function BottomBar({
  onHome,
  onCamera,
  weekCount,
}: {
  onHome: () => void;
  onCamera: () => void;
  weekCount: number;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      {/* Home — active */}
      <Pressable accessibilityRole="button" accessibilityLabel="Home" onPress={onHome} style={styles.slot} hitSlop={6}>
        <Ionicons name="home" size={iconsTab} color={colors.brand.primary.hex} />
      </Pressable>

      {/* Feed — same screen in MVP (inert indicator) */}
      <Pressable accessibilityRole="button" accessibilityLabel="Feed" onPress={onHome} style={styles.slot}>
        <Ionicons name="list" size={iconsTab} color={colors.text.secondary.hex} />
      </Pressable>

      {/* Camera — the center primary action */}
      <View style={styles.cameraSlot}>
        <CameraButton onPress={onCamera} count={weekCount} />
      </View>

      {/* Calendar — dimmed inert placeholder, no lock/upsell language */}
      <View style={[styles.slot, styles.inert]}>
        <Ionicons name="calendar-outline" size={iconsTab} color={colors.text.secondary.hex} opacity={0.4} />
      </View>

      {/* Profile — dimmed inert placeholder in MVP (sheet is slice C) */}
      <View style={[styles.slot, styles.inert]}>
        <Ionicons name="person-outline" size={iconsTab} color={colors.text.secondary.hex} opacity={0.4} />
      </View>
    </View>
  );
}

const iconsTab = 24;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background.surface.hex,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingTop: spacing.sm,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -2 },
    elevation: 10,
  },
  slot: {
    width: SLOT_WIDTH,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inert: { opacity: 1 },
  cameraSlot: {
    flex: 1,
    alignItems: 'center',
    // camera button overflows the bar vertically by ~8pt above it
    marginTop: -8,
  },
});