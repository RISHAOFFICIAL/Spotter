/**
 * (onboarding)/index — 3-step onboarding container (goal -> week start).
 * Presets: goal 3, week start Mon. State is local until final commit
 * ("Let's go" or "Skip for now" per onboarding.md). Back preserves step state.
 * Home toast (defaults) shows after skip on the home screen.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { GoalStep } from '@/features/onboarding/GoalStep';
import { WeekStartStep } from '@/features/onboarding/WeekStartStep';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  DEFAULT_WEEK_START,
  DEFAULT_WEEKLY_GOAL,
  WEEK_START_DAYS,
  commitOnboarding,
  completionDayLabel,
  type OnboardingSettings,
} from '@/lib/settings';

export default function OnboardingRoute() {
  const router = useRouter();
  const { refresh } = useAuth();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [weeklyGoal, setWeeklyGoal] = useState<number>(DEFAULT_WEEKLY_GOAL);
  const [weekStart, setWeekStart] = useState(DEFAULT_WEEK_START);
  const [committing, setCommitting] = useState(false);

  const completionDay = useMemo(() => completionDayLabel(weeklyGoal, weekStart), [weeklyGoal, weekStart]);

  const finish = async (skipDefaults: boolean) => {
    if (committing) return;
    const settings: OnboardingSettings = skipDefaults
      ? { weeklyGoal: DEFAULT_WEEKLY_GOAL, weekStart: DEFAULT_WEEK_START }
      : { weeklyGoal, weekStart };

    setCommitting(true);
    const res = await commitOnboarding(settings);
    await refresh();
    setCommitting(false);

    if (!res.ok) {
      // stay on this screen; retry keeps state (spec: no dead-end)
      return;
    }
    if (skipDefaults) {
      router.replace('/(home)');
      return;
    }
    router.replace('/(home)');
  };

  return (
    <View style={{ flex: 1 }}>
      {step === 1 && (
        <GoalStep
          value={weeklyGoal}
          onChange={setWeeklyGoal}
          onNext={() => setStep(2)}
          onSkip={() => finish(true)}
          onBack={undefined}
          completionDay={completionDay}
        />
      )}
      {step === 2 && (
        <WeekStartStep
          value={weekStart}
          onChange={setWeekStart}
          onFinish={() => finish(false)}
          onSkip={() => finish(true)}
          onBack={() => setStep(1)}
        />
      )}
    </View>
  );
}