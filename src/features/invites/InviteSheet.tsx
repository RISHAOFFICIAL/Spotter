/**
 * InviteSheet — bottom sheet from the Home banner / "Invite a partner"
 * (invite-flow.md §2; compliance-copy-spec.md §5). Headline + body + "Send the
 * code" primary (OS share sheet) + "Copy code" ghost (clipboard swap
 * "Copied ✓" 1.5s) + ✕ close + scrim tap-to-dismiss. Free only, no upsell.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import {
  getOrCreateInviteCode,
  inviteMessageTemplate,
  type InviteInfo,
} from '@/lib/invites';
import { track } from '@/lib/analytics';

export function InviteSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) return;
    setCopied(false);
    void getOrCreateInviteCode()
      .then(setInvite)
      .catch(() => setInvite(null));
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, [visible]);

  const share = async () => {
    if (!invite?.displayCode) return;
    try {
      // V1.1: share_tapped (intent — fires before the OS sheet resolves).
      void track('pair_action', { action: 'share_tapped' });
      await Share.share({ message: inviteMessageTemplate(invite.displayCode) });
      onClose();
    } catch {
      // Sheet dismissed — stay open; no dead end.
    }
  };

  const copy = async () => {
    if (!invite?.displayCode) return;
    try {
      await Clipboard.setStringAsync(invite.displayCode);
      // V1.1: code_copied (the code VALUE never leaves the device).
      void track('pair_action', { action: 'code_copied' });
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Copy failure is non-fatal.
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <View style={styles.dragHandle} />
        <Pressable accessibilityRole="button" accessibilityLabel="Close invite sheet" onPress={onClose} style={styles.close} hitSlop={10}>
          <Ionicons name="close" size={22} color={colors.text.secondary.hex} />
        </Pressable>
        <Text style={[textStyles.headline.style, styles.headline]}>
          Bring your crew in
        </Text>
        <Text style={[textStyles.caption.style, styles.body]}>
          They enter your 8-character code and join your group. Free — for all of you.
        </Text>
        {invite?.displayCode ? (
          <Text style={[textStyles.label.style, styles.code]}>
            {invite.isDev ? `DEMO CODE ${invite.displayCode}` : `CODE ${invite.displayCode}`}
          </Text>
        ) : null}
        <Text style={[textStyles.caption.style, styles.reuseNote]}>
          One code for the whole group — tell everyone.
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Send the code" onPress={() => void share()} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.9 }]}>
          <Text style={[textStyles.bodyStrong.style, { color: colors.text.onVolt.hex }]}>Send the code</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy code" onPress={() => void copy()} style={styles.ghost} hitSlop={8}>
          <Text style={[textStyles.captionStrong.style, { color: colors.text.muted.hex }]}>
            {copied ? 'Copied ✓' : 'Copy code'}
          </Text>
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
  code: { color: colors.text.muted.hex },
  reuseNote: { color: colors.text.muted.hex, alignSelf: 'center', marginTop: -spacing.sm },
  primary: {
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.brand.primary.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { alignItems: 'center', paddingVertical: spacing.xs },
});