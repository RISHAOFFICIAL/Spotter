/**
 * (invite) route — deep-link alias for the accept flow. The MVP ships code
 * entry, so a future `spotter.app/invite/{token}` universal link lands here
 * (the Accept screen resolves the token directly). Today the screen is the
 * same EnterCodeScreen; the deep link plumbing is a Phase-2 router change.
 */
import React from 'react';

import { EnterCodeScreen } from '@/features/invites/EnterCodeScreen';

export default function InviteRoute() {
  return <EnterCodeScreen />;
}