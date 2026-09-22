/**
 * Root layout — gate everything behind AuthProvider and route by auth state.
 * Light theme only (tokens; black text on light surfaces). Splash: native
 * splash (branded, base bg) covers first paint; while JS boots we render a
 * matching base-color View.
 */
import React from 'react';
import { Stack, type NativeStackNavigationOptions } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AuthProvider, SplashLoading, useAuth } from '@/features/auth/AuthProvider';
import { installGlobalErrorHandlers } from '@/lib/diagnostics';
import { RootErrorBoundary } from '@/components/RootErrorBoundary';
import { colors } from '@/theme/tokens';

// Install the first-party crash breadcrumb BEFORE the first render can throw.
// Idempotent; wraps (does not replace) the default RN error handlers.
installGlobalErrorHandlers();

// Base background for every screen's content area (light theme only). The
// inline object literal loses `backgroundColor` through RN 0.86's strict-api
// prop typing, so it is pinned via the stack's own option type with a
// targeted cast (no `any`, no loosened globals; value unchanged).
const CONTENT_STYLE = { backgroundColor: colors.background.base.hex } as const;

function Gate() {
  const { session, profile, isLoading } = useAuth();

  if (isLoading) return <SplashLoading />;

  const onboarded = !!(session && profile);

  // EVERY DIRECT CHILD OF <Stack> MUST BE A SCREEN DEFINITION.
  //
  // WHY THIS IS AN ARRAY AND NOT A FRAGMENT (build-28 P0 fix — do not "tidy"
  // this back into `<>…</>`): expo-router walks <Stack>'s children in
  // node_modules/expo-router/build/layouts/stack-utils/mapProtectedScreen.js.
  // A child that is not Stack.Screen / Protected / Stack.Header falls into an
  // `else` branch that does `console.warn(\`Unknown child element passed to
  // Stack: ${child.type}\`)`. A React fragment IS a valid element, so it takes
  // that branch — and a fragment's `type` is `Symbol(react.fragment)`, and
  // stringifying a Symbol throws
  // `TypeError: Cannot convert a Symbol value to a string`.
  // That throw happens while the very first screen renders, where RN 0.86
  // treats an uncaught render error as fatal (onUncaughtError ->
  // handleException(err, true) -> reportException -> reportFatal -> RCTFatal ->
  // SIGABRT), i.e. the app aborted ~0.3 s after launch on every device
  // (crashes on builds 16/17/18). Passing a KEYED ARRAY keeps every child a
  // <Stack.Screen>: React.Children.toArray flattens arrays, so the throwing
  // branch is never reached. `scripts/smoke/stack-children-guard.cjs` executes
  // this file and feeds the children it produces to the real
  // mapProtectedScreen, so this can never regress unseen again.
  //
  // Order is routing order — do not reorder.
  const screens = !session
    ? [
        <Stack.Screen key="welcome" name="(auth)/welcome" />,
        // Accept stays reachable without a session (the whole point).
        <Stack.Screen key="accept" name="(accept)/index" />,
        <Stack.Screen key="invite" name="(invite)/index" />,
      ]
    : !onboarded
      ? [
          <Stack.Screen key="onboarding" name="(onboarding)/index" />,
          <Stack.Screen key="accept" name="(accept)/index" />,
          <Stack.Screen key="invite" name="(invite)/index" />,
        ]
      : [
          <Stack.Screen key="home" name="(home)/(tabs)/index" />,
          <Stack.Screen key="profile" name="(profile)/index" />,
          <Stack.Screen key="promises" name="(promises)/index" />,
          <Stack.Screen key="accept" name="(accept)/index" />,
          <Stack.Screen key="invite" name="(invite)/index" />,
        ];

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: CONTENT_STYLE as unknown as NativeStackNavigationOptions['contentStyle'],
        animation: 'fade',
      }}
    >
      {screens}
    </Stack>
  );
}

export default function RootLayout() {
  // The error boundary sits ABOVE the router content on purpose: the render
  // fault above happens below this point, so it is caught here and the app
  // shows a labelled, recoverable screen instead of aborting at launch.
  return (
    <RootErrorBoundary>
      <AuthProvider>
        <StatusBar style="dark" />
        <Gate />
      </AuthProvider>
    </RootErrorBoundary>
  );
}
