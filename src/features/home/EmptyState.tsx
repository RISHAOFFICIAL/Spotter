/**
 * EmptyState + InviteBanner (home-screen.md §3, §6; groups-copy-spec §1).
 *
 * Empty state pattern: centered 64pt icon, headline, caption, gap 8.
 * Cases:
 *  1. noLogsNoPartner — fresh install: ring 0, invite banner on, feed reads
 *     "Nothing logged yet / First week starts whenever you tap the camera…".
 *  2. noLogsGroup     — in a group, NOBODY has logged yet — banner gone.
 *  3. memberNoLogs    — I've logged, co-members haven't (banner gone).
 * The solo banner shows while `members.length === 0`; it is session-dismissible
 * (✕), returns on next open.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, icons, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

export type EmptyCase = 'noLogsNoPartner' | 'noLogsGroup' | 'memberNoLogs';

/** N-aware member-name joiner (groups-copy-spec §6): `A` / `A and B`. v1.0 max
 * is one or two co-members, so the "and" joiner suffices — no comma lists. */
export function listNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return names.join(' and ');
}

export function EmptyState({ variant, memberNames }: { variant: EmptyCase; memberNames: string[] }) {
  const isNoPartner = variant === 'noLogsNoPartner';
  const memberNoLogs = variant === 'memberNoLogs';
  const names = memberNames.length > 0 ? listNames(memberNames) : 'your group';
  // Nobody-logged caption (copy-spec §1.5): 2-person keeps "You and {A} both
  // start at zero."; 3-person uses the brief's "{A} and {B} start at zero with you."
  const zeroCaption =
    memberNames.length >= 2
      ? `${memberNames[0]} and ${memberNames[1]} start at zero with you.`
      : memberNames.length === 1
        ? `You and ${memberNames[0]} both start at zero.`
        : 'You and the group both start at zero.'; // unreachable at cap 3 — defensive
  return (
    <View style={styles.wrap}>
      <Ionicons
        name={isNoPartner ? 'fitness-outline' : 'watch-outline'}
        size={64}
        color={colors.text.muted.hex}
      />
      <Text style={[textStyles.bodyStrong.style, { color: colors.text.primary.hex, textAlign: 'center' }]}>
        {isNoPartner
          ? 'Nothing logged yet'
          : memberNoLogs
            ? `Nothing yet — waiting on ${names}`
            : 'Waiting on the first one'}
      </Text>
      <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
        {isNoPartner
          ? 'First week starts whenever you tap the camera. Group optional.'
          : memberNoLogs
            ? 'Their first log lands here the second they tap the camera.'
            : zeroCaption}
      </Text>
    </View>
  );
}

/** Full-width invite banner (members == 0) — CTA opens the invite sheet (groups-copy-spec §1.1). */
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
        Your crew should see this.
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Start a group" onPress={onInvite} hitSlop={8} style={styles.cta}>
        <Text style={[textStyles.bodyStrong.style, { color: colors.brand.primary.hex }]}>Start a group</Text>
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