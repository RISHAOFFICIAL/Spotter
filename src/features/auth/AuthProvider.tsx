/**
 * AuthProvider — session gate for the whole app.
 *
 * On launch we load any stored session (real SecureStore-backed session or the
 * dev mock session), then route: no session -> (auth)/welcome; session but no
 * onboarded settings -> (onboarding)/goal; complete -> (home)/(tabs)/index.
 *
 * While loading we render the branded dark splash look (base background) — the
 * real native splash covers the first paint; this keeps the transition smooth.
 */
'use client';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { isDevMode, supabase, getStoredSession, clearSession, type AppSession } from '@/lib/supabase';
import { devMock, type Profile } from '@/lib/mock';
import { consumeIsFirstOpen, track } from '@/lib/analytics';
import { colors } from '@/theme/tokens';

interface AuthContextValue {
  session: AppSession | null;
  profile: Profile | null;
  isLoading: boolean;
  isDevMode: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * REAL-mode profile load: `public.users` row (created by commitOnboarding) is
 * the ONBOARDING marker — no row → profile null → onboarding runs. Email is not
 * stored on public.users (schema has no column); it comes from the auth
 * session. weekly_goal lives on memberships, NOT users — resolved by the
 * same most-recent-membership pattern workoutStore.fetchWeeklyContext uses
 * (onboarding writes the personal group first; pair membership comes later, so
 * the latest membership is the user's current goal). All reads are
 * RLS-scoped to auth.uid() (users_select_own / memberships_select_own).
 * Shape mirrors devMock.getProfile: id, email, name, week_start_day, timezone,
 * weekly_goal, onboarded_at (= users.created_at; dev-only consumer).
 */
async function loadRealProfile(s: AppSession): Promise<Profile | null> {
  if (!supabase) return null;
  const userId = s.user.id;
  const { data: userRow } = await supabase
    .from('users')
    .select('id, name, week_start_day, timezone, created_at')
    .eq('id', userId)
    .maybeSingle();
  if (!userRow) return null;

  let weeklyGoal = 3; // onboarding default — matches fetchWeeklyContext
  const { data: membership } = await supabase
    .from('memberships')
    .select('weekly_goal')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (membership?.weekly_goal && membership.weekly_goal >= 1 && membership.weekly_goal <= 7) {
    weeklyGoal = membership.weekly_goal;
  }

  return {
    id: userRow.id,
    email: s.user.email,
    name: userRow.name,
    week_start_day: userRow.week_start_day,
    timezone: userRow.timezone,
    weekly_goal: weeklyGoal,
    onboarded_at: userRow.created_at,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // V1.1: app_opened fires once per mount (is_first_open exactly once per
  // install via the storage flag). Fire-and-forget — never blocks the gate.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const isFirst = await consumeIsFirstOpen();
      if (mounted) void track('app_opened', { props: { is_first_open: isFirst } });
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const refresh = async () => {
    const s = await getStoredSession();
    setSession(s);
    if (s) {
      const p = s.isDevMode ? await devMock.getProfile(s.user.id) : await loadRealProfile(s);
      setProfile(p);
    } else {
      setProfile(null);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      await refresh();
      if (mounted) setIsLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      profile,
      isLoading,
      isDevMode,
      refresh,
      signOut: async () => {
        await clearSession();
        await refresh();
      },
    }),
    [session, profile, isLoading, isDevMode],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Branded dark backdrop used while auth state is loading. */
export function SplashLoading() {
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.background.base.hex,
        zIndex: 999,
      }}
    />
  );
}