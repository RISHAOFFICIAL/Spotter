/**
 * NotificationsSheet — the two-step contextual explainer (v1.1 Build #3,
 * slice 1). Shown ONLY after the user has paired AND completed their first
 * return visit to Home (HomeScreen owns the trigger). NEVER at first open.
 *
 * The sheet says exactly what notifications do TODAY — the two OWN-DEVICE
 * types, and nothing else: the invite still-waiting nudge and the missed-week
 * alert (which stays off by default; it is a Profile toggle, not promised
 * here). It makes NO claim that a partner's workout or an accepted invite
 * reaches the phone: those two types are cross-user, and resolveRealTarget
 * (pushDispatch.ts) returns a null token for any recipient other than the
 * current user — own-row RLS on push_devices — so they suppress as
 * 'no_device' and never send in a real build. Verified 2026-09-23; evidence in
 * /home/team/shared/push-reachability-verified-2026-09-23.md. The sheet's
 * copy is gated by scripts/smoke/push-copy-guard.cjs — if push reachability
 * changes, the claim may be widened deliberately, in a reviewed diff.
 *
 *   "Enable notifications" → markNotificationExplained() then the REAL OS
 *     prompt (requestNotificationPermission). Dev mode grants the mock.
 *   "Not now" → dismissed; the local machine permits at most ONE re-ask much
 *     later (14-day cooldown, see notifications.ts).
 *
 * Sheet chrome mirrors InviteSheet + MissSetupSheet (Modal + scrim tap-to-
 * dismiss + drag handle + bottom sheet) so this feels like the same flow.
 */
import React from 'react';
import { InteractionManager, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { markNotificationExplained, dismissNotificationAsk, requestNotificationPermission, refreshPushRegistrationIfGranted } from '@/lib/notifications';

export function NotificationsSheet({
  visible,
  partnerFirstName,
  onDone,
}: {
  visible: boolean;
  partnerFirstName: string | null;
  /** true = user enabled (or dev-granted); false = Not now / dismissed. */
  onDone: (enabled: boolean) => void;
}) {
  const insets = useSafeAreaInsets();

  const close = (enabled: boolean) => {
    onDone(enabled);
  };

  const enable = async () => {
    // Advance the machine BEFORE the OS prompt so a mid-flow close still
    // counts as explained (never nag on the very next screen).
    await markNotificationExplained();
    const granted = await requestNotificationPermission();
    // Refresh registration (dev: mock token upsert; real: token after grant).
    await refreshPushRegistrationIfGranted();
    // SAME DEFECT CLASS as the build-29 freeze in InviteSheet.share: this runs
    // while iOS is still tearing its OS permission dialog down, and dismissing
    // this transparent Modal on that tick risks leaving the native presentation
    // mounted as an invisible full-screen layer that swallows every touch (no
    // JS error, no diagnostics row). No device has hit it here yet — but the
    // pair path is the same shape, so it is deferred the same way rather than
    // left as a second freeze waiting for a user.
    //
    // Simpler than InviteSheet on purpose: a plain `fired` latch, no hooks. (a)
    // This sheet is a singleton rendered by HomeScreen and cannot be re-opened
    // inside the ≤800 ms window — `markNotificationExplained` plus the 14-day
    // re-ask cooldown gate it — so there is no "straggler dismisses the next
    // opening" race to defend against, which is the only reason InviteSheet
    // needs generation refs. (b) HomeScreen's onDone ignores the boolean and
    // only hides the sheet, so a late or twice-run close is idempotent. (c)
    // `scripts/smoke/push-copy-guard.cjs` renders THIS component by calling it
    // directly, which cannot run hooks — keeping the deferral hook-free keeps
    // that gate honest instead of forcing it to grow a React dispatcher shim.
    // Fallback behaviour = DISMISS: the user already answered the OS prompt, and
    // ✕ / "Not now" / the scrim stay tappable throughout.
    let fired = false;
    const closeOnce = () => {
      if (fired) return;
      fired = true;
      close(granted === 'granted');
    };
    InteractionManager.runAfterInteractions(closeOnce);
    setTimeout(closeOnce, CLOSE_FALLBACK_MS);
  };

  const notNow = async () => {
    await dismissNotificationAsk();
    close(false);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => void notNow()}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.scrim} onPress={() => void notNow()} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <View style={styles.dragHandle} />
        <Pressable accessibilityRole="button" accessibilityLabel="Close notifications explainer" onPress={() => void notNow()} style={styles.close} hitSlop={10}>
          <Ionicons name="close" size={22} color={colors.text.secondary.hex} />
        </Pressable>
        <Text style={[textStyles.headline.style, styles.headline]}>
          Pair accountability, on your phone
        </Text>
        <Text style={[textStyles.caption.style, styles.body]}>
          A nudge if an invite you sent is still waiting, and a missed-week alert you can switch on — that’s everything we send today. {partnerFirstName ?? 'Your partner'}’s workouts show up in your feed, and you control every type in Profile later.
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Enable notifications" onPress={() => void enable()} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.9 }]}>
          <Text style={[textStyles.bodyStrong.style, { color: colors.text.onVolt.hex }]}>Enable notifications</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Not now" onPress={() => void notNow()} style={styles.ghost} hitSlop={8}>
          <Text style={[textStyles.captionStrong.style, { color: colors.text.muted.hex }]}>Not now</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(20,24,12,0.55)' },
  sheet: {
    backgroundColor: colors.background.surface.hex,
    borderTopLeftRadius: radius.sheetTop,
    borderTopRightRadius: radius.sheetTop,
    padding: spacing.xl,
    gap: spacing.lg,
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.12)',
    alignSelf: 'center',
  },
  close: { position: 'absolute', top: spacing.md, right: spacing.md, width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headline: { color: colors.text.primary.hex, marginTop: spacing.sm },
  body: { color: colors.text.secondary.hex, paddingRight: spacing.xl },
  primary: {
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.brand.primary.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { alignItems: 'center', paddingVertical: spacing.xs },
});

/**
 * Upper bound on how long this sheet may stay open after the OS permission
 * dialog has resolved (see `enable`). Safety net, not the normal path: the
 * interaction queue drains within a frame or two, and 800 ms is ~2× the iOS
 * dismissal animation for the dialog this waits on.
 */
const CLOSE_FALLBACK_MS = 800;