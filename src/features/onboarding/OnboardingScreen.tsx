/**
 * Onboarding screen shell: dark base background, safe areas, optional back
 * chevron (22pt secondary), progress bar (2pt volt) and "Skip for now" ghost
 * link (bottom-left, muted per spec).
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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
  step: 1 | 2 | 3;
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
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.screen}>
        <ProgressBar fraction={step / 3} />
        <View style={styles.headerRow}>
          {step > 1 ? (
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
    </SafeAreaView>
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