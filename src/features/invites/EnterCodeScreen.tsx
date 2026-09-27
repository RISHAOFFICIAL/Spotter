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
 *
 * The inline create-account form carries a create-vs-sign-in MODE, exactly like
 * WelcomeStep's (owner report 2026-09-26; PR #42 fixed the first screen and this
 * is the second screen that had the same defect — the one an invited reviewer
 * hits, and the one App Store frame 07 depicts):
 *  - a masked field is hard to check, so every password field gets a 48pt
 *    reveal/hide control that really flips that field's secure state;
 *  - CREATE mode (the default on this screen: an invited newcomer without an
 *    account is making one) adds a "Confirm password" field whose mismatch
 *    BLOCKS the submit — it never reaches authenticate() — and is rendered by
 *    the error line already on this stage, never silently discarded;
 *  - SIGN-IN mode is for the invitee who already has an account: one password
 *    field, no confirmation.
 * The glyph vocabulary and accessibility labels are shared with WelcomeStep on
 * purpose; the two forms must read as one product.
 */
import React, { useRef, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
// strict-api types break KAV's JSX signature (upstream RN 0.86 preview)
const KeyboardAvoidingView = KAV as unknown as React.ComponentType<{
  behavior?: 'height' | 'position' | 'padding' | undefined;
  children?: React.ReactNode;
}>;

import { AppButton, TextButton } from '@/components/AppButton';
import { colors, icons, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  acceptInvite,
  friendlyAcceptError,
  lookupInvite,
  normalizeInviteCode,
  type PendingInviteInfo,
} from '@/lib/invites';

type Stage = 'enter' | 'found';
type AuthMode = 'create' | 'sign-in';

/** Shown when the two create-mode passwords disagree (same string as WelcomeStep). */
const PASSWORD_MISMATCH = "Those passwords don't match — try again.";

/**
 * Reveal/hide control for one masked field. 48×48 (≥44pt) hit target, and the
 * accessibility label follows the state so a screen reader announces the action
 * the tap will perform. `revealed` is the parent's state, so the glyph and the
 * field's secureTextEntry can never disagree. Byte-identical pattern to
 * WelcomeStep's control (PR #42) — the two forms must read as one product.
 */
function RevealToggle({
  revealed,
  onToggle,
  showLabel,
  hideLabel,
}: {
  revealed: boolean;
  onToggle: () => void;
  showLabel: string;
  hideLabel: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={revealed ? hideLabel : showLabel}
      onPress={onToggle}
      hitSlop={8}
      style={styles.revealBtn}
    >
      <Ionicons
        name={revealed ? 'eye-off-outline' : 'eye-outline'}
        size={icons.lengths.badge}
        color={colors.text.muted.hex}
      />
    </Pressable>
  );
}

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
  // CREATE is the default: the newcomer on this stage has no account yet.
  const [authMode, setAuthMode] = useState<AuthMode>('create');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealConfirm, setRevealConfirm] = useState(false);
  const lastCode = useRef('');
  const isCreate = authMode === 'create';

  // Switching mode must not carry the other mode's message into the new form.
  const switchMode = (next: AuthMode) => {
    setAuthMode(next);
    setError(null);
  };

  const resolve = async (value: string) => {
    const normalized = normalizeInviteCode(value);
    if (!normalized || normalized.length < 8) {
      setError(
        normalized
          ? "That code looks too short — it's 8 characters."
          : 'Enter the 8-character code — we\u2019ll look it up.',
      );
      return;
    }
    lastCode.current = normalized;
    setBusy(true);
    setError(null);
    const res = await lookupInvite(normalized);
    setBusy(false);
    if (!res.found) {
      setStage('enter');
      setError('We couldn\u2019t find that code. Double-check it with the person who shared it.');
      return;
    }
    setInfo(res);
    setStage('found');
  };

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Stay on the "found" screen while accepting and on failure: it already
    // renders the inline error + a loading button. The 'accepting'/'error'
    // stages have no JSX, so transitioning to them would blank the screen.
    const res = await acceptInvite(lastCode.current);
    if (!res.ok) {
      setBusy(false);
      setError(friendlyAcceptError(res.error ?? 'Couldn\u2019t join. Try again.'));
      return;
    }
    await refresh();
    setBusy(false);
    // In-app welcome toast is wired on Home (params.toast) — push is out of
    // MVP scope (invite-flow §5). One string, both states (copy-spec §2.6).
    // Typed route literal (router.d.ts): '/(home)/(tabs)' is the collapsed
    // index under the (home) group — '/(home)' alone is not in the href union.
    router.replace({
      pathname: '/(home)/(tabs)',
      params: { toast: 'You\u2019re in. Your group\u2019s logs are live in your feed.' },
    });
  };

  // Pending auth handled here (inline single-path auth, same as Welcome):
  // if the invitee has no account yet they create one, THEN accept.
  const ensureAccountThenAccept = async () => {
    setError(null);
    // CREATE mode only, and it BLOCKS (the same rule WelcomeStep learned from
    // the 2026-09-26 owner report): a mismatch never reaches authenticate() —
    // it is rendered by the danger-coloured error line on this stage, never
    // silently discarded. A first-run typo can therefore not quietly create an
    // account nobody can sign back into.
    if (isCreate && confirmPassword !== authPassword) {
      setError(PASSWORD_MISMATCH);
      return;
    }
    if (!authEmail || !authPassword) {
      setError(
        isCreate
          ? 'Enter your email and password to create your account.'
          : 'Enter the email and password for your account.',
      );
      return;
    }
    setBusy(true);
    const { authenticate } = await import('@/lib/supabase');
    const authRes = await authenticate(authEmail, authPassword);
    if (!authRes.ok) {
      setBusy(false);
      setError(authRes.error ?? 'Something went wrong.');
      return;
    }
    // New account created without onboarding: commit the defaults so the Gate
    // sees an onboarded user and we land directly on the shared feed (area 1d)
    // instead of bouncing to the goal/week-start screens.
    const { commitOnboarding, DEFAULT_WEEKLY_GOAL, DEFAULT_WEEK_START } = await import('@/lib/settings');
    await commitOnboarding({ weeklyGoal: DEFAULT_WEEKLY_GOAL, weekStart: DEFAULT_WEEK_START });
    await refresh();
    setBusy(false);
    await accept();
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => (stage === 'enter' ? router.back() : (setStage('enter'), setError(null)))} style={styles.back} hitSlop={10}>
          <Text style={[textStyles.title.style, { color: colors.text.secondary.hex, fontSize: 22, lineHeight: 24 }]}>‹</Text>
        </Pressable>

        {stage === 'enter' && (
          <>
            <Text style={[textStyles.display.style, styles.headline]}>Join a group</Text>
            <Text style={[textStyles.body.style, styles.subhead]}>
              Enter the code they shared. You\u2019ll see each other\u2019s photo-proof logs after you join.
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
            <AppButton label="Look up code" onPress={() => void resolve(code)} disabled={normalizeInviteCode(code).length < 8} loading={busy} />
            <View style={styles.soloRow}>
              <TextButton label="Just look around — I\u2019ll join later" onPress={() => router.replace('/(home)/(tabs)')} color={colors.text.muted.hex} />
            </View>
          </>
        )}

        {stage === 'found' && info && (
          <>
            {/* Context line (copy-spec §2.2): four variants from has_group ×
                inviter_has_logs — carries the emotional hook. */}
            <Text style={[textStyles.caption.style, styles.context]}>
              {info.hasGroup
                ? `${info.inviterName} invited you to their group — ${info.inviterHasLogs ? 'they\u2019re already logging.' : 'they\u2019re waiting for you.'}`
                : `${info.inviterName} invited you to ${info.inviterHasLogs ? 'start a group' : 'work out together'} — ${info.inviterHasLogs ? 'they\u2019re already logging.' : 'they\u2019re waiting for you.'}`}
            </Text>
            {/* Headline (copy-spec §2.3 STAR Option 1): N = member_count + 1. */}
            <Text style={[textStyles.display.style, styles.headline]}>
              {info.hasGroup
                ? `Join ${info.inviterName}\u2019s group — ${info.memberCount + 1} people in it`
                : `Start a group with ${info.inviterName}`}
            </Text>
            <Text style={[textStyles.body.style, styles.subhead]}>
              Everyone in the group sees each other\u2019s photo-proof logs. Your weekly ring counts only your workouts — theirs counts only theirs.
            </Text>
            <View style={styles.privacyRow}>
              <Text style={{ fontSize: 14, color: colors.brand.primary.hex }}>✓</Text>
              <Text style={[textStyles.caption.style, styles.privacy]}>
                Photos stay sealed per person — group members see each other\u2019s, never anyone else\u2019s.
              </Text>
            </View>

            {!session ? (
              // No account yet: inline create-then-accept (same auth path as Welcome).
              <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                {/* One row stack with a real gap. This screen's inputs used to
                    run flush together (every row had margin 0); the same 8pt
                    rhythm WelcomeStep's form uses is the fix, and it is what
                    App Store frame 07 already draws. */}
                <View style={styles.authForm}>
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
                  {/* textContentType stays "password" in both modes, matching
                      WelcomeStep: switching it to "newPassword" would hand iOS's
                      strong-password AutoFill this form — a visible behaviour
                      change nobody asked for. */}
                  <View style={styles.field}>
                    <TextInput
                      value={authPassword}
                      onChangeText={setAuthPassword}
                      placeholder="Password (6+ characters)"
                      placeholderTextColor={colors.text.muted.hex}
                      secureTextEntry={!revealPassword}
                      textContentType="password"
                      style={[styles.input, styles.inputWithReveal]}
                      accessibilityLabel="Password"
                    />
                    <RevealToggle
                      revealed={revealPassword}
                      onToggle={() => setRevealPassword((v) => !v)}
                      showLabel="Show password"
                      hideLabel="Hide password"
                    />
                  </View>
                  {isCreate ? (
                    <View style={styles.field}>
                      <TextInput
                        value={confirmPassword}
                        onChangeText={setConfirmPassword}
                        placeholder="Confirm password"
                        placeholderTextColor={colors.text.muted.hex}
                        secureTextEntry={!revealConfirm}
                        autoCapitalize="none"
                        style={[styles.input, styles.inputWithReveal]}
                        accessibilityLabel="Confirm password"
                      />
                      <RevealToggle
                        revealed={revealConfirm}
                        onToggle={() => setRevealConfirm((v) => !v)}
                        showLabel="Show confirm password"
                        hideLabel="Hide confirm password"
                      />
                    </View>
                  ) : null}
                  {/* Mode switch, same muted-caption row and same two strings as
                      WelcomeStep (PR #42). Both modes share the one submit path —
                      authenticate() signs in or creates. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      isCreate ? 'Already have an account? Sign in' : 'New here? Create an account'
                    }
                    onPress={() => switchMode(isCreate ? 'sign-in' : 'create')}
                    style={styles.modeRow}
                  >
                    <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                      {isCreate ? 'Already have an account? Sign in' : 'New here? Create an account'}
                    </Text>
                  </Pressable>
                  <AppButton
                    label={
                      isCreate
                        ? info.hasGroup
                          ? 'Join & create account'
                          : 'Start a group & create account'
                        : info.hasGroup
                          ? 'Sign in & join'
                          : 'Sign in & start a group'
                    }
                    onPress={() => void ensureAccountThenAccept()}
                    disabled={!authEmail || !authPassword || busy}
                    loading={busy}
                  />
                </View>
              </KeyboardAvoidingView>
            ) : (
              <AppButton
                label={info.hasGroup ? `Join ${info.inviterName}\u2019s group` : `Start a group with ${info.inviterName}`}
                onPress={() => void accept()}
                disabled={busy}
                loading={busy}
              />
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
    borderColor: 'rgba(0,0,0,0.12)',
    paddingHorizontal: spacing.lg,
    color: colors.text.primary.hex,
    fontSize: 16,
    textAlign: 'center',
  },
  // The auth row stack: a real 8pt rhythm between rows, the same rhythm
  // WelcomeStep's form uses (this screen's rows had no margin at all).
  authForm: { gap: spacing.sm },
  // Password rows: `styles.input` stays untouched (height, radius, colour,
  // centred text); the wrapper only gives the 48pt reveal control something to
  // sit on, and `inputWithReveal` reserves its width. Unlike WelcomeStep — whose
  // input text is left-aligned, so a right pad alone cannot shift it — this
  // screen centres its text, so BOTH sides are padded and the placeholder stays
  // optically centred with the glyph sitting over the right pad.
  field: { position: 'relative', justifyContent: 'center' },
  inputWithReveal: { paddingLeft: 48, paddingRight: 48 },
  revealBtn: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeRow: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  privacy: { color: colors.text.muted.hex, maxWidth: '85%', textAlign: 'left' },
  soloRow: { alignItems: 'center', marginTop: spacing.xs },
});