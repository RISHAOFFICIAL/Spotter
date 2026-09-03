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
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { AppButton } from '@/components/AppButton';
import { deleteAccount } from '@/lib/accountDeletion';
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
          <Text style={[textStyles.bodyStrong.style, { color: colors.text.primary.hex }]}>{name || 'You'}</Text>
          <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex }]}>{email}</Text>
        </View>

        {/* Danger zone — discoverable, honest, not hidden. */}
        <Text style={[textStyles.label.style, { color: colors.text.muted.hex, marginTop: spacing.xxxl }]}>ACCOUNT</Text>
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