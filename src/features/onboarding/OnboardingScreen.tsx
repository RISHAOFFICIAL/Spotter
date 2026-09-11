/**
 * Onboarding screen shell: dark base background, safe areas, optional back
 * chevron (22pt secondary), progress bar (2pt volt — 4 segments as of the
 * 2026-09-11 addendum: Welcome → Practice cam → Goal → Week start) and
 * "Skip for now" ghost link (bottom-left, muted per spec).
 *
 * Back-chevron rule (addendum §3.3): the chevron renders ONLY when `onBack`
 * is provided — PracticeCamStep has no back route and must not show a dead
 * chevron; GoalStep/WeekStartStep opt in with a real `onBack`.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// SafeAreaView's JSX props are typed via react-native-safe-area-context's
// NativeSafeAreaViewProps, which RN 0.86 strict-api typing narrows so that
// `style` is dropped. This local alias restores the style prop with the same
// runtime component — no `any`, no global loosening.
const SafeAreaViewT = SafeAreaView as unknown as React.ComponentType<{
  style: StyleProp<ViewStyle>;
  edges: readonly ('top' | 'bottom' | 'left' | 'right')[];
  children?: React.ReactNode;
}>;

import { AppButton, ProgressBar, TextButton } from '@/components/AppButton';
import { colors, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

export function OnboardingScreen({
  step,
  children,
  onBack,
  onSkip,
  canSkip = true,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryLoading = false,
  footer,
}: {
  step: 1 | 2 | 3 | 4;
  children: React.ReactNode;
  onBack?: () => void;
  onSkip: () => void;
  canSkip?: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <SafeAreaViewT
      style={styles.safe as StyleProp<ViewStyle>}
      edges={['top', 'bottom', 'left', 'right']}
    >
      <View style={styles.screen}>
        <ProgressBar fraction={step / 4} />
        <View style={styles.headerRow}>
          {onBack ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={onBack}
              hitSlop={10}
              style={styles.backBtn}
            >
              <Text style={[textStyles.title.style, { color: colors.text.secondary.hex, fontSize: 22, lineHeight: 24 }]}>‹</Text>
            </Pressable>
          ) : (
            <View style={styles.backBtn} />
          )}
          <View style={styles.headerRight} />
        </View>
        <View style={styles.content}>{children}</View>
        <View style={styles.actions}>
          {footer}
          <AppButton
            label={primaryLabel}
            onPress={onPrimary}
            disabled={primaryDisabled}
            loading={primaryLoading}
            type="primary"
          />
          {canSkip && (
            <View style={styles.skipRow}>
              <TextButton label="Skip for now" onPress={onSkip} color={colors.text.muted.hex} />
            </View>
          )}
        </View>
      </View>
    </SafeAreaViewT>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background.base.hex },
  screen: { flex: 1, paddingHorizontal: spacing.screen.paddingX },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 44,
    paddingHorizontal: spacing.xs,
  },
  backBtn: { width: 32, alignItems: 'center', justifyContent: 'center' },
  headerRight: { width: 32 },
  content: { flex: 1 },
  actions: { paddingBottom: spacing.xl, gap: spacing.md },
  skipRow: { alignItems: 'center', marginTop: spacing.xs },
});