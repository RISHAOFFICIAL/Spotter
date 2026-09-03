/**
 * InviteRow — the "Send your gym partner the link now" affordance (invite-flow.md §1).
 *
 * Renders on the Welcome screen (before signup). On mount it PRE-GENERATES the
 * invite code (persisted to AsyncStorage in dev / an invites row in real mode)
 * so "send now" works the moment it's tapped — even if the user bails on
 * onboarding. The code is the shareable capability: partner(s) install the
 * app, enter the code, accept, and the pair feed lights up.
 *
 * MVP call (recorded): a shareable CODE string, not a deep link — the code
 * needs no universal-link/domain configuration, works identically on iOS +
 * Android + dev builds, and the Accept screen is one code entry away. The
 * invite sheet still shares the template via the OS share sheet.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { colors, icons, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import {
  getOrCreateInviteCode,
  inviteMessageTemplate,
  type InviteInfo,
} from '@/lib/invites';

/** Exact copy per invite-flow.md §7. */
export const INVITE_ROW_LABEL = 'Send your gym partner the link now';
export const INVITE_SENT_LINE = 'Link sent. They\u2019ll show up in your feed when they accept.';

export function InviteRow() {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-generate on mount (invite-flow.md §1: before signup completes).
  useEffect(() => {
    let mounted = true;
    void getOrCreateInviteCode()
      .then((code) => {
        if (mounted) {
          setInvite(code);
        }
      })
      .catch(() => {
        if (mounted) setError('Couldn\u2019t prepare your invite just yet.');
      });
    return () => {
      mounted = false;
    };
  }, []);

  const share = async () => {
    if (!invite?.displayCode) return;
    try {
      // The OS share sheet is the last hop before sending — one tap to open,
      // one tap to send (two-tap rule). No SMS/WhatsApp SDK, no permissions.
      const message = inviteMessageTemplate(invite.displayCode);
      await Share.share({ message });
      setSent(true);
      // After share completes the row swaps to the success line (spec §1) —
      // it stays as confirmation and never returns to the CTA this session.
    } catch {
      // User dismissed the sheet — keep the row as-is; no dead end.
    }
  };

  if (sent) {
    return (
      <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
        {INVITE_SENT_LINE}
      </Text>
    );
  }

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={INVITE_ROW_LABEL}
        onPress={() => void share()}
        style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}
      >
        <Ionicons name="share-outline" size={icons.lengths.badge} color={colors.text.secondary.hex} />
        <Text style={[textStyles.captionStrong.style, { color: colors.text.secondary.hex }]}>
          {INVITE_ROW_LABEL}
        </Text>
      </Pressable>
      {invite?.displayCode ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy invite code"
          onPress={async () => {
            try {
              await Clipboard.setStringAsync(invite.displayCode);
            } catch {
              // Copy failure is non-fatal for the flow.
            }
          }}
          hitSlop={8}
          style={styles.copyLine}
        >
          <Text style={[textStyles.label.style, { color: colors.text.muted.hex, textAlign: 'center' }]}>
            {invite.isDev ? `DEMO CODE: ${invite.displayCode} — TAP TO COPY` : `${invite.displayCode} — TAP TO COPY`}
          </Text>
        </Pressable>
      ) : null}
      {error && (
        <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, textAlign: 'center' }]}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    alignSelf: 'center',
  },
  copyLine: { marginTop: spacing.xs, alignItems: 'center' },
});