/**
 * Miss setup sheet — the pairing-time optional prompt (v1.1 Build #2, M slice).
 *
 * After pairing completes for the CURRENT user (both paths: the invitee who
 * just accepted a code, and the inviter whose invite just got accepted — both
 * detected via the same hasPartner flip Home already uses for the invite
 * banner), this sheet shows ONCE per user:
 *
 *   title "If you miss a week…"
 *   body  "Leave a note for {partnerFirstName}. They'll only see it if you
 *          actually miss the week. Totally optional."
 *   TextInput (maxLength 80, placeholder "I owe you: ___")
 *   Save + Skip (Skip = no promise, never re-asks aggressively)
 *
 * A per-user 'prompted' flag persists in AsyncStorage (same pattern family as
 * the pet-name preference in naming.ts): once shown — via Save OR Skip — the
 * sheet never re-asks for that user. Saving writes through setMissPromise
 * (trim, ≤80 enforced in the lib); Skip writes nothing. Neutral tone only —
 * this is a personal note, never a wager/enforcement, and nothing here
 * describes it as one.
 *
 * Sheet chrome mirrors InviteSheet (Modal + scrim tap-to-dismiss + drag
 * handle + bottom sheet) so the pairing-time moment feels like one flow.
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { MISS_PROMISE_MAX, setMissPromise, markMissPromptSeen } from '@/lib/missPromise';

// The once-per-user "prompted" flag lives in src/lib/missPromise.ts
// (hasSeenMissPrompt / markMissPromptSeen / clearMissPromptSeen) so the smoke
// harness can exercise the skip-flow; this sheet only calls markMissPromptSeen
// (Save OR Skip both count as seen → never re-asks).

export function MissSetupSheet({
  visible,
  partnerFirstName,
  onDone,
}: {
  visible: boolean;
  partnerFirstName: string | null;
  onDone: (saved: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setText('');
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  const finish = async (saved: boolean) => {
    await markMissPromptSeen();
    onDone(saved);
  };

  const save = async () => {
    if (busy) return;
    const trimmed = text.trim();
    // Empty save == Skip (no promise, no error, no nag).
    if (!trimmed) {
      await finish(false);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await setMissPromise(trimmed);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not save. Try again.');
      return;
    }
    await finish(true);
  };

  const skip = async () => {
    if (busy) return;
    await finish(false);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => void skip()}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.scrim} onPress={() => void skip()} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <View style={styles.dragHandle} />
        <Pressable accessibilityRole="button" accessibilityLabel="Skip miss note setup" onPress={() => void skip()} style={styles.close} hitSlop={10}>
          <Ionicons name="close" size={22} color={colors.text.secondary.hex} />
        </Pressable>
        <Text style={[textStyles.headline.style, styles.headline]}>
          If you miss a week…
        </Text>
        <Text style={[textStyles.caption.style, styles.body]}>
          Leave a note for {partnerFirstName ?? 'your partner'}. They&apos;ll only see it if you actually miss the week. Totally optional.
        </Text>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="I owe you: ___"
          placeholderTextColor={colors.text.muted.hex}
          maxLength={MISS_PROMISE_MAX}
          autoCapitalize="sentences"
          style={styles.input}
          accessibilityLabel="Miss note — what I owe if I miss the week"
          onSubmitEditing={() => void save()}
        />
        {error && (
          <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, textAlign: 'center' }]}>
            {error}
          </Text>
        )}
        <Pressable accessibilityRole="button" accessibilityLabel="Save miss note" onPress={() => void save()} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.9 }]} hitSlop={8}>
          <Text style={[textStyles.bodyStrong.style, { color: colors.text.onVolt.hex }]}>
            {busy ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Skip miss note setup" onPress={() => void skip()} style={styles.ghost} hitSlop={8}>
          <Text style={[textStyles.captionStrong.style, { color: colors.text.muted.hex }]}>
            Skip
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
  input: {
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.background.overlay.hex,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingHorizontal: spacing.lg,
    color: colors.text.primary.hex,
    fontSize: 16,
  },
  primary: {
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.brand.primary.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { alignItems: 'center', paddingVertical: spacing.xs },
});
