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

import { isDevMode } from '@/lib/supabase';
import { getStoredSession, clearSession, type AppSession } from '@/lib/supabase';
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
      const p = s.isDevMode ? await devMock.getProfile(s.user.id) : null;
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