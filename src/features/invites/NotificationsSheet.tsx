/**
 * NotificationsSheet — the two-step contextual explainer (v1.1 Build #3,
 * slice 1). Shown ONLY after the user has paired AND completed their first
 * return visit to Home (HomeScreen owns the trigger). NEVER at first open.
 *
 * The sheet says exactly what notifications do TODAY: "Know when
 * {partnerFirstName} logs, and when your invite is accepted — nothing else."
 * No invented variants; missed_week stays off by default (it's a Profile
 * toggle, not promised here).
 *
 *   "Enable notifications" → markNotificationExplained() then the REAL OS
 *     prompt (requestNotificationPermission). Dev mode grants the mock.
 *   "Not now" → dismissed; the local machine permits at most ONE re-ask much
 *     later (14-day cooldown, see notifications.ts).
 *
 * Sheet chrome mirrors InviteSheet + MissSetupSheet (Modal + scrim tap-to-
 * dismiss + drag handle + bottom sheet) so this feels like the same flow.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { markNotificationExplained, dismissNotificationAsk, requestNotificationPermission, refreshPushRegistrationIfGranted } from '@/lib/notifications';

export function NotificationsSheet({
  visible,
  partnerFirstName,
  onDone,
}: {
  visible: boolean;
  partnerFirstName: string | null;
  /** true = user enabled (or dev-granted); false = Not now / dismissed. */
  onDone: (enabled: boolean) => void;
}) {
  const insets = useSafeAreaInsets();

  const close = (enabled: boolean) => {
    onDone(enabled);
  };

  const enable = async () => {
    // Advance the machine BEFORE the OS prompt so a mid-flow close still
    // counts as explained (never nag on the very next screen).
    await markNotificationExplained();
    const granted = await requestNotificationPermission();
    // Refresh registration (dev: mock token upsert; real: token after grant).
    await refreshPushRegistrationIfGranted();
    close(granted === 'granted');
  };

  const notNow = async () => {
    await dismissNotificationAsk();
    close(false);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => void notNow()}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.scrim} onPress={() => void notNow()} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <View style={styles.dragHandle} />
        <Pressable accessibilityRole="button" accessibilityLabel="Close notifications explainer" onPress={() => void notNow()} style={styles.close} hitSlop={10}>
          <Ionicons name="close" size={22} color={colors.text.secondary.hex} />
        </Pressable>
        <Text style={[textStyles.headline.style, styles.headline]}>
          Pair accountability, on your phone
        </Text>
        <Text style={[textStyles.caption.style, styles.body]}>
          Know when {partnerFirstName ?? 'your partner'} logs, and when your invite is accepted — nothing else. You stay in control of every type in Profile later.
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Enable notifications" onPress={() => void enable()} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.9 }]}>
          <Text style={[textStyles.bodyStrong.style, { color: colors.text.onVolt.hex }]}>Enable notifications</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Not now" onPress={() => void notNow()} style={styles.ghost} hitSlop={8}>
          <Text style={[textStyles.captionStrong.style, { color: colors.text.muted.hex }]}>Not now</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(20,24,12,0.55)' },
  sheet: {
    backgroundColor: colors.background.surface.hex,
    borderTopLeftRadius: radius.sheetTop,
    borderTopRightRadius: radius.sheetTop,
    padding: spacing.xl,
    gap: spacing.lg,
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.12)',
    alignSelf: 'center',
  },
  close: { position: 'absolute', top: spacing.md, right: spacing.md, width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headline: { color: colors.text.primary.hex, marginTop: spacing.sm },
  body: { color: colors.text.secondary.hex, paddingRight: spacing.xl },
  primary: {
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.brand.primary.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { alignItems: 'center', paddingVertical: spacing.xs },
});