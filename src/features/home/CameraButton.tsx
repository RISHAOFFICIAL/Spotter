/**
 * CameraButton — the heart of Home (home-screen.md §5). 80pt tap target,
 * 72pt volt circle, white outer ring @ 85%, white lens + camera glyph,
 * volt glow. Press scale 0.96 / 90ms (tokens). Count badge top-right
 * (22pt volt circle, count = logs this week — same value as the ring
 * numeral; hidden at 0). One tap → LogSheet (capture is tap A-1, "Log it"
 * is A-2 → obeys the two-tap rule).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { cameraButton, colors, icons } from '@/theme/tokens';

export function CameraButton({
  onPress,
  count,
}: {
  onPress: () => void;
  /** Logs this week — same single source as the ring numeral. */
  count: number;
}) {
  const label = count > 0 ? `Log a workout, ${count} this week` : 'Log a workout';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.target,
        pressed && { transform: [{ scale: cameraButton.pressedScale }], opacity: 0.92 },
      ]}
    >
      <View style={styles.button}>
        <View style={styles.lens}>
          <Ionicons name="camera" size={icons.cameraGlyph} color="#121408" />
        </View>
      </View>
      {count > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{count}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: {
    width: cameraButton.tapTarget,
    height: cameraButton.tapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    width: cameraButton.visualDiameter,
    height: cameraButton.visualDiameter,
    borderRadius: cameraButton.visualDiameter / 2,
    backgroundColor: cameraButton.fill,
    borderWidth: cameraButton.strokeOuter,
    borderColor: `rgba(0,0,0,${cameraButton.strokeOuterAlpha})`,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  lens: {
    width: cameraButton.lensDiameter,
    height: cameraButton.lensDiameter,
    borderRadius: cameraButton.lensDiameter / 2,
    backgroundColor: cameraButton.lensColor,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#121408',
  },
  badge: {
    position: 'absolute',
    top: cameraButton.badge.offsetFromEdge.y,
    right: cameraButton.badge.offsetFromEdge.x,
    minWidth: cameraButton.badge.diameter,
    height: cameraButton.badge.diameter,
    borderRadius: cameraButton.badge.diameter / 2,
    backgroundColor: cameraButton.badge.background,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: cameraButton.badge.text.color,
    fontSize: cameraButton.badge.text.size,
    fontWeight: '700',
    textAlign: 'center',
  },
});