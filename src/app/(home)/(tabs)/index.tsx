/**
 * (home)/(tabs)/index — Home route. Slice B: real home (ring, camera, feed).
 * Home == Feed in MVP (design README #2) — one screen.
 */
import React from 'react';

import HomeScreen from '@/features/home/HomeScreen';

export default function HomeRoute() {
  return <HomeScreen />;
}