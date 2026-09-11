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
import { leaveGroup } from '@/lib/invites';
import { getPetNames, setPetNameFor, setTeamName } from '@/lib/naming';
import { fetchWeeklyContext } from '@/lib/workoutStore';
import type { GroupMemberInfo } from '@/lib/workouts';
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

  // Group section (groups-copy-spec §4): per-member local pet names (what I
  // call each co-member — shown to me only) + the optional shared group team
  // name. All fall back to current behavior when unset.
  const [members, setMembers] = useState<GroupMemberInfo[]>([]);
  const [petNames, setPetNames] = useState<Record<string, string>>({});
  const [teamNameValue, setTeamNameValue] = useState('');
  const [namingBusy, setNamingBusy] = useState(false);

  // Leave group (compliance: stop receiving member UGC). Two-tap confirm: the
  // first tap flips the label to "Tap again to confirm" for 3s; a second tap
  // inside that window runs leaveGroup(). No new screens.
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNaming = async () => {
    const [ctx, petMap] = await Promise.all([fetchWeeklyContext(), getPetNames()]);
    if (!ctx.ok || !ctx.context) return;
    setMembers(ctx.context.members);
    setTeamNameValue(ctx.context.teamName ?? '');
    setPetNames(petMap);
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [ctx, petMap] = await Promise.all([fetchWeeklyContext(), getPetNames()]);
      if (!mounted) return;
      if (ctx.ok && ctx.context) {
        setMembers(ctx.context.members);
        setTeamNameValue(ctx.context.teamName ?? '');
      }
      setPetNames(petMap);
    })();
    return () => {
      mounted = false;
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const handlePetNameChange = (memberId: string, value: string) => {
    setPetNames((prev) => ({ ...prev, [memberId]: value }));
  };

  const saveNaming = async () => {
    if (namingBusy) return;
    setNamingBusy(true);
    setMessage(null);
    for (const m of members) {
      await setPetNameFor(m.id, petNames[m.id] ?? '');
    }
    const teamRes = await setTeamName(teamNameValue);
    setNamingBusy(false);
    setMessage(teamRes.ok ? 'Saved.' : (teamRes.error ?? 'Saved.'));
  };

  // Two-tap confirm: first tap arms the confirm for 3s, second tap executes.
  const handleLeaveTap = () => {
    if (leaveBusy) return;
    if (!confirmLeave) {
      setConfirmLeave(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmLeave(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmLeave(false);
    void runLeave();
  };

  const runLeave = async () => {
    if (leaveBusy) return;
    setLeaveBusy(true);
    setMessage(null);
    const res = await leaveGroup();
    setLeaveBusy(false);
    if (res.ok) {
      setMessage('You left the group. You can join or start another anytime.');
      // Return to the solo state in place: reload member/team fields so the
      // invite banner path + solo copy take over on the next Home fetch.
      await loadNaming();
    } else {
      setMessage(res.error ?? 'Couldn\u2019t leave the group. Try again.');
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

        {/* Group (groups-copy-spec §4) — section header "GROUP" matches "ACCOUNT"; the
            card lists one pet-name row per co-member + the shared team name.
            Member rows render only when in a group (members.length > 0). */}
        <Text style={[textStyles.label.style, { color: colors.text.muted.hex, marginTop: spacing.xxxl }]}>GROUP</Text>
        <View style={styles.card}>
          {members.length > 0 ? (
            <>
              {members.map((m) => (
                <View key={m.id}>
                  <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                    Nickname for {m.firstName} (optional)
                  </Text>
                  <TextInput
                    value={petNames[m.id] ?? ''}
                    onChangeText={(v) => handlePetNameChange(m.id, v)}
                    placeholder="e.g. Coach"
                    placeholderTextColor={colors.text.muted.hex}
                    autoCapitalize="words"
                    style={styles.input}
                    accessibilityLabel={`Nickname for ${m.firstName}`}
                  />
                  <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                    Just for you — only you see this name.
                  </Text>
                </View>
              ))}

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
                Shown in the feed header for everyone in the group.
              </Text>

              <AppButton label="Save" onPress={() => void saveNaming()} loading={namingBusy} style={{ marginTop: spacing.lg }} />

              {/* Leave group — low-emphasis destructive-adjacent row at the
                  bottom of the group card. Two-tap confirm; neutral, recoverable
                  copy (groups-copy-spec §4). */}
              <View style={styles.unpairRow}>
                <TextButton
                  label={confirmLeave ? 'Tap again to confirm' : 'Leave group'}
                  onPress={handleLeaveTap}
                  color={colors.text.muted.hex}
                />
                {leaveBusy && <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>…</Text>}
              </View>
              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                Stops sharing photos with this group. You can join or start another anytime.
              </Text>
              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                Your group can have up to 3 people — you and 2 more.
              </Text>
            </>
          ) : (
            <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
              Start a group to add nicknames or a team name.
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
            Permanently deletes your account, photo logs and photos. Your group keeps theirs.
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