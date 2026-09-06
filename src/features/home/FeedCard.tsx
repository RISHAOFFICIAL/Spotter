/**
 * FeedCard — a workout log in the feed (home-screen.md §4). Horizontal card:
 * [photo 64×64 | name + type + timestamp]. Photo tap → full-screen viewer
 * (no pinch/zoom in MVP, ✕ to close).
 *
 * OWNER CONTROL (compliance brief #2 §5): every card carries a non-destructive
 * "Remove photo" action (overflow ellipsis ••• on the card) that deletes the
 * OWNER's own photo + log after a confirm step; partner/other-user cards are
 * read-only (the action renders only when logged-in user == log.userId).
 *
 * Reaction chips 🔥👏❤️🙄 are REMOVED (compliance brief #2 §4): they were
 * inert MVP-UI-ONLY UI (no persistence). Hidden entirely, nothing replaces the
 * space; real reactions return in Phase 2 with persistence.
 */
import React, { useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { colors, radius, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { relativeLogTime, type WorkoutLog } from '@/lib/workouts';
import { useAuth } from '@/features/auth/AuthProvider';
import { removeWorkout } from '@/lib/workoutStore';

/** Capture time-of-day ("3:14p") for the proof timestamp (home-screen.md §4). */
function captureTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Owner-only "Remove photo" — see compliance brief #2 §5. */
export function FeedCard({ log, now }: { log: WorkoutLog; now: Date }) {
  const { session } = useAuth();
  const [viewerOpen, setViewerOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState(false);
  const hasPhoto = !!log.photoUri;
  const typeLabel = log.workoutType && log.workoutType.length > 0 ? log.workoutType : 'Workout';
  const isOwner = !!session && session.user.id === log.userId;

  const requestRemove = () => {
    if (removing || removed) return;
    // Confirm step — never a single tap (UGC control, brief #2 §5).
    Alert.alert(
      'Remove this photo?',
      "This deletes this workout's photo proof from your feed.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove photo',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setRemoving(true);
              const res = await removeWorkout(log.id);
              setRemoving(false);
              if (res.ok) {
                setRemoved(true);
              } else {
                Alert.alert("Couldn't remove it", res.error ?? 'Try again in a moment.');
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="View photo" onPress={() => setViewerOpen(true)} style={styles.thumbWrap}>
          {hasPhoto ? (
            <Image source={{ uri: log.photoUri }} style={styles.thumb} contentFit="cover" transition={150} />
          ) : (
            <View style={[styles.thumb, styles.thumbFallback]}>
              <Ionicons name="camera-outline" size={20} color={colors.text.muted.hex} />
            </View>
          )}
        </Pressable>
        <View style={styles.right}>
          <View style={styles.rowTop}>
            <Text style={[textStyles.captionStrong.style, styles.author]} numberOfLines={1}>
              {log.authorName}
            </Text>
            {hasPhoto && (
              <>
                <View style={styles.liveBadge}>
                  <Ionicons name="radio" size={9} color={colors.brand.primary.hex} />
                  <Text style={[textStyles.label.style, styles.liveBadgeText]}>Live</Text>
                </View>
              </>
            )}
            {/* Owner-only overflow control (non-destructive; confirm step inside). */}
            {isOwner && !removed && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove photo"
                onPress={requestRemove}
                hitSlop={8}
                style={styles.more}
              >
                {removing ? (
                  <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>…</Text>
                ) : (
                  <Ionicons name="ellipsis-horizontal" size={16} color={colors.text.secondary.hex} />
                )}
              </Pressable>
            )}
          </View>
          {removed ? (
            <Text style={[textStyles.caption.style, { color: colors.text.muted.hex }]}>
              Photo removed
            </Text>
          ) : (
            <>
              <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex }]} numberOfLines={1}>
                {typeLabel}
              </Text>
              <View style={styles.metaRow}>
                <Text style={[textStyles.label.style, { color: colors.text.muted.hex }]}>
                  {relativeLogTime(log.loggedAt, now)}
                </Text>
                <Text style={[textStyles.label.style, { color: colors.text.muted.hex }]}>
                  {captureTime(log.loggedAt)}
                </Text>
              </View>
            </>
          )}
        </View>
      </View>

      <Modal visible={viewerOpen} transparent animationType="fade" onRequestClose={() => setViewerOpen(false)}>
        <View style={styles.viewer}>
          {hasPhoto && <Image source={{ uri: log.photoUri }} style={styles.viewerImg} contentFit="contain" />}
          <Pressable accessibilityRole="button" accessibilityLabel="Close photo" onPress={() => setViewerOpen(false)} style={styles.viewerClose}>
            <Ionicons name="close" size={22} color={colors.text.primary.hex} />
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.background.surface.hex,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  row: { flexDirection: 'row', gap: spacing.md },
  thumbWrap: { width: 64, height: 64, borderRadius: radius.md, overflow: 'hidden' },
  thumb: { width: 64, height: 64 },
  thumbFallback: {
    backgroundColor: colors.background.raised.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  right: { flex: 1, gap: spacing.xs * 2, paddingTop: spacing.xs },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  author: { flex: 1, color: colors.text.primary.hex },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(198,241,53,0.35)',
    backgroundColor: 'rgba(198,241,53,0.10)',
  },
  liveBadgeText: { color: colors.brand.primary.hex },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  more: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
  },
  viewer: {
    flex: 1,
    backgroundColor: 'rgba(10,12,8,0.96)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImg: { width: '100%', height: '100%' },
  viewerClose: {
    position: 'absolute',
    top: 48,
    right: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(19,22,16,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});