/**
 * Root layout — gate everything behind AuthProvider and route by auth state.
 * Dark theme only (tokens). Splash: native splash (branded, base bg) covers
 * first paint; while JS boots we render a matching base-color View.
 */
import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AuthProvider, SplashLoading, useAuth } from '@/features/auth/AuthProvider';
import { colors } from '@/theme/tokens';

function Gate() {
  const { session, profile, isLoading } = useAuth();

  if (isLoading) return <SplashLoading />;

  const onboarded = !!(session && profile);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background.base.hex },
        animation: 'fade',
      }}
    >
      {!session ? (
        <Stack.Screen name="(auth)/welcome" />
      ) : !onboarded ? (
        <Stack.Screen name="(onboarding)/index" />
      ) : (
        <Stack.Screen name="(home)/(tabs)/index" />
      )}
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Gate />
    </AuthProvider>
  );
}