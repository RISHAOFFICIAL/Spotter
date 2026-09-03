/**
 * EmptyState + InviteBanner (home-screen.md §3, §6).
 *
 * Empty state pattern: centered 64pt icon, headline, caption, gap 8.
 * Cases:
 *  1. noLogsNoPartner — fresh install: ring 0, invite banner on, feed reads
 *     "Nothing logged yet / First week starts whenever you tap the camera…".
 *  2. noLogsPartner   — partner accepted (slice C wires this) — banner gone.
 * Case 3 (logs exist, no partner) renders the banner above the feed, no
 * empty state. Banner is session-dismissible (✕), returns on next open.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, icons, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

export type EmptyCase = 'noLogsNoPartner' | 'noLogsPartner' | 'partnerNoLogs';

export function EmptyState({ variant, partnerName }: { variant: EmptyCase; partnerName?: string }) {
  const isNoPartner = variant === 'noLogsNoPartner';
  const partnerNoLogs = variant === 'partnerNoLogs';
  return (
    <View style={styles.wrap}>
      <Ionicons
        name={isNoPartner ? 'fitness-outline' : partnerNoLogs ? 'watch-outline' : 'watch-outline'}
        size={64}
        color={colors.text.muted.hex}
      />
      <Text style={[textStyles.bodyStrong.style, { color: colors.text.primary.hex, textAlign: 'center' }]}>
        {isNoPartner
          ? 'Nothing logged yet'
          : partnerNoLogs
            ? `Nothing yet — waiting on ${partnerName ?? 'your partner'}`
            : 'Waiting on the first one'}
      </Text>
      <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
        {isNoPartner
          ? 'First week starts whenever you tap the camera. Partner optional.'
          : partnerNoLogs
            ? 'Their first log lands here the second they tap the camera.'
            : `You and ${partnerName ?? 'your partner'} both start at zero.`}
      </Text>
    </View>
  );
}

/** Full-width invite banner (partner == 0) — CTA opens the invite sheet (slice C). */
export function InviteBanner({ onInvite, onDismiss }: { onInvite: () => void; onDismiss: () => void }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null; // session-dismissible; returns on next app open
  return (
    <View style={styles.banner}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss invite banner"
        onPress={() => {
          setHidden(true);
          onDismiss();
        }}
        style={styles.close}
        hitSlop={10}
      >
        <Ionicons name="close" size={16} color={colors.text.muted.hex} />
      </Pressable>
      <Text style={[textStyles.bodyStrong.style, { color: colors.text.primary.hex }]}>No one's watching yet.</Text>
      <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex }]}>
        Your gym partner should see this.
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Invite a partner" onPress={onInvite} hitSlop={8} style={styles.cta}>
        <Text style={[textStyles.bodyStrong.style, { color: colors.brand.primary.hex }]}>Invite a partner</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xxxl,
  },
  banner: {
    backgroundColor: colors.background.surface.hex,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
    gap: spacing.xs,
  },
  close: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cta: { marginTop: spacing.xs, alignSelf: 'flex-start' },
});