/**
 * Root layout — gate everything behind AuthProvider and route by auth state.
 * Dark theme only (tokens). Splash: native splash (branded, base bg) covers
 * first paint; while JS boots we render a matching base-color View.
 */
import React from 'react';
import { Stack, type NativeStackNavigationOptions } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AuthProvider, SplashLoading, useAuth } from '@/features/auth/AuthProvider';
import { colors } from '@/theme/tokens';

// Base background for every screen's content area (dark theme only). The
// inline object literal loses `backgroundColor` through RN 0.86's strict-api
// prop typing, so it is pinned via the stack's own option type with a
// targeted cast (no `any`, no loosened globals; value unchanged).
const CONTENT_STYLE = { backgroundColor: colors.background.base.hex } as const;

function Gate() {
  const { session, profile, isLoading } = useAuth();

  if (isLoading) return <SplashLoading />;

  const onboarded = !!(session && profile);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: CONTENT_STYLE as unknown as NativeStackNavigationOptions['contentStyle'],
        animation: 'fade',
      }}
    >
      {!session ? (
        <>
          <Stack.Screen name="(auth)/welcome" />
          {/* Accept stays reachable without a session (the whole point). */}
          <Stack.Screen name="(accept)/index" />
          <Stack.Screen name="(invite)/index" />
        </>
      ) : !onboarded ? (
        <>
          <Stack.Screen name="(onboarding)/index" />
          <Stack.Screen name="(accept)/index" />
          <Stack.Screen name="(invite)/index" />
        </>
      ) : (
        <>
          <Stack.Screen name="(home)/(tabs)/index" />
          <Stack.Screen name="(profile)/index" />
          <Stack.Screen name="(accept)/index" />
          <Stack.Screen name="(invite)/index" />
        </>
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