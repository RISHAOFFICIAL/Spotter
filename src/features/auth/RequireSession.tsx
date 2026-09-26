/**
 * RequireSession — the screen-level session gate.
 *
 * WHY THIS EXISTS (App Review first-run audit, 2026-09-23, finding R1)
 * -------------------------------------------------------------------
 * `src/app/_layout.tsx` chooses its `<Stack.Screen>` list by session state, but
 * that list only decides ORDER: `StackClient.js` calls
 * `withLayoutContext(NativeStackNavigator)` with two arguments, so
 * `useOnlyUserDefinedScreens` defaults to false and expo-router's
 * `useScreens.js` registers *every* filesystem route, appending the undeclared
 * ones. A route the layout did not declare still renders — so nothing stopped
 * `router.replace('/(onboarding)')` or `router.replace('/(home)/(tabs)')` from
 * a session-less state. Both were reachable from the Welcome screen's own
 * controls, and both dead-end: onboarding's `commitOnboarding` returns
 * `{ok:false, error:'No session found. Please sign in again.'}` and Home has no
 * sign-in affordance at all.
 *
 * The fix is a guard INSIDE the screen, because the layout's conditional child
 * array cannot be turned into a real gate without risking the build-28 launch
 * crash (that file's `<Stack>` children must stay a keyed array of
 * `<Stack.Screen>` — see `scripts/smoke/stack-children-guard.cjs`). With no
 * session this renders `<Redirect>` and the protected screen never mounts:
 * React never invokes its function body, so no effect, store read or camera
 * surface in it can run.
 *
 * Only `(auth)/welcome`, `(accept)/index` and `(invite)/index` may render with
 * no session (an invited person must be able to reach the code-entry screen
 * before they have an account). Every other route is wrapped in this component
 * — `scripts/smoke/auth-gate-guard.cjs` renders each of them session-less and
 * fails if any one of them mounts.
 */
import React from 'react';
import { Redirect } from 'expo-router';

import { useAuth } from '@/features/auth/AuthProvider';

/** Where a session-less user is sent — the only sign-in surface in the app. */
export const SIGNED_OUT_ROUTE = '/(auth)/welcome' as const;

export function RequireSession({ children }: { children: React.ReactNode }): React.ReactNode {
  const { session } = useAuth();
  if (!session) return <Redirect href={SIGNED_OUT_ROUTE} />;
  return children;
}
