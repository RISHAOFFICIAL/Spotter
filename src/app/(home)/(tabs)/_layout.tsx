/**
 * (home)/(tabs)/_layout — Home tab shell (MVP: Home == Feed, single screen).
 * The app renders its own pinned BottomBar (CameraButton + inert slots) so
 * the native tab bar is hidden; this stays a single Tabs screen for the
 * router shape (design README #2).
 */
import React from 'react';
import { Tabs } from 'expo-router';

import { colors } from '@/theme/tokens';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: 'none' },
      }}
    >
      <Tabs.Screen name="index" />
    </Tabs>
  );
}