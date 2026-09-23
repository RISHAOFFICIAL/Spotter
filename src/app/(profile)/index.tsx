/**
 * (profile) route — minimal real Profile surface behind the bottom-bar slot
 * (compliance brief #2 §4): account info + the in-app Delete account flow
 * (App Store 5.1.1(v)).
 *
 * Session-gated (R1, first-run audit 2026-09-23): only (auth)/welcome,
 * (accept)/index and (invite)/index may render with no session.
 */
import React from 'react';
import { RequireSession } from '@/features/auth/RequireSession';
import { ProfileScreen } from '@/features/profile/ProfileScreen';
export default function ProfileRoute() {
  return (
    <RequireSession>
      <ProfileScreen />
    </RequireSession>
  );
}
