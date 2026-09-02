/**
 * Home (stub for slice B). Proves the router lands here after onboarding.
 * Slice B builds the real home: weekly ring, camera button, invite banner, feed.
 * Per home-screen.md §8 the whole screen will render from ONE weekly-context
 * query — not built yet (slice B), by explicit scope decision.
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { useAuth } from '@/features/auth/AuthProvider';
import { colors, motion, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

export default function HomeScreen() {
  const { session, profile, isDevMode } = useAuth();
  const params = useLocalSearchParams<{ toast?: string }>();
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    if (params.toast) {
      setToastVisible(true);
      const t = setTimeout(() => setToastVisible(false), 2600);
      return () => clearTimeout(t);
    }
  }, [params.toast]);

  const goal = profile?.weekly_goal ?? 3;
  const wkStart = profile?.week_start_day ?? 'Mon';

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[textStyles.title.style, styles.wordmark]}>SPOTTER</Text>
        <View style={styles.stubCard}>
          <Text style={[textStyles.headline.style, { color: colors.text.primary.hex }]}>
            Your week starts here.
          </Text>
          <Text style={[textStyles.body.style, { color: colors.text.secondary.hex, marginTop: spacing.sm }]}>
            Goal: {goal} day{goal === 1 ? '' : 's'} a week · Week starts {wkStart}
          </Text>
          <Text style={[textStyles.caption.style, { color: colors.text.muted.hex, marginTop: spacing.md }]}>
            Home is a stub in slice A — the weekly ring, camera button and feed land in slice B.
          </Text>
          {isDevMode && (
            <Text style={[textStyles.label.style, { color: colors.text.muted.hex, marginTop: spacing.lg }]}>
              DEV DEMO — LOCAL MOCK
            </Text>
          )}
        </View>
      </ScrollView>

      {toastVisible && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={[textStyles.caption.style, { color: colors.text.primary.hex }]}>
            Defaults set: 3 days, week starts Monday. Change anytime from home.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background.base.hex },
  scroll: { paddingHorizontal: spacing.screen.paddingX, paddingTop: spacing.screen.paddingTop + spacing.lg },
  wordmark: { fontWeight: '800', color: colors.text.primary.hex, marginBottom: spacing.xl },
  stubCard: {
    backgroundColor: colors.background.surface.hex,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: spacing.xl,
  },
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.mega,
    backgroundColor: colors.background.raised.hex,
    borderRadius: radius.md,
    padding: spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -2 },
    elevation: 6,
    opacity: 0.96,
  },
});