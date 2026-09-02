/**
 * (home)/(tabs)/_layout — Home tab shell (MVP: Home == Feed, single screen).
 * Stub for slice B: renders the Home screen only.
 */
import React from 'react';
import { Tabs } from 'expo-router';

import { colors } from '@/theme/tokens';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.background.surface.hex,
          borderTopColor: 'rgba(255,255,255,0.08)',
        },
        tabBarActiveTintColor: colors.brand.primary.hex,
        tabBarInactiveTintColor: colors.text.secondary.hex,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: () => null }} />
    </Tabs>
  );
}