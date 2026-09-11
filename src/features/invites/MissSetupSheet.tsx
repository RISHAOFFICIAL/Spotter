/**
 * Miss setup sheet — the pairing-time optional prompt (v1.1 Build #2, M slice,
 * Treats/Promises ledger copy per owner 2026-09-11, rev 13).
 *
 * After pairing completes for the CURRENT user (both paths: the invitee who
 * just accepted a code, and the inviter whose invite just got accepted — both
 * detected via the same hasPartner flip Home already uses for the invite
 * banner), this sheet shows ONCE per user:
 *
 *   title "If you miss a week…"
 *   2-person body  "Leave a note for {firstName}. They'll only see it if you
 *                  actually miss the week — and no one else will. Totally
 *                  optional."
 *   3-person body  "Only you and the person you pick will see it — and only if
 *                  you actually miss the week. Totally optional." + a
 *                  "Who's it to?" picker over the OTHER two members (the
 *                  maker picks their witness — pair-private).
 *   TextInput (maxLength 80, placeholder "I owe you: ___")
 *   Save + Skip (Skip = no promise, never re-asks aggressively)
 *
 * The witness picker is shown ONLY when the group has 3+ members; in a
 * 2-person group the witness auto-resolves to the other member (the RPC
 * ignores any choice — the sheet hides the picker entirely, per spec §5).
 *
 * A per-user 'prompted' flag persists in AsyncStorage (same pattern family as
 * the pet-name preference in naming.ts): once shown — via Save OR Skip — the
 * sheet never re-asks for that user. Saving writes through setMissNote (trim,
 * ≤80 enforced in the lib; empty save == Skip). Neutral tone only — this is a
 * personal note, never a wager/enforcement, and nothing here describes it as
 * one. Copy: exact §4 strings FROM src/lib/promises.ts (curly apostrophes,
 * never the word "partner", no monetary language).
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { MISS_PROMISE_MAX, setMissNote, markMissPromptSeen } from '@/lib/missPromise';
import {
  LEDGER_FRAMING_LINE,
  MISSSET_2P_BODY,
  MISSSET_3P_BODY,
  MISSSET_PICKER_LABEL,
  STAKES_PREVIEW_PAIR_LINE,
} from '@/lib/promises';

/** One selectable witness candidate (a co-member of the maker's group). */
export interface WitnessChoice {
  id: string;
  name: string;
}

// The once-per-user "prompted" flag lives in src/lib/missPromise.ts
// (hasSeenMissPrompt / markMissPromptSeen / clearMissPromptSeen) so the smoke
// harness can exercise the skip-flow; this sheet only calls markMissPromptSeen
// (Save OR Skip both count as seen → never re-asks).

export function MissSetupSheet({
  visible,
  /** The single co-member's first name in a 2-person group (null when solo). */
  partnerFirstName,
  /**
   * Witness candidates = the group's co-members. Length 1 in a 2-person group
   * (picker hidden, witness auto-resolves); length 2+ in a 3-person group
   * (picker shown — "Who's it to?"). Empty when solo (sheet not shown).
   */
  witnessChoices,
  onDone,
}: {
  visible: boolean;
  partnerFirstName: string | null;
  witnessChoices: WitnessChoice[];
  onDone: (saved: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [witnessId, setWitnessId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 3+ group -> require a pick before Save is meaningful; default to none.
  const needsPick = witnessChoices.length >= 2;
  const pickerVisible = needsPick;

  useEffect(() => {
    if (visible) {
      setText('');
      setWitnessId(null);
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
    if (needsPick && !witnessId) {
      setError('Choose who it\u2019s to.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await setMissNote(trimmed, witnessId);
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

  const body = needsPick ? MISSSET_3P_BODY : MISSSET_2P_BODY.replace('{firstName}', partnerFirstName ?? 'them');

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
          {body}
        </Text>
        {pickerVisible && (
          <View style={styles.pickerBlock}>
            <Text style={[textStyles.label.style, { color: colors.text.muted.hex }]}>
              {MISSSET_PICKER_LABEL}
            </Text>
            <View style={styles.pickerRow}>
              {witnessChoices.map((c) => {
                const selected = witnessId === c.id;
                return (
                  <Pressable
                    key={c.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Promise to ${c.name}`}
                    onPress={() => setWitnessId(c.id)}
                    style={({ pressed }) => [
                      styles.choice,
                      selected && styles.choiceSelected,
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <Text
                      style={[
                        textStyles.captionStrong.style,
                        { color: selected ? colors.text.onVolt.hex : colors.text.primary.hex },
                      ]}
                    >
                      {c.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
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
        <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
          {STAKES_PREVIEW_PAIR_LINE} {LEDGER_FRAMING_LINE}
        </Text>
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
  pickerBlock: { gap: spacing.sm },
  pickerRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  choice: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: colors.background.overlay.hex,
  },
  choiceSelected: {
    backgroundColor: colors.brand.primary.hex,
    borderColor: colors.brand.primary.hex,
  },
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