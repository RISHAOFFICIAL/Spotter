/**
 * FeedCard — a workout log in the feed (home-screen.md §4). Horizontal card:
 * [photo 64×64 | name + type + timestamp]. Photo tap → full-screen viewer
 * (no pinch/zoom in MVP, ✕ to close). Reaction chips 🔥👏❤️🙄 are
 * MVP-UI-ONLY: they render per spec but are inert (no persistence — that's
 * Phase 2); flagged here so nobody blocks on them.
 */
import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { colors, radius, shadows, spacing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';
import { relativeLogTime, type WorkoutLog } from '@/lib/workouts';

export const REACTIONS_MVP_UI_ONLY = true; // chips render, taps are inert (Phase 2 data)

export function FeedCard({ log, now }: { log: WorkoutLog; now: Date }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const hasPhoto = !!log.photoUri;
  const typeLabel = log.workoutType && log.workoutType.length > 0 ? log.workoutType : 'Workout';

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
            <Text style={[textStyles.captionStrong.style, { color: colors.text.primary.hex }]} numberOfLines={1}>
              {log.authorName}
            </Text>
            {hasPhoto && (
              <Ionicons name="checkmark-circle" size={14} color={colors.status.success.hex} accessibilityLabel="Photo verified" />
            )}
          </View>
          <Text style={[textStyles.caption.style, { color: colors.text.secondary.hex }]} numberOfLines={1}>
            {typeLabel}
          </Text>
          <Text style={[textStyles.label.style, { color: colors.text.muted.hex }]}>
            {relativeLogTime(log.loggedAt, now)}
          </Text>
        </View>
      </View>

      {/* MVP-UI-ONLY reaction chips — inert, no persistence (Phase 2). */}
      {REACTIONS_MVP_UI_ONLY && (
        <View style={styles.reactions}>
          {['🔥', '👏', '❤️', '🙄'].map((r) => (
            <Pressable key={r} accessibilityRole="button" accessibilityLabel={`React ${r}`} style={styles.reactionChip} hitSlop={4}>
              <Text style={styles.reactionText}>{r}</Text>
            </Pressable>
          ))}
        </View>
      )}

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
  reactions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md + spacing.xs },
  reactionChip: {
    height: 28,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  reactionText: { fontSize: 13, lineHeight: 18 },
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