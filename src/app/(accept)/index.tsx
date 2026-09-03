/**
 * (accept) route — the invitee landing / accept flow (invite-flow.md §3).
 * Reachable from the code entry affordance (and, in later slices, a deep
 * link). Standalone screen; works authentically (sign in/create is inline).
 */
import React from 'react';

import { EnterCodeScreen } from '@/features/invites/EnterCodeScreen';

export default function AcceptRoute() {
  return <EnterCodeScreen />;
}