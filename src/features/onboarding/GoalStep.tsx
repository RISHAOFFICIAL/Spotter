/**
 * Screen 3 — Set weekly goal (was screen 2; PracticeCamStep inserted ahead of
 * it in the 2026-09-11 addendum — shell step 3 of 4).
 * 7 chips (values 1-7), preset 3; live micro-preview line
 * "{n} days a week = ring filled by {day}"; Continue = "Next".
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { buttons, colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

import { OnboardingScreen } from './OnboardingScreen';

interface Props {
  value: number;
  onChange: (v: number) => void;
  onNext: () => void;
  onSkip: () => void;
  onBack?: () => void;
  completionDay: string;
}

export function GoalStep({ value, onChange, onNext, onSkip, onBack, completionDay }: Props) {
  const chips = [1, 2, 3, 4, 5, 6, 7];
  return (
    <OnboardingScreen
      step={3}
      onBack={onBack}
      onSkip={onSkip}
      primaryLabel="Next"
      onPrimary={onNext}
      primaryDisabled={false}
    >
      <View style={styles.content}>
        <Text style={[textStyles.display.style, styles.headline]}>How many days a week?</Text>
        <Text style={[textStyles.body.style, styles.subhead]}>
          Be honest. Stretch a little, then hit it.
        </Text>
        <View style={styles.chipsRow}>
          {chips.map((n) => {
            const selected = n === value;
            return (
              <Pressable
                key={n}
                accessibilityRole="button"
                accessibilityLabel={`${n} day${n === 1 ? '' : 's'} a week`}
                accessibilityState={{ selected }}
                onPress={() => onChange(n)}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[textStyles.bodyStrong.style, { color: selected ? colors.text.onVolt.hex : colors.text.primary.hex }]}>
                  {n}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={[textStyles.caption.style, styles.preview]}>
          {value} days a week = ring filled by {completionDay}
        </Text>
        <Text style={[textStyles.caption.style, { color: colors.text.muted.hex, textAlign: 'center' }]}>
          {value} selected, default
        </Text>
      </View>
    </OnboardingScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.xl, gap: spacing.lg },
  headline: { color: colors.text.primary.hex, textAlign: 'center' },
  subhead: { color: colors.text.secondary.hex, textAlign: 'center' },
  chipsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: buttons.chip.gap,
    paddingHorizontal: spacing.xs,
  },
  chip: {
    width: 56,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.background.surface.hex,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: {
    backgroundColor: colors.brand.primary.hex,
    borderColor: colors.brand.primary.hex,
  },
  preview: { color: colors.text.secondary.hex, textAlign: 'center' },
});