/**
 * (profile) route — minimal real Profile surface behind the bottom-bar slot
 * (compliance brief #2 §4): account info + the in-app Delete account flow
 * (App Store 5.1.1(v)).
 */
import React from 'react';

import { ProfileScreen } from '@/features/profile/ProfileScreen';

export default function ProfileRoute() {
  return <ProfileScreen />;
}