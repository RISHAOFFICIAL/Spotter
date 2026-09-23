/**
 * (promises) route — the Treats/Promises ledger screen behind the Profile row
 * (NOT a tab; feed tab == home tab in MVP). Pair-private by RLS.
 *
 * Session-gated (R1, first-run audit 2026-09-23): only (auth)/welcome,
 * (accept)/index and (invite)/index may render with no session.
 */
import React from 'react';
import { RequireSession } from '@/features/auth/RequireSession';
import { PromisesScreen } from '@/features/promises/PromisesScreen';
export default function PromisesRoute() {
  return (
    <RequireSession>
      <PromisesScreen />
    </RequireSession>
  );
}
