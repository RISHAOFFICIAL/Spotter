/**
 * (auth)/welcome — welcome + inline auth (single path). No create-vs-login
 * fork; authenticated session advances to onboarding-goal; otherwise re-renders.
 */
import React from 'react';
import { useRouter } from 'expo-router';

import { WelcomeStep } from '@/features/onboarding/WelcomeStep';
import { useAuth } from '@/features/auth/AuthProvider';

export default function WelcomeRoute() {
  const router = useRouter();
  const { refresh } = useAuth();

  return (
    <WelcomeStep
      onDone={async () => {
        // authenticate() succeeded inside the step; refresh session then route.
        await refresh();
        router.replace('/(onboarding)');
      }}
    />
  );
}