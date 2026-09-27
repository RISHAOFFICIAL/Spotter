import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { PASSWORD_MIN_LENGTH } from '@/lib/supabase';
import { colors, icons, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

/**
 * The one password entry row, shared by BOTH signup screens (onboarding
 * WelcomeStep and the invite EnterCodeScreen) so the two forms cannot drift
 * apart. Owner's shape (2026-09-27): ONE password field — never a confirm
 * field — with a show/hide toggle whose VoiceOver label follows the state, the
 * requirement visible, and entry-time validation that is rendered, never
 * silently discarded.
 *
 * Everything the owner asked to be visible is DERIVED from
 * PASSWORD_MIN_LENGTH in src/lib/supabase.ts — the module that enforces the
 * rule — so the copy cannot drift from the enforcer:
 *   - the requirement line,
 *   - the entry-time validation copy,
 *   - the submit-time message (exported below; the auth module returns the
 *     same sentence for the same input).
 * The rule itself is the backend's: 422 weak_password "Password should be at
 * least 6 characters.", measured against the live project on 2026-09-27.
 */

/** VoiceOver labels for the toggle: the action the tap will perform. */
export const SHOW_PASSWORD_LABEL = 'Show password';
export const HIDE_PASSWORD_LABEL = 'Hide password';

/** The rule, in the words of the backend that enforces it. */
export function passwordRequirement(min: number = PASSWORD_MIN_LENGTH): string {
  return `At least ${min} characters.`;
}

/**
 * The entry-time validation line: null while there is nothing to say (empty
 * field, or a password that already satisfies the rule), so the field never
 * nags before the user has typed — and never holds a complaint it does not
 * show. Built from the rule at the moment it is rendered, never a frozen string.
 */
export function passwordIssue(value: string, min: number = PASSWORD_MIN_LENGTH): string | null {
  if (!value) return null;
  if (value.length >= min) return null;
  return `Too short — ${value.length} of ${min} characters.`;
}

export function PasswordField({
  value,
  onChangeText,
  onSubmitEditing,
  centered = false,
}: {
  value: string;
  onChangeText: (next: string) => void;
  onSubmitEditing?: () => void;
  /** EnterCodeScreen centres its input text; WelcomeStep's is left-aligned. */
  centered?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const issue = passwordIssue(value);
  const align = centered ? styles.centeredText : null;
  return (
    <View>
      <View style={styles.field}>
        {/* textContentType stays "password" on purpose: switching it to
            "newPassword" would hand iOS's strong-password AutoFill this form,
            a visible behaviour change nobody asked for. */}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Password"
          placeholderTextColor={colors.text.muted.hex}
          secureTextEntry={!revealed}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          style={[styles.input, align, styles.inputWithReveal]}
          accessibilityLabel="Password"
          onSubmitEditing={onSubmitEditing}
        />
        {/* 48×48 (>=44pt) real button; `revealed` is this component's state, so
            the glyph, the label and the field's secureTextEntry cannot
            disagree. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={revealed ? HIDE_PASSWORD_LABEL : SHOW_PASSWORD_LABEL}
          onPress={() => setRevealed((v) => !v)}
          hitSlop={8}
          style={styles.revealBtn}
        >
          <Ionicons
            name={revealed ? 'eye-off-outline' : 'eye-outline'}
            size={icons.lengths.badge}
            color={colors.text.muted.hex}
          />
        </Pressable>
      </View>
      {/* The requirement, always visible, at the point of entry. */}
      <Text style={[textStyles.caption.style, styles.requirement, align]}>{passwordRequirement()}</Text>
      {/* Entry-time validation: rendered under the field, in the app's danger
          colour, as soon as the typed password is short of the rule. */}
      {issue ? (
        <Text style={[textStyles.caption.style, styles.issue, align]}>{issue}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { position: 'relative', justifyContent: 'center' },
  input: {
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.background.overlay.hex,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    paddingHorizontal: spacing.lg,
    color: colors.text.primary.hex,
    fontSize: 16,
  },
  centeredText: { textAlign: 'center' },
  // Reserve the toggle's width inside the field so the typed text never runs
  // under the glyph.
  inputWithReveal: { paddingRight: 48 },
  revealBtn: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  requirement: { color: colors.text.muted.hex, marginTop: spacing.xs },
  issue: { color: colors.text.danger.hex, marginTop: 2 },
});
