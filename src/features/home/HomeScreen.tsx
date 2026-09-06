/**
 * Home — the heart of the core loop (home-screen.md). Everything renders from
 * ONE weekly-context query (fetchWeeklyContext, §8): weeklyGoal + weekStartDay
 * + logsThisWeek → ring numeral, camera count badge and feed all derive from
 * the same data. No second fetch on render.
 *
 * Bottom bar pinned; header + ring pinned at top; feed scrolls beneath.
 * Camera button (center slot) is exactly one tap from home → LogSheet
 * (capture = A-1, "Log it" = A-2) → optimistic prepend + ring re-fill.
 *
 * Rings are PERSONAL (design README judgment call #1 — count own logs only).
 * Partner presence is slice C; the "just you" label is the placeholder.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { LogSheet } from '@/features/logging/LogSheet';
import { BottomBar } from '@/features/home/BottomBar';
import { WeeklyRing } from '@/features/home/WeeklyRing';
import { FeedCard } from '@/features/home/FeedCard';
import { EmptyState, InviteBanner, type EmptyCase } from '@/features/home/EmptyState';
import { InviteSheet } from '@/features/invites/InviteSheet';
import { MissSetupSheet } from '@/features/invites/MissSetupSheet';
import { NotificationsSheet } from '@/features/invites/NotificationsSheet';
import { hasSeenMissPrompt } from '@/lib/missPromise';
import { shouldAskNotificationPermission, refreshPushRegistrationIfGranted, subscribePushDispatchForeground } from '@/lib/notifications';
import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { fetchWeeklyContext } from '@/lib/workoutStore';
import type { WeeklyContext, WorkoutLog } from '@/lib/workouts';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { isDevMode, session } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ toast?: string }>();

  const [ctx, setCtx] = useState<WeeklyContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [now, setNow] = useState(new Date());
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [welcomeToast, setWelcomeToast] = useState<string | null>(null);
  const mounted = useRef(true);
  // V1.1 Build #2 (M slice): pairing-time setup sheet. Shows ONCE per user,
  // right after pairing completes for the CURRENT user — both paths: the
  // invitee who just accepted (lands here with hasPartner flipping true) and
  // the inviter whose invite just got accepted (their Home flips hasPartner on
  // the next fetch). Detection reuses the existing pairing-success states:
  // the welcome toast (acceptee path) and the invite-banner unmount
  // (hasPartner flip covers the inviter path). The persisted once-flag keeps
  // it to a single showing; Skip never re-asks.
  const [missSheetOpen, setMissSheetOpen] = useState(false);
  const wasPaired = useRef(false);
  // V1.1 Build #3 (slice 1): notification explainer — the natural moment is
  // AFTER pairing AND the first return visit to Home (documented in
  // notifications.ts). It must never appear at first open (or before the user
  // has a pair to be notified about). `foregroundLoadDone` (a REF — never a
  // state, so load's identity stays stable) flips once a non-background load
  // has resolved; the ask effect below then fires once paired.
  const [notifSheetOpen, setNotifSheetOpen] = useState(false);
  const notifAsked = useRef(false);
  const foregroundLoadDone = useRef(false);

  // In-app welcome toast after a fresh accept (invite-flow.md §5: one-time,
  // above the bottom bar — push notifications are out of MVP scope).
  useEffect(() => {
    const toast = params.toast;
    if (toast && !welcomeToast) setWelcomeToast(toast);
  }, [params.toast, welcomeToast]);

  useEffect(() => {
    if (!welcomeToast) return;
    const t = setTimeout(() => setWelcomeToast(null), 4000);
    return () => clearTimeout(t);
  }, [welcomeToast]);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    const res = await fetchWeeklyContext();
    if (!mounted.current) return;
    setLoading(false);
    setRefreshing(false);
    if (!res.ok || !res.context) {
      setError(res.error ?? "Can't load your week.");
      return;
    }
    setCtx(res.context);
    setError(null);
    // Pairing-time setup sheet (M slice): when the context flips from solo to
    // paired for the first time this session AND the user never saw the sheet,
    // offer the optional miss note once. Covers both pairing paths — the
    // acceptee (arrives with the welcome toast) and the inviter (sees the flip
    // on their next fetch after the partner accepts). Background refreshes
    // (post-log reload) also flow through here, which is exactly the inviter
    // path: their first paired fetch after acceptance triggers the sheet.
    if (res.context.hasPartner && !wasPaired.current) {
      wasPaired.current = true;
      void hasSeenMissPrompt().then((seen) => {
        if (!seen && mounted.current) setMissSheetOpen(true);
      });
    } else if (res.context.hasPartner) {
      wasPaired.current = true;
    } else {
      wasPaired.current = false;
    }
    // A foreground (non-background) load has completed — the "return visit"
    // marker for the notification ask (ref, not state: keeps load stable).
    if (!background) foregroundLoadDone.current = true;
  }, []);

  // V1.1 Build #3 (slice 1) — natural ask moment, in its OWN effect so `load`
  // stays dependency-free: after a foreground load resolved AND the user is
  // paired AND the pairing-time miss sheet (Build #2) is gone (or was never
  // shown), check the permission machine once per mount. shouldAsk handles
  // unseen (first ask) and the single re-ask after the long cooldown.
  useEffect(() => {
    if (!foregroundLoadDone.current || !ctx?.hasPartner) return;
    if (missSheetOpen) return;
    if (notifAsked.current) return;
    notifAsked.current = true;
    void shouldAskNotificationPermission().then((ask) => {
      if (ask && mounted.current) setNotifSheetOpen(true);
    });
  }, [ctx, missSheetOpen]);

  useEffect(() => {
    mounted.current = true;
    load();
    // V1.1 Build #3 (slice 1): when the OS permission was already granted on a
    // previous launch, re-read + re-register the push token so a rotated/
    // expired token refreshes on every app start. Best-effort + idempotent.
    void refreshPushRegistrationIfGranted();
    // V1.1 Build #3 (slice 2): the client-initiated delivery engine — on this
    // mount AND every foreground transition, evaluate pending_invite +
    // missed_week (self-target kinds). Fire-and-forget; dedupe keeps it safe.
    subscribePushDispatchForeground();
    // keep relative timestamps fresh (cheap; not a second fetch — just re-render)
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [load]);

  const handleLogged = useCallback((log: WorkoutLog) => {
    // Optimistic: prepend the card immediately; ring + badge need the weekly
    // context recomputed so the new log is counted (still one query).
    setCtx((prev) => {
      if (!prev) return prev;
      return { ...prev, logs: [log, ...prev.logs] };
    });
    void load(true);
  }, [load]);

  const weekCount = ctx?.logs.filter((l) => l.userId === session?.user.id).length ?? 0;
  const hasPartner = ctx?.hasPartner ?? false;
  // Naming feature: this user's preferred partner name (local pet name, else
  // the partner's real first name) + the optional shared team name.
  const partnerFirstName = ctx?.partner?.firstName;
  const partnerDisplayName = ctx?.partnerDisplayName ?? partnerFirstName;
  const teamName = ctx?.teamName ?? null;
  const emptyVariant: EmptyCase = hasPartner ? 'noLogsPartner' : 'noLogsNoPartner';

  // Ring center label (batch A §6): paired shows the "just you & {name}"
  // pattern; solo keeps the plain canonical label. Goal-reached (and still
  // winnable) flips the center label to "WEEK COMPLETE" in the ring itself.
  const ringLabel =
    hasPartner && partnerDisplayName
      ? `DAYS THIS WEEK — just you & ${partnerDisplayName}`
      : undefined;
  const weekEndedUnmet = ctx?.weekEndedUnmet ?? false;
  const weekComplete = !!ctx && !weekEndedUnmet && weekCount >= ctx.weeklyGoal;

  // V1.1 Build #2 (S slice): own-miss line — a muted whisper under the ring,
  // shown ONLY when THIS user missed the PREVIOUS week AND set a miss promise.
  const ownMissLine = ctx?.missLine?.kind === 'ownMiss' ? ctx.missLine.promise : null;

  // V1.1 Build #2 (M slice): partner MissCard — one muted card at the top of
  // the feed, shown ONLY when the partner missed THEIR previous week AND set
  // a miss promise. Neutral, never shaming; no streak/guilt language.
  const partnerMissCard = ctx?.partnerMissCard?.kind === 'partnerMiss' ? ctx.partnerMissCard.promise : null;

  // Status line under the ring (home-screen.md §2; rings are PERSONAL).
  // Compliance brief #2 (spec §3): the paired branches use "your ring" wording;
  // branch on hasPartner && partnerFirstName for the 0-logs and partial cases
  // before the generic branches. Goal-met and week-over-unmet stay generic.
  const paired = hasPartner && !!partnerFirstName;
  const statusLine = (() => {
    if (ctx && ctx.weekEndedUnmet) {
      return { text: `${ctx.weeklyGoal} missed. The ring's honest — next week.`, color: colors.text.danger.hex, strong: true };
    }
    if (weekCount === 0) {
      if (paired) {
        return { text: ctx ? `0 of ${ctx.weeklyGoal}. Your ring — one tap when you're done.` : '', color: colors.text.secondary.hex, strong: false };
      }
      return { text: ctx ? `0 of ${ctx.weeklyGoal} this week. One tap when you're done.` : '', color: colors.text.secondary.hex, strong: false };
    }
    if (ctx && weekCount >= ctx.weeklyGoal) {
      return { text: `${ctx.weeklyGoal} of ${ctx.weeklyGoal} — week complete. Solid.`, color: colors.status.success.hex, strong: true };
    }
    if (paired) {
      return {
        text: ctx ? `${weekCount} of ${ctx.weeklyGoal} — your ring, ${partnerDisplayName ?? partnerFirstName} fills theirs.` : '',
        color: colors.text.secondary.hex,
        strong: false,
      };
    }
    return {
      text: ctx ? `${weekCount} of ${ctx.weeklyGoal} — keep it going.` : '',
      color: colors.text.secondary.hex,
      strong: false,
    };
  })();

  return (
    <View style={[styles.screen, { paddingBottom: 0 }]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + spacing.sm }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(false); }} tintColor={colors.text.muted.hex} />
        }
      >
        {/* Header row */}
        <View style={styles.headerRow}>
          <Text style={[textStyles.title.style, styles.wordmark]}>SPOTTER</Text>
          <View style={styles.weekStartPill}>
            <Text style={[textStyles.label.style, { color: colors.text.muted.hex }]}>
              WK START: {ctx?.weekStartDay ?? 'MON'}
            </Text>
            <Ionicons name="chevron-down" size={14} color={colors.text.muted.hex} />
          </View>
        </View>

        {/* Ring block */}
        <View style={styles.ringBlock}>
          {loading && !ctx ? (
            <View style={styles.ringLoading}>
              <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>Loading…</Text>
            </View>
          ) : (
            <>
              <WeeklyRing
                count={weekCount}
                goal={ctx?.weeklyGoal ?? 3}
                weekEndedUnmet={ctx?.weekEndedUnmet ?? false}
                label={ringLabel}
                weekComplete={weekComplete}
              />
              <Text style={[textStyles.caption.style, statusLine.strong ? { color: statusLine.color, fontWeight: '600' } : { color: statusLine.color }, { textAlign: 'center', marginTop: spacing.sm }]}>
                {statusLine.text}
              </Text>
              {/* Own-miss whisper (v1.1 Build #2, S slice): only when last week
                  was missed AND a promise exists. Neutral, never shaming. */}
              {ownMissLine && (
                <View style={styles.missLine}>
                  <Text style={[textStyles.caption.style, { color: colors.text.muted.hex, textAlign: 'center' }]}>
                    You said: “{ownMissLine}”
                  </Text>
                  <Text style={[textStyles.caption.style, { color: colors.text.muted.hex, textAlign: 'center' }]}>
                    Still time to make this week count.
                  </Text>
                </View>
              )}
            </>
          )}
        </View>

        {error && (
          <Text style={[textStyles.caption.style, { color: colors.text.danger.hex, textAlign: 'center', marginTop: spacing.sm }]}>
            {error}
          </Text>
        )}

        {/* Partner presence (slice C): banner while solo; join-code affordance; disappears when paired. */}
        {!hasPartner && !bannerDismissed && (
          <InviteBanner
            onInvite={() => setInviteOpen(true)}
            onDismiss={() => setBannerDismissed(true)}
          />
        )}
        {!hasPartner && bannerDismissed && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Join with a code"
            onPress={() => router.push('/(accept)')}
            style={styles.joinCode}
            hitSlop={8}
          >
            <Text style={[textStyles.captionStrong.style, { color: colors.text.muted.hex }]}>
              Have a code from your partner? Enter it here
            </Text>
          </Pressable>
        )}

        {/* Feed */}
        {ctx && ctx.logs.length === 0 && (
          <EmptyState variant={emptyVariant} partnerName={partnerDisplayName ?? partnerFirstName} />
        )}
        {ctx && ctx.logs.length > 0 && (
          <>
            <View style={styles.feedHeaderRow}>
              <Text style={[textStyles.label.style, styles.feedHeader]}>RECENT</Text>
              {hasPartner && partnerFirstName ? (
                <Text
                  style={[textStyles.label.style, { color: colors.text.muted.hex }, styles.feedHeaderName]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {teamName ? teamName : `Paired with ${partnerDisplayName ?? partnerFirstName}`}
                </Text>
              ) : null}
            </View>
            <View style={styles.feed}>
              {/* Partner MissCard (M slice): passive, muted, top of feed. Both
                  conditions (partner missed + promise exists) are already
                  checked in the context — render nothing when null. */}
              {partnerMissCard && partnerFirstName && (
                <View style={styles.missCard} accessibilityRole="text" accessibilityLabel={`${partnerFirstName} missed last week note`}>
                  <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
                    {partnerFirstName} missed last week. Their note:
                  </Text>
                  <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex }]}>
                    “{partnerMissCard}”
                  </Text>
                </View>
              )}
              {ctx.logs.map((log) => (
                <FeedCard key={log.id} log={log} now={now} />
              ))}
              {hasPartner && partnerFirstName && ctx.logs.every((l) => l.userId === session?.user.id) && (
                <EmptyState variant="partnerNoLogs" partnerName={partnerDisplayName ?? partnerFirstName} />
              )}
            </View>
          </>
        )}

        {isDevMode && (
          <Text style={[textStyles.label.style, { color: colors.text.muted.hex, textAlign: 'center', marginTop: spacing.xxxl }]}>
            DEV DEMO — LOCAL MOCK
          </Text>
        )}
      </ScrollView>

      {/* Bottom bar — pinned; camera is the fixed primary action. Home is already the active screen, so the Home slot is a no-op. */}
      <BottomBar onHome={() => {}} onCamera={() => setLogOpen(true)} weekCount={weekCount} />

      <LogSheet visible={logOpen} onClose={() => setLogOpen(false)} onLogged={handleLogged} partnerName={partnerDisplayName ?? partnerFirstName} />
      <InviteSheet visible={inviteOpen} onClose={() => setInviteOpen(false)} />
      <MissSetupSheet
        visible={missSheetOpen}
        partnerFirstName={partnerFirstName ?? null}
        onDone={() => {
          setMissSheetOpen(false);
          // A saved note changes the own-miss surface — refresh quietly so a
          // later miss renders it without a manual pull.
          void load(true);
        }}
      />
      <NotificationsSheet
        visible={notifSheetOpen}
        partnerFirstName={partnerFirstName ?? null}
        onDone={() => {
          setNotifSheetOpen(false);
        }}
      />

      {/* In-app welcome toast after accepting (one-time; push is out of MVP scope). */}
      {welcomeToast && (
        <View style={[styles.toast, { bottom: 92 + Math.max(insets.bottom, 12) }]} pointerEvents="none">
          <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex, textAlign: 'center' }]}>
            {welcomeToast}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background.base.hex },
  scroll: { paddingHorizontal: spacing.screen.paddingX, paddingBottom: spacing.xxxl },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  wordmark: { color: colors.text.primary.hex, fontWeight: '800' },
  weekStartPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: 18,
    backgroundColor: colors.background.raised.hex,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  ringBlock: { alignItems: 'center', marginTop: spacing.sm, marginBottom: spacing.sm },
  ringLoading: { height: 132, justifyContent: 'center' },
  missLine: { marginTop: spacing.sm, gap: spacing.xs, paddingHorizontal: spacing.lg },
  missCard: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background.raised.hex,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  feedHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xxl,
    marginBottom: spacing.sm,
  },
  feedHeader: { color: colors.text.muted.hex, flexShrink: 0 },
  feedHeaderName: { flexShrink: 1, textAlign: 'right' },
  feed: { gap: spacing.md },
  joinCode: { alignItems: 'center', marginTop: spacing.lg, paddingVertical: spacing.sm },
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.background.raised.hex,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
});