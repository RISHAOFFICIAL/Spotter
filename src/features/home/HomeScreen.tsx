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
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
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
  const weekComplete = !!ctx && !ctx.weekEndedUnmet && weekCount >= ctx.weeklyGoal;

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