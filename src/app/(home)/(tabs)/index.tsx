/**
 * (home)/(tabs)/index — Home route. Slice B: real home (ring, camera, feed).
 * Home == Feed in MVP (design README #2) — one screen.
 *
 * R1 (first-run audit 2026-09-23): with no session Home has NO sign-in
 * affordance — its only above-the-fold content is the error
 * "No session. Sign in to log." under a live camera button that fails the same
 * way. `router.replace('/(home)/(tabs)')` is reachable pre-auth from the
 * Accept screen's "Just look around", so this route is gated: no session →
 * Redirect to (auth)/welcome, and HomeScreen never mounts.
 */
import React from 'react';

import { RequireSession } from '@/features/auth/RequireSession';
import HomeScreen from '@/features/home/HomeScreen';

export default function HomeRoute() {
  return (
    <RequireSession>
      <HomeScreen />
    </RequireSession>
  );
}
