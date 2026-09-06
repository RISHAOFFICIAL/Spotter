/**
 * ProfileScreen — minimal real Profile surface (compliance brief #2 §4).
 *
 * The bottom-bar Profile slot is a dimmed placeholder in MVP; this route is
 * the honest, minimal surface behind it: account info + the in-app
 * "Delete account" flow (App Store 5.1.1(v)). Delete is NEVER a single tap:
 * it requires an explicit confirm dialog, then the real deletion runs against
 * the dev mock / forward-compatible real-mode stub (accountDeletion.ts), then
 * the session is cleared and the Gate routes back to onboarding.
 *
 * The success message ("Account deleted. Sorry to see you go.") shows only
 * after the deletion actually completed — no fake delete.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { AppButton, TextButton } from '@/components/AppButton';
import { deleteAccount } from '@/lib/accountDeletion';
import { unpair } from '@/lib/invites';
import { getPetName, setPetName, setTeamName } from '@/lib/naming';
import { fetchWeeklyContext } from '@/lib/workoutStore';
import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

export function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { session, profile, signOut } = useAuth();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const email = session?.user.email ?? profile?.email ?? '';
  const name = profile?.name ?? email.split('@')[0] ?? '';

  // Naming feature (lead brief): optional local pet name (what I call MY
  // partner, shown to me only) + optional shared pair team name. Both fall
  // back to current behavior when empty.
  const [partnerFirstName, setPartnerFirstName] = useState<string | null>(null);
  const [petName, setPetNameValue] = useState('');
  const [teamNameValue, setTeamNameValue] = useState('');
  const [namingBusy, setNamingBusy] = useState(false);

  // Unpair (compliance: stop receiving partner UGC). Two-tap confirm: the
  // first tap flips the label to "Tap again to confirm" for 3s; a second tap
  // inside that window runs unpair(). No new screens.
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [unpairBusy, setUnpairBusy] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNaming = async () => {
    const [ctx, pet] = await Promise.all([fetchWeeklyContext(), getPetName()]);
    setPartnerFirstName(ctx.ok && ctx.context?.hasPartner ? (ctx.context.partner?.firstName ?? null) : null);
    setTeamNameValue(ctx.ok ? (ctx.context?.teamName ?? '') : '');
    setPetNameValue(pet ?? '');
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [ctx, pet] = await Promise.all([fetchWeeklyContext(), getPetName()]);
      if (!mounted) return;
      if (ctx.ok && ctx.context?.hasPartner) {
        setPartnerFirstName(ctx.context.partner?.firstName ?? null);
        setTeamNameValue(ctx.context.teamName ?? '');
      }
      setPetNameValue(pet ?? '');
    })();
    return () => {
      mounted = false;
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const saveNaming = async () => {
    if (namingBusy) return;
    setNamingBusy(true);
    setMessage(null);
    await setPetName(petName);
    const teamRes = await setTeamName(teamNameValue);
    setNamingBusy(false);
    setMessage(teamRes.ok ? 'Saved.' : (teamRes.error ?? 'Saved.'));
  };

  // Two-tap confirm: first tap arms the confirm for 3s, second tap executes.
  const handleUnpairTap = () => {
    if (unpairBusy) return;
    if (!confirmUnpair) {
      setConfirmUnpair(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmUnpair(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmUnpair(false);
    void runUnpair();
  };

  const runUnpair = async () => {
    if (unpairBusy) return;
    setUnpairBusy(true);
    setMessage(null);
    const res = await unpair();
    setUnpairBusy(false);
    if (res.ok) {
      setMessage('Unpaired. You can pair again anytime with a new code.');
      // Return to the solo state in place: reload partner/team fields so the
      // invite banner path + solo copy take over on the next Home fetch.
      await loadNaming();
    } else {
      setMessage(res.error ?? "Couldn't unpair. Try again.");
    }
  };

  const runDelete = async () => {
    if (busy || done) return;
    setBusy(true);
    const res = await deleteAccount();
    setBusy(false);
    setConfirmOpen(false);
    if (res.ok) {
      setDone(true);
      setMessage(res.message);
      // Real deletion completed — clear the session; the root Gate then
      // re-renders to the no-session branch (onboarding/welcome) automatically.
      await signOut();
      router.replace('/(auth)/welcome');
    } else {
      // Honest failure — surfaced exactly as the lib reported it.
      setMessage(res.message);
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.md, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          hitSlop={10}
          style={styles.backBtn}
        >
          <Text style={[textStyles.title.style, { color: colors.text.secondary.hex, fontSize: 22, lineHeight: 24 }]}>‹</Text>
        </Pressable>
        <Text style={[textStyles.title.style, styles.headerTitle]}>Profile</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.content}>
        <Text style={[textStyles.label.style, { color: colors.text.muted.hex }]}>ACCOUNT</Text>
        <View style={styles.card}>
          <Text style={[textStyles.bodyStrong.style, { color: colors.text.primary.hex }]} numberOfLines={1} ellipsizeMode="tail">
            {name || 'You'}
          </Text>
          <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex }]} numberOfLines={1} ellipsizeMode="tail">
            {email}
          </Text>
        </View>

        {/* Naming (optional) — pet name is local-only; team name is shared.
            Both fields render only when paired (a team name lives on the pair
            group, and a pet name needs a partner to rename). */}
        <Text style={[textStyles.label.style, { color: colors.text.muted.hex, marginTop: spacing.xxxl }]}>NAMES (OPTIONAL)</Text>
        <View style={styles.card}>
          {partnerFirstName ? (
            <>
              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                Nickname for {partnerFirstName} (optional)
              </Text>
              <TextInput
                value={petName}
                onChangeText={setPetNameValue}
                placeholder="e.g. Coach"
                placeholderTextColor={colors.text.muted.hex}
                autoCapitalize="words"
                style={styles.input}
                accessibilityLabel={`Nickname for ${partnerFirstName}`}
              />
              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                Just for you — only you see this name.
              </Text>

              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex, marginTop: spacing.lg }]}>
                Team name (optional)
              </Text>
              <TextInput
                value={teamNameValue}
                onChangeText={setTeamNameValue}
                placeholder="e.g. Team Us"
                placeholderTextColor={colors.text.muted.hex}
                autoCapitalize="words"
                style={styles.input}
                accessibilityLabel="Team name"
              />
              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                Shown in your feed header for you and your partner.
              </Text>

              <AppButton label="Save" onPress={() => void saveNaming()} loading={namingBusy} style={{ marginTop: spacing.lg }} />

              {/* Unpair — low-emphasis destructive-adjacent row at the bottom of
                  the partner card. Two-tap confirm; neutral, recoverable copy. */}
              <View style={styles.unpairRow}>
                <TextButton
                  label={confirmUnpair ? 'Tap again to confirm' : `Unpair from ${partnerFirstName ?? 'your partner'}`}
                  onPress={handleUnpairTap}
                  color={colors.text.muted.hex}
                />
                {unpairBusy && <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>…</Text>}
              </View>
              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                Stops sharing your photos with each other. You can pair again anytime with a new code.
              </Text>
            </>
          ) : (
            <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
              Pair up with a partner to add a nickname or team name.
            </Text>
          )}
        </View>

        {/* Danger zone — discoverable, honest, not hidden. */}
        <Text style={[textStyles.label.style, { color: colors.text.muted.hex, marginTop: spacing.xxxl }]}>DANGER ZONE</Text>
        <View style={styles.card}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete account"
            onPress={() => {
              setMessage(null);
              setConfirmOpen(true);
            }}
            style={({ pressed }) => [styles.dangerRow, pressed && { opacity: 0.8 }]}
          >
            <Ionicons name="trash-outline" size={20} color={colors.text.danger.hex} />
            <Text style={[textStyles.bodyStrong.style, { color: colors.text.danger.hex }]}>Delete account</Text>
          </Pressable>
          <Text style={[textStyles.caption.style, { color: colors.text.muted.hex, marginTop: spacing.xs }]}>
            Permanently deletes your account, photo logs and photos. Your partner keeps theirs.
          </Text>
        </View>

        {message && (
          <Text style={[textStyles.caption.style, { color: done ? colors.status.success.hex : colors.text.danger.hex, textAlign: 'center', marginTop: spacing.lg }]}>
            {message}
          </Text>
        )}
      </View>

      {/* Explicit confirm dialog — never a single tap (5.1.1(v)). */}
      {confirmOpen && (
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={[textStyles.headline.style, { color: colors.text.primary.hex, textAlign: 'center' }]}>
              Delete your account?
            </Text>
            <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center', marginTop: spacing.sm }]}>
              This permanently deletes your account, your photo logs and the photos you uploaded. This can't be undone.
            </Text>
            <AppButton
              label="Delete my account"
              onPress={() => void runDelete()}
              loading={busy}
              style={{ marginTop: spacing.lg }}
            />
            <AppButton
              label="Cancel"
              type="ghost"
              onPress={() => setConfirmOpen(false)}
              disabled={busy}
              style={{ marginTop: spacing.sm }}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background.base.hex, paddingHorizontal: spacing.screen.paddingX },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44, paddingHorizontal: spacing.xs },
  backBtn: { width: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.text.primary.hex },
  content: { flex: 1, paddingTop: spacing.xl },
  card: {
    backgroundColor: colors.background.surface.hex,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: spacing.lg,
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  dangerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  unpairRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  input: {
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.background.overlay.hex,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingHorizontal: spacing.lg,
    color: colors.text.primary.hex,
    fontSize: 16,
    marginTop: spacing.sm,
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(10,12,8,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modal: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.background.surface.hex,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    padding: spacing.xl,
  },
});