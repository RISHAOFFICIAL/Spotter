/**
 * Screen 4 — Set week start day (was screen 3; PracticeCamStep inserted ahead
 * of GoalStep in the 2026-09-11 addendum — shell step 4 of 4).
 * 7 visible day cells (Mon..Sun), preset Mon, "default" tag under/inside the
 * selected cell only; Finish = "Let's go" -> commit -> Home.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import type { WeekStartDay } from '@/lib/database.types';

import { OnboardingScreen } from './OnboardingScreen';

interface Props {
  value: WeekStartDay;
  onChange: (d: WeekStartDay) => void;
  onFinish: () => void;
  onSkip: () => void;
  onBack?: () => void;
}

const DAYS: WeekStartDay[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function WeekStartStep({ value, onChange, onFinish, onSkip, onBack }: Props) {
  return (
    <OnboardingScreen
      step={4}
      onBack={onBack}
      onSkip={onSkip}
      primaryLabel="Let's go"
      onPrimary={onFinish}
      primaryDisabled={false}
    >
      <View style={styles.content}>
        <Text style={[textStyles.display.style, styles.headline]}>When does your week start?</Text>
        <Text style={[textStyles.body.style, styles.subhead]}>
          Your ring resets every week on this day.
        </Text>
        <View style={styles.daysRow}>
          {DAYS.map((d) => {
            const selected = d === value;
            return (
              <Pressable
                key={d}
                accessibilityRole="button"
                accessibilityLabel={`Week starts ${d}${selected ? ', default' : ''}`}
                accessibilityState={{ selected }}
                onPress={() => onChange(d)}
                style={[styles.cell, selected && styles.cellSelected]}
              >
                <Text style={[textStyles.captionStrong.style, { color: selected ? colors.text.onVolt.hex : colors.text.primary.hex }]}>
                  {d}
                </Text>
                {selected && (
                  <Text style={[textStyles.label.style, { color: colors.text.onVolt.hex, fontSize: 10, marginTop: 2 }]}>
                    default
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>
    </OnboardingScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.xl, gap: spacing.lg },
  headline: { color: colors.text.primary.hex, textAlign: 'center' },
  subhead: { color: colors.text.secondary.hex, textAlign: 'center' },
  daysRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.xs },
  cell: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.background.surface.hex,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellSelected: {
    backgroundColor: colors.brand.primary.hex,
    borderColor: colors.brand.primary.hex,
  },
});