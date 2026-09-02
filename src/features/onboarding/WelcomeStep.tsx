/**
 * Welcome screen — Screen 1 of onboarding.
 * Layout per onboarding.md: wordmark (24pt/800 centered), hero illustration,
 * headline (display 32), subhead (body/secondary), privacy promise line with
 * 14pt shield-check (volt) left of it, then "Get started" primary CTA.
 * Auth (single path) happens on "Get started" tap via an inline form on this
 * same screen — no create-vs-login fork.
 */
import React, { useState } from 'react';
import { Image, KeyboardAvoidingView as KAV, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
// strict-api types break KAV's JSX signature (upstream RN 0.86 preview);
// cast to a plain component type for this screen.
const KeyboardAvoidingView = KAV as unknown as React.ComponentType<{ behavior?: 'height' | 'position' | 'padding' | undefined; children?: React.ReactNode }>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept after cast for clarity
void KAV;

import { AppButton, TextButton } from '@/components/AppButton';
import { isDevMode } from '@/lib/supabase';
import { colors, icons, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

import { OnboardingScreen } from './OnboardingScreen';

const DEV_BANNER = 'DEV DEMO — LOCAL MOCK';

export function WelcomeStep({
  onDone,
}: {
  onDone: () => void;
}) {
  const [showAuth, setShowAuth] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    // Auth handled by the caller through the single path (authenticate());
    // on success we advance. The form lives here for the inline UX.
    try {
      const { authenticate } = await import('@/lib/supabase');
      const res = await authenticate(email, password);
      if (!res.ok) {
        setError(res.error ?? 'Something went wrong.');
        setBusy(false);
        return;
      }
      onDone();
    } catch {
      setError("Can't reach server. Try again.");
      setBusy(false);
    }
  };

  return (
    <OnboardingScreen
      step={1}
      onSkip={() => onDone()}
      primaryLabel="Get started"
      onPrimary={() => (showAuth ? submit() : setShowAuth(true))}
      primaryDisabled={showAuth ? !email || !password : false}
      primaryLoading={busy}
      footer={
        <View style={styles.authCard}>
          {showAuth ? (
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <Text style={[textStyles.label.style, { color: colors.text.muted.hex, marginBottom: spacing.sm }]}>
                {isDevMode ? DEV_BANNER : 'ACCOUNT'}
              </Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="Email"
                placeholderTextColor={colors.text.muted.hex}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="emailAddress"
                style={styles.input}
                accessibilityLabel="Email"
              />
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor={colors.text.muted.hex}
                secureTextEntry
                textContentType="password"
                style={styles.input}
                accessibilityLabel="Password"
              />
              {error ? (
                <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, marginTop: spacing.xs }]}>
                  {error}
                </Text>
              ) : null}
            </KeyboardAvoidingView>
          ) : (
            <Text style={[textStyles.caption.style, { color: colors.text.muted.hex, textAlign: 'center' }]}>
              {isDevMode ? DEV_BANNER : 'One account keeps your photos sealed to you.'}
            </Text>
          )}
        </View>
      }
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={[textStyles.title.style, styles.wordmark]}>SPOTTER</Text>
        {!showAuth && (
          <Image
            source={require('@/assets/images/onboarding-hero.png')}
            style={styles.hero}
            resizeMode="contain"
            accessibilityLabel="Weekly ring illustration"
          />
        )}
        <Text style={[textStyles.display.style, styles.headline]}>
          Work out like someone's watching. Because they are.
        </Text>
        <Text style={[textStyles.body.style, styles.subhead]}>
          Set a weekly goal. Log each workout with photo proof. Your partner sees it the second you tap.
        </Text>
        <View style={styles.privacyRow}>
          <Text style={{ fontSize: icons.lengths.badge, color: colors.status.success.hex }}>✓</Text>
          <Text style={[textStyles.caption.style, styles.privacy]}>
            Your photos are sealed to your account. Only you and your partner can ever see them.
          </Text>
        </View>
      </ScrollView>
    </OnboardingScreen>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'flex-start', paddingTop: spacing.screen.paddingTop, gap: spacing.md },
  wordmark: { textAlign: 'center', fontWeight: '800', letterSpacing: 1, color: colors.text.primary.hex },
  hero: { width: 240, height: 240, alignSelf: 'center', marginTop: spacing.lg },
  headline: { textAlign: 'center', color: colors.text.primary.hex, paddingHorizontal: spacing.sm },
  subhead: { textAlign: 'center', color: colors.text.secondary.hex, paddingHorizontal: spacing.md },
  privacyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.md },
  privacy: { color: colors.text.muted.hex, maxWidth: '85%', textAlign: 'left' },
  authCard: { marginBottom: spacing.md },
  input: {
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.background.overlay.hex,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingHorizontal: spacing.lg,
    color: colors.text.primary.hex,
    fontSize: 16,
    marginBottom: spacing.sm,
  },
});