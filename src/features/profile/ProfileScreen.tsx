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
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { AppButton, TextButton } from '@/components/AppButton';
import { deleteAccount } from '@/lib/accountDeletion';
import { leaveGroup } from '@/lib/invites';
import { getPetNames, setPetNameFor, setTeamName } from '@/lib/naming';
import { getMissPromise, setMissPromise, MISS_PROMISE_MAX } from '@/lib/missPromise';
import {
  getNotificationPrefs,
  setNotificationPref,
  NOTIFICATION_TYPES,
  NOTIFICATION_META,
  type NotificationPrefs,
} from '@/lib/notificationPrefs';
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
  const [groupCreatorId, setGroupCreatorId] = useState<string | null>(null);
  const [namingBusy, setNamingBusy] = useState(false);

  // Miss promise (v1.1 Build #2, S slice): an OPTIONAL personal note — "If I
  // miss, I owe you: ___". Set/edited/cleared by each member for THEMSELVES,
  // ≤80 chars, private to the pair, shown to the partner only via the
  // future recap. Never a wager/enforcement system — neutral, optional copy.
  const [missPromise, setMissPromiseValue] = useState('');
  const [missPromiseBusy, setMissPromiseBusy] = useState(false);
  // Notification preferences (v1.1 Build #3, slice 1): the four push types as
  // per-user toggles. Reads once on mount; each flip writes through the lib
  // (lazy defaults row; own-row RLS in real mode, devMock parity in dev).
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs | null>(null);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [notifBusy, setNotifBusy] = useState(false);
  // Leave group (compliance: stop receiving member UGC). Two-tap confirm: the
  // first tap flips the label to "Tap again to confirm" for 3s; a second tap
  // inside that window runs leaveGroup(). No new screens.
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNaming = async () => {
    const [ctx, petMap, miss] = await Promise.all([fetchWeeklyContext(), getPetNames(), getMissPromise()]);
    if (!ctx.ok || !ctx.context) return;
    setMembers(ctx.context.members);
    setTeamNameValue(ctx.context.teamName ?? '');
    setGroupCreatorId(ctx.context.groupCreatorId ?? null);
    setPetNames(petMap);
    setMissPromiseValue(miss ?? '');
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [ctx, petMap, miss] = await Promise.all([fetchWeeklyContext(), getPetNames(), getMissPromise()]);
      if (!mounted) return;
      if (ctx.ok && ctx.context) {
        setMembers(ctx.context.members);
        setTeamNameValue(ctx.context.teamName ?? '');
        setGroupCreatorId(ctx.context.groupCreatorId ?? null);
      }
      setPetNames(petMap);
      setMissPromiseValue(miss ?? '');
    })();
    // Notification prefs load (v1.1 Build #3): independent of pairing — the
    // toggles mirror the schema defaults even before a row exists.
    void getNotificationPrefs().then((prefs) => {
      if (!mounted) return;
      setNotifPrefs(prefs);
    });
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

  // Save (or clear, when empty) THIS user's own miss promise. Trim + ≤80
  // handled in the lib; this just flushes the field and reports truthfully.
  const saveMissPromise = async (text: string) => {
    if (missPromiseBusy) return;
    setMissPromiseBusy(true);
    setMessage(null);
    const res = await setMissPromise(text);
    if (res.ok) setMissPromiseValue(text);
    setMissPromiseBusy(false);
    setMessage(res.ok ? 'Saved. This shows only if you miss the week.' : (res.error ?? 'Could not save.'));
  };

  // Flip ONE notification toggle (v1.1 Build #3). Optimistic local flip +
  // truthful restore on write failure — the toggle never silently lies.
  const toggleNotif = async (type: keyof NotificationPrefs, enabled: boolean) => {
    if (notifBusy || !notifPrefs) return;
    setNotifBusy(true);
    setNotifError(null);
    const next = { ...notifPrefs, [type]: enabled };
    setNotifPrefs(next);
    const res = await setNotificationPref(type, enabled);
    setNotifBusy(false);
    if (!res.ok) {
      // Restore the prior truthful value + surface the failure.
      setNotifPrefs((prev) => (prev ? { ...prev, [type]: !enabled } : prev));
      setNotifError(res.error ?? 'Could not save. Try again.');
    }
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
                editable={groupCreatorId === session?.user?.id}
                placeholder="e.g. Team Us"
                placeholderTextColor={colors.text.muted.hex}
                autoCapitalize="words"
                style={[styles.input, groupCreatorId !== session?.user?.id && styles.inputDisabled]}
                accessibilityLabel="Team name"
              />
              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                {/* Team-name caption (groups-copy-spec §4) — creator vs
                    non-creator, driven by WeeklyContext.groupCreatorId. When
                    the creator is unknown (null in a group), default to the
                    read-only line — honest either way. */}
                {groupCreatorId === session?.user?.id
                  ? 'Shown in the feed header for everyone in the group.'
                  : 'Only the person who started the group can change its name.'}
              </Text>

              <AppButton label="Save" onPress={() => void saveNaming()} loading={namingBusy} style={{ marginTop: spacing.lg }} />

              {/* Miss promise (v1.1 Build #2, S slice) — optional personal
                  note shown ONLY if THIS member misses a week. Low-emphasis,
                  neutral, never shaming: it is a note to the pair, NOT a
                  wager/stake/bet/debt/enforcement system. */}
              <Text style={[textStyles.label.style, { color: colors.text.muted.hex, marginTop: spacing.xxl }]}>IF I MISS…</Text>
              <TextInput
                value={missPromise}
                onChangeText={setMissPromiseValue}
                placeholder="I owe you: ___"
                placeholderTextColor={colors.text.muted.hex}
                maxLength={MISS_PROMISE_MAX}
                autoCapitalize="sentences"
                style={styles.input}
                accessibilityLabel="Miss note — what I owe if I miss the week"
              />
              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                A private note your partner sees only if you miss the week. Optional.
              </Text>
              <View style={styles.missRow}>
                <TextButton label="Save" onPress={() => void saveMissPromise(missPromise)} color={colors.text.secondary.hex} />
                {missPromise ? (
                  <TextButton
                    label="Clear"
                    onPress={() => void saveMissPromise('')}
                    color={colors.text.muted.hex}
                  />
                ) : null}
                {missPromiseBusy && <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>…</Text>}
              </View>

              {/* Unpair — low-emphasis destructive-adjacent row at the bottom of
                  the partner card. Two-tap confirm; neutral, recoverable copy. */}
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

        {/* Notification preferences (v1.1 Build #3) — muted switches matching
            the DANGER ZONE aesthetics (quiet, no volt fills). The four push
            types are the ONLY ones that exist; copy is honest (missed-week
            stays OFF by default — the toggle IS the control). */}
        <Text style={[textStyles.label.style, { color: colors.text.muted.hex, marginTop: spacing.xxxl }]}>NOTIFICATIONS</Text>
        <View style={styles.card}>
          {notifPrefs ? (
            NOTIFICATION_TYPES.map((type) => {
              const meta = NOTIFICATION_META[type];
              return (
                <View key={type} style={styles.notifRow}>
                  <View style={styles.notifCopy}>
                    <Text style={[textStyles.captionStrong.style, { color: colors.text.primary.hex }]}>{meta.label}</Text>
                    <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>{meta.caption}</Text>
                  </View>
                  <Switch
                    value={notifPrefs[type]}
                    onValueChange={(v) => void toggleNotif(type, v)}
                    disabled={notifBusy}
                    trackColor={{ false: colors.background.overlay.hex, true: colors.status.success.hex }}
                    thumbColor={notifPrefs[type] ? colors.text.onVolt.hex : colors.text.muted.hex}
                    accessibilityLabel={`${meta.label} notifications`}
                  />
                </View>
              );
            })
          ) : (
            <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>Loading…</Text>
          )}
          {notifError && (
            <Text style={[textStyles.caption.style, { color: colors.text.danger.hex }]}>{notifError}</Text>
          )}
          <Text style={[textStyles.caption.style, { color: colors.text.muted.hex, marginTop: spacing.xs }]}>
            Off until you turn them on. You can change these anytime.
          </Text>
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
  missRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.sm },
  notifRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.lg, paddingVertical: spacing.xs },
  notifCopy: { flex: 1, gap: 2 },
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
  // Read-only team-name field for non-creators (groups-copy-spec §4): the
  // muted token is the design-system "disabled" text color; everything else
  // (fill, border, radius) stays identical to the editable field.
  inputDisabled: {
    color: colors.text.muted.hex,
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