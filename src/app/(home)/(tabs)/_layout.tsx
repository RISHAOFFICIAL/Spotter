/**
 * (home)/(tabs)/_layout — Home tab shell (MVP: Home == Feed, single screen).
 * The app renders its own pinned BottomBar (CameraButton + inert slots) so
 * the native tab bar is hidden; this stays a single Tabs screen for the
 * router shape (design README #2).
 */
import React from 'react';
// `Tabs` re-exports the same component as 'expo-router's Tabs (layouts/Tabs →
// js-tabs); importing here additionally gives us the BottomTabNavigationOptions
// type we need for the hidden-bar style (it is NOT exported from the root).
import { Tabs, type BottomTabNavigationOptions } from 'expo-router/js-tabs';

import { colors } from '@/theme/tokens';

// The app renders its own pinned BottomBar, so the native tab bar is hidden.
// `display: 'none'` is a valid ViewStyle property, but RN 0.86's strict-api
// typing plus react-navigation's Animated wrapper rejects the plain literal.
// The cast is isolated to this one option, with the value itself unchanged
// (no `any`, no loosened globals).
const HIDDEN_TAB_BAR = { display: 'none' } as const;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: HIDDEN_TAB_BAR as unknown as BottomTabNavigationOptions['tabBarStyle'],
      }}
    >
      <Tabs.Screen name="index" />
    </Tabs>
  );
}