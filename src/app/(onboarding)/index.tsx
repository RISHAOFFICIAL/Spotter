/**
 * (onboarding)/index — 4-step onboarding container after the practice-camera
 * addendum (2026-09-11): Practice cam (1) -> Goal (2) -> Week start (3) —
 * Welcome is step 1 of the SHELL but lives in (auth)/welcome pre-auth.
 * Presets: goal 3, week start Mon. State is local until final commit
 * ("Let's go" or "Skip for now" per onboarding.md). Back preserves step state.
 * PracticeCamStep has no back route (shell hides the chevron); Goal and
 * WeekStart keep their chevrons back to the previous step.
 * Home toast (defaults) shows after skip on the home screen.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { GoalStep } from '@/features/onboarding/GoalStep';
import { PracticeCamStep } from '@/features/onboarding/PracticeCamStep';
import { WeekStartStep } from '@/features/onboarding/WeekStartStep';
import { RequireSession } from '@/features/auth/RequireSession';
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
  const [error, setError] = useState<string | null>(null);
  const completionDay = useMemo(() => completionDayLabel(weeklyGoal, weekStart), [weeklyGoal, weekStart]);
  const finish = async (skipDefaults: boolean) => {
    if (committing) return;
    const settings: OnboardingSettings = skipDefaults
      ? { weeklyGoal: DEFAULT_WEEKLY_GOAL, weekStart: DEFAULT_WEEK_START }
      : { weeklyGoal, weekStart };
    setError(null);
    setCommitting(true);
    const res = await commitOnboarding(settings);
    await refresh();
    setCommitting(false);
    if (!res.ok) {
      // R2: a failed write must SAY SO. Swallowing res.error left "Let's go"
      // looking dead (the same visible symptom the FK blocker produced).
      setError(res.error ?? 'Something went wrong. Try again.');
      return;
    }
    // Typed route literal (router.d.ts collapses (home)/(tabs)/index to
    // '/(home)/(tabs)'); '/(home)' alone is not accepted by the href union.
    router.replace('/(home)/(tabs)');
  };
  // R1: with no session this route must not render at all — its commit would
  // fail with 'No session found. Please sign in again.' and the reviewer would
  // be stuck on a dead "Let's go". RequireSession renders <Redirect> instead, so
  // no step below ever mounts.
  return (
    <RequireSession>
      <View style={{ flex: 1 }}>
        {step === 1 && (
          <PracticeCamStep
            onNext={() => setStep(2)}
            onSkip={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <GoalStep
            value={weeklyGoal}
            onChange={setWeeklyGoal}
            onNext={() => setStep(3)}
            onSkip={() => finish(true)}
            onBack={() => setStep(1)}
            completionDay={completionDay}
            error={error}
          />
        )}
        {step === 3 && (
          <WeekStartStep
            value={weekStart}
            onChange={setWeekStart}
            onFinish={() => finish(false)}
            onSkip={() => finish(true)}
            onBack={() => setStep(2)}
            error={error}
            loading={committing}
          />
        )}
      </View>
    </RequireSession>
  );
}