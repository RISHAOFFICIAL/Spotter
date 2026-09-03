/**
 * WeeklyRing — the star of Home (home-screen.md §2). Display-only, never a
 * button. Ring numeral (N/G) with "DAYS THIS WEEK" label, volt progress
 * (success) that animates 400ms per log (motion.ringFillMs), track white @
 * 10%. Turns danger red ONLY after the week ends unmet (design README #8 —
 * nudge, don't shame). Single source: the weekly-context count from
 * fetchWeeklyContext — same value as the camera count badge.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { colors, motion, spacing, weeklyRing } from '@/theme/tokens';
import { textStyles } from '@/theme/typography';

const OUTER_D = weeklyRing.outerDiameter;
// SVG circle geometry for a 132pt ring with a 12pt progress stroke drawn
// centered on the track radius (starts 12 o'clock, clockwise).
const R = (OUTER_D - weeklyRing.progressStroke) / 2;
const C = 2 * Math.PI * R;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function WeeklyRing({ count, goal, weekEndedUnmet }: { count: number; goal: number; weekEndedUnmet: boolean }) {
  const clamped = Math.min(Math.max(count, 0), goal);
  const fraction = goal > 0 ? clamped / goal : 0;
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Animate to the new fraction on every change (new log → 400ms fill).
    Animated.timing(progress, {
      toValue: fraction,
      duration: motion.ringFillMs,
      // cubic-bezier(0.22, 1, 0.36, 1) — token motion.ringFillEasing
      easing: (t: number) => {
        const c1 = 0.22;
        const c2 = 1;
        const c3 = 0.36;
        const c4 = 1;
        const u = 1 - t;
        return (3 * u * u * t * c1 + 3 * u * t * t * c3 + t * t * t * c2) / (3 * u * u * t + 3 * u * t * t + t * t * t);
      },
      useNativeDriver: true,
    }).start();
  }, [fraction, progress]);

  const strokeDashoffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [C, 0],
  });

  const missed = weekEndedUnmet;
  const ringColor = missed ? colors.status.danger.hex : colors.status.success.hex;
  const numeral = `${count}/${goal}`;

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${count} of ${goal} workouts this week`}
      style={styles.wrap}
    >
      <View style={styles.ringBox}>
        <Svg width={OUTER_D} height={OUTER_D} style={styles.ring}>
          <Circle
            cx={OUTER_D / 2}
            cy={OUTER_D / 2}
            r={R}
            stroke={weeklyRing.trackColor}
            strokeOpacity={weeklyRing.trackColorAlpha}
            strokeWidth={weeklyRing.trackStroke}
            fill="none"
          />
          <AnimatedCircle
            cx={OUTER_D / 2}
            cy={OUTER_D / 2}
            r={R}
            stroke={ringColor}
            strokeWidth={weeklyRing.progressStroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${C} ${C}`}
            strokeDashoffset={strokeDashoffset}
            rotation={-90}
            origin={`${OUTER_D / 2}, ${OUTER_D / 2}`}
          />
        </Svg>
        <View style={styles.center}>
          <Text style={[textStyles.ringNumber.style, { color: colors.text.primary.hex }]}>
            {numeral}
          </Text>
          <Text style={[textStyles.label.style, { color: colors.text.secondary.hex, marginTop: spacing.xs }]}>
            DAYS THIS WEEK
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  ringBox: { width: OUTER_D, height: OUTER_D, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: 0, left: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
});