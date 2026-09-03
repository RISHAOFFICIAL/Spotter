/**
 * EnterCodeScreen — the accept path M in the app (invite-flow.md §3 + §4).
 *
 * The invite is a shareable CODE (MVP call, recorded — see InviteRow): the
 * invitee opens the app (or this screen from Home), enters the code, and is
 * shown the Accept decision screen. The code path needs no universal-link /
 * domain config and works identically on iOS + Android + dev builds; a deep
 * link (spotter.app/invite/{token}) is deferred (Phase 2 router change).
 *
 * Accepting REQUIRES auth (the slice-C security decision): a code alone can
 * never mutate rows. So this screen resolves the code (public `get_invite`
 * RPC) and then, once the invitee has an account (sign in/create — the same
 * single auth path), calls `accept_invite` with their own JWT.
 *
 * "Just look around" → continues SOLO (the invite stays pending; never a dead
 * end). Pending-until-accepted truth lives in the invite sheet ("Link sent —
 * waiting") and here.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView as KAV,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
// strict-api types break KAV's JSX signature (upstream RN 0.86 preview)
const KeyboardAvoidingView = KAV as unknown as React.ComponentType<{
  behavior?: 'height' | 'position' | 'padding' | undefined;
  children?: React.ReactNode;
}>;

import { AppButton, TextButton } from '@/components/AppButton';
import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  acceptInvite,
  lookupInvite,
  normalizeInviteCode,
  type PendingInviteInfo,
} from '@/lib/invites';

type Stage = 'enter' | 'found' | 'accepting' | 'error';

export function EnterCodeScreen() {
  const router = useRouter();
  const { session, refresh } = useAuth();
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('enter');
  const [info, setInfo] = useState<PendingInviteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const lastCode = useRef('');

  const resolve = async (value: string) => {
    const normalized = normalizeInviteCode(value);
    if (!normalized || normalized.length < 6) {
      setError('Enter the 8-character code from your partner.');
      return;
    }
    lastCode.current = normalized;
    setBusy(true);
    setError(null);
    const res = await lookupInvite(normalized);
    setBusy(false);
    if (!res.found) {
      setStage('enter');
      setError('We couldn\u2019t find that code. Double-check it with your partner.');
      return;
    }
    setInfo(res);
    setStage('found');
  };

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStage('accepting');
    const res = await acceptInvite(lastCode.current);
    if (!res.ok) {
      setBusy(false);
      setStage('error');
      setError(res.error ?? 'Couldn\u2019t accept. Try again.');
      return;
    }
    await refresh();
    setBusy(false);
    // In-app welcome toast is wired on Home (params.toast) — push is out of
    // MVP scope (invite-flow §5). Pass it through the route when it exists.
    // Typed route literal (router.d.ts): '/(home)/(tabs)' is the collapsed
    // index under the (home) group — '/(home)' alone is not in the href union.
    router.replace(
      res.inviterName
        ? { pathname: '/(home)/(tabs)', params: { toast: `You're in. ${res.inviterName}'s logs are live in your feed.` } }
        : '/(home)/(tabs)',
    );
  };

  // Pending auth handled here (inline single-path auth, same as Welcome):
  // if the invitee has no account yet they create one, THEN accept.
  const ensureAccountThenAccept = async () => {
    if (!authEmail || !authPassword) {
      setError('Enter your email and password to create your account.');
      return;
    }
    setBusy(true);
    setError(null);
    const { authenticate } = await import('@/lib/supabase');
    const authRes = await authenticate(authEmail, authPassword);
    if (!authRes.ok) {
      setBusy(false);
      setError(authRes.error ?? 'Something went wrong.');
      return;
    }
    await refresh();
    setBusy(false);
    await accept();
  };

  useEffect(() => {
    // If a session is already present, accept directly (1 tap — spec §3).
    if (session && stage === 'found') return;
  }, [stage, session]);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => (stage === 'enter' ? router.back() : (setStage('enter'), setError(null)))} style={styles.back} hitSlop={10}>
          <Text style={[textStyles.title.style, { color: colors.text.secondary.hex, fontSize: 22, lineHeight: 24 }]}>‹</Text>
        </Pressable>

        {stage === 'enter' && (
          <>
            <Text style={[textStyles.display.style, styles.headline]}>Join your partner</Text>
            <Text style={[textStyles.body.style, styles.subhead]}>
              Enter the invite code they shared. You\u2019ll see each other\u2019s photo-proof logs after you accept.
            </Text>
            <TextInput
              value={code}
              onChangeText={(v) => {
                setCode(v);
                setError(null);
              }}
              placeholder="ABC1-DEF2"
              placeholderTextColor={colors.text.muted.hex}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.input}
              accessibilityLabel="Invite code"
              onSubmitEditing={() => void resolve(code)}
            />
            {error && <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, textAlign: 'center' }]}>{error}</Text>}
            <AppButton label="Look up code" onPress={() => void resolve(code)} disabled={code.length < 5} loading={busy} />
            <View style={styles.soloRow}>
              <TextButton label="Just look around — I\u2019ll pair later" onPress={() => router.replace('/(home)/(tabs)')} color={colors.text.muted.hex} />
            </View>
          </>
        )}

        {stage === 'found' && info && (
          <>
            <Text style={[textStyles.caption.style, styles.context]}>
              {info.inviterName ? `${info.inviterName} invited you to work out together` : 'Your partner invited you to work out together'}
            </Text>
            <Text style={[textStyles.display.style, styles.headline]}>
              {info.inviterHasLogs ? "They're already logging. Your turn." : "They're waiting for you."}
            </Text>
            <Text style={[textStyles.body.style, styles.subhead]}>
              Accept and you\u2019ll see each other\u2019s photo-proof logs. Your weekly ring counts only your workouts — theirs counts only theirs.
            </Text>
            <View style={styles.privacyRow}>
              <Text style={{ fontSize: 14, color: colors.brand.primary.hex }}>✓</Text>
              <Text style={[textStyles.caption.style, styles.privacy]}>
                Photos stay sealed per person — even partners only see each other\u2019s, never anyone else\u2019s.
              </Text>
            </View>

            {!session ? (
              // No account yet: inline create-then-accept (same auth path as Welcome).
              <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <TextInput
                  value={authEmail}
                  onChangeText={setAuthEmail}
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
                  value={authPassword}
                  onChangeText={setAuthPassword}
                  placeholder="Password (6+ characters)"
                  placeholderTextColor={colors.text.muted.hex}
                  secureTextEntry
                  textContentType="password"
                  style={styles.input}
                  accessibilityLabel="Password"
                />
                <AppButton
                  label="Accept & create account"
                  onPress={() => void ensureAccountThenAccept()}
                  disabled={!authEmail || !authPassword || busy}
                  loading={busy}
                />
              </KeyboardAvoidingView>
            ) : (
              <AppButton label="Accept" onPress={() => void accept()} disabled={busy} loading={busy} />
            )}

            {error && <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, textAlign: 'center' }]}>{error}</Text>}

            <View style={styles.soloRow}>
              <TextButton label="Just look around" onPress={() => router.replace('/(home)/(tabs)')} color={colors.text.muted.hex} />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background.base.hex },
  scroll: { padding: spacing.lg, paddingTop: spacing.huge, gap: spacing.lg },
  back: { width: 32, alignItems: 'center', justifyContent: 'center' },
  headline: { color: colors.text.primary.hex, textAlign: 'center' },
  subhead: { color: colors.text.secondary.hex, textAlign: 'center' },
  context: { color: colors.text.secondary.hex, textAlign: 'center' },
  input: {
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.background.overlay.hex,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingHorizontal: spacing.lg,
    color: colors.text.primary.hex,
    fontSize: 16,
    textAlign: 'center',
  },
  privacyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  privacy: { color: colors.text.muted.hex, maxWidth: '85%', textAlign: 'left' },
  soloRow: { alignItems: 'center', marginTop: spacing.xs },
});