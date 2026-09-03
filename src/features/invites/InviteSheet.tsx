/**
 * InviteSheet — bottom sheet from the Home banner / "Invite a partner"
 * (invite-flow.md §2). Headline + body + "Send the link" primary (OS share
 * sheet) + "Copy link" ghost (clipboard swap "Copied ✓" 1.5s) + ✕ close +
 * scrim tap-to-dismiss. Free only, no upsell.
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
          Bring your gym partner in
        </Text>
        <Text style={[textStyles.caption.style, styles.body]}>
          They get the link, download the app, and your names pair up. Free — for both of you.
        </Text>
        {invite?.displayCode ? (
          <Text style={[textStyles.label.style, styles.code]}>
            {invite.isDev ? `DEMO CODE ${invite.displayCode}` : `CODE ${invite.displayCode}`}
          </Text>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Send the link" onPress={() => void share()} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.9 }]}>
          <Text style={[textStyles.bodyStrong.style, { color: colors.text.onVolt.hex }]}>Send the link</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy link" onPress={() => void copy()} style={styles.ghost} hitSlop={8}>
          <Text style={[textStyles.captionStrong.style, { color: colors.text.muted.hex }]}>
            {copied ? 'Copied ✓' : 'Copy link'}
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(10,12,8,0.72)' },
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
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignSelf: 'center',
  },
  close: { position: 'absolute', top: spacing.md, right: spacing.md, width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headline: { color: colors.text.primary.hex, marginTop: spacing.sm },
  body: { color: colors.text.secondary.hex, paddingRight: spacing.xl },
  code: { color: colors.text.muted.hex },
  primary: {
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.brand.primary.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { alignItems: 'center', paddingVertical: spacing.xs },
});