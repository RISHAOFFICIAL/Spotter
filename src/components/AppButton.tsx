/**
 * Shared button primitives — exact tokens from buttons.primary/secondary/ghost.
 * Used throughout onboarding and auth.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { buttons, colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

type Props = {
  label: string;
  onPress: () => void;
  type?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  style?: object;
};

export function AppButton({
  label,
  onPress,
  type = 'primary',
  disabled = false,
  loading = false,
  accessibilityLabel,
  style,
}: Props) {
  const cfg = buttons[type];
  const isPrimary = type === 'primary';
  const bg =
    type === 'ghost'
      ? 'transparent'
      : disabled
        ? 'rgba(198,241,53,0.40)'
        : type === 'secondary'
          ? cfg.background
          : cfg.background;
  const labelColor = isPrimary ? colors.text.onVolt.hex : type === 'secondary' ? colors.text.primary.hex : colors.text.secondary.hex;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        {
          height: cfg.height,
          borderRadius: cfg.radius,
          backgroundColor: bg,
          borderWidth: 'border' in cfg ? 1 : 0,
          borderColor: 'border' in cfg ? 'rgba(255,255,255,0.12)' : undefined,
          shadowColor: isPrimary ? '#C6F135' : undefined,
          shadowOpacity: isPrimary && !disabled ? 0.25 : 0,
          shadowOffset: isPrimary && !disabled ? { width: 0, height: 4 } : undefined,
          shadowRadius: isPrimary && !disabled ? 16 : 0,
          elevation: isPrimary && !disabled ? 4 : 0,
          opacity: pressed && !disabled ? 0.9 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={labelColor} />
      ) : (
        <Text style={[styles.label, { color: labelColor }, textStyles[type === 'secondary' ? 'captionStrong' : type === 'ghost' ? 'captionStrong' : 'bodyStrong'].style]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingHorizontal: spacing.lg,
  },
  label: {
    textAlign: 'center',
  },
});

/** Inline text button (used for "Invite a partner" line 2 and skip links). */
export function TextButton({
  label,
  onPress,
  color = colors.text.secondary.hex,
  style,
}: {
  label: string;
  onPress: () => void;
  color?: string;
  style?: object;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
      <Text style={[textStyles.captionStrong.style, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** 2pt volt progress bar — 1/3, 2/3, 3/3 per onboarding spec. */
export function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <View
      style={{
        height: 2,
        width: '100%',
        backgroundColor: 'rgba(255,255,255,0.10)',
        borderRadius: radius.pill,
      }}
    >
      <View
        style={{
          width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`,
          height: 2,
          backgroundColor: colors.brand.primary.hex,
          borderRadius: radius.pill,
        }}
      />
    </View>
  );
}