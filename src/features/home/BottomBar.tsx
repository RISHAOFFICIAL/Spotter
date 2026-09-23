/**
 * BottomBar — the fixed 5-slot bar: 2 slots left / camera / 2 slots right
 * (home-screen.md §5). Every visible slot DOES something real; nothing here is
 * dimmed or dead. The old inert "Calendar" placeholder is deleted rather than
 * dressed up (Calendar/History is Spotter+ post-launch and must not read as an
 * upsell), and the list glyph is no longer a second Home: there is no Feed
 * screen, so slot 2 opens the pair-private Promises ledger — the same word the
 * destination screen's title and Profile's row use. Two blank 56pt spacers hold
 * the 2-left / 2-right split, because that split is what keeps the 80pt centre
 * camera at exact screen centre. Profile is a REAL minimal surface (compliance
 * brief #2 §4): account info + in-app Delete account (App Store 5.1.1(v)).
 */
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, shadows, spacing } from '@/theme/tokens';
import { CameraButton } from './CameraButton';

const SLOT_WIDTH = 56;

export function BottomBar({
  onHome,
  onCamera,
  inGroup,
  weekCount,
}: {
  onHome: () => void;
  onCamera: () => void;
  /** In a group ⇔ the pair-private ledger has something to open. A solo user
   * gets a blank spacer in slot 2 instead of a screen whose empty state says
   * to set a promise in a Profile block that only renders once paired — the
   * same dead-end defect class this bar was just cleared of. */
  inGroup: boolean;
  weekCount: number;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      {/* Home — active: scrolls the Home feed back to the top (iOS convention).
          Already at the top → the scroll is a no-op, which is the honest answer. */}
      <Pressable accessibilityRole="button" accessibilityLabel="Home" onPress={onHome} style={styles.slot} hitSlop={6}>
        <Ionicons name="home" size={iconsTab} color={colors.brand.primary.hex} />
      </Pressable>

      {/* Promises — the pair-private ledger (receipts glyph rejected: the ledger
          itself says "Promises, not payments"). Solo → blank spacer, same 56pt. */}
      {inGroup ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Promises"
          accessibilityHint="Only you and the person it's to can see these."
          onPress={() => router.push('/(promises)')}
          style={styles.slot}
          hitSlop={6}
        >
          <Ionicons name="journal-outline" size={iconsTab} color={colors.text.secondary.hex} />
        </Pressable>
      ) : (
        <View style={styles.slot} pointerEvents="none" />
      )}

      {/* Camera — the center primary action */}
      <View style={styles.cameraSlot}>
        <CameraButton onPress={onCamera} count={weekCount} />
      </View>

      {/* Inert spacer (nothing drawn, never tappable) — holds the 2-left /
          2-right split so the camera stays at screen centre. Deleting it would
          shove the camera +28pt right and break the shipped marketing art. */}
      <View style={styles.slot} pointerEvents="none" />

      {/* Profile — minimal real surface (compliance brief #2 §4): account
          info + in-app Delete account (App Store 5.1.1(v)). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Profile"
        onPress={() => router.push('/(profile)')}
        style={styles.slot}
        hitSlop={6}
      >
        <Ionicons name="person-outline" size={iconsTab} color={colors.text.secondary.hex} />
      </Pressable>
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
    borderTopColor: 'rgba(0,0,0,0.08)',
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
