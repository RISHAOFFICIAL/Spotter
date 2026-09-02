/**
 * Supabase client factory with a dev-mode fallback.
 *
 * MODES
 * -----
 * 1. REAL — activate automatically when both `EXPO_PUBLIC_SUPABASE_URL` and
 *    `EXPO_PUBLIC_SUPABASE_ANON_KEY` are set (add to a local `.env`; see README).
 *    Sessions persist via expo-secure-store (SecureStore on device, KV on web).
 * 2. DEV MOCK — env vars absent: the app runs end-to-end against a clearly
 *    labeled in-memory/local mock (no network). This keeps onboarding fully
 *    walkable without a Supabase project. Everything here is visibly fake:
 *    the mock labels itself "DEV DEMO — local mock" on the welcome screen.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { Database } from './database.types';
import { devMock, type MockSession } from './mock';

export const EXPO_PUBLIC_SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
export const EXPO_PUBLIC_SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const isDevMode = !EXPO_PUBLIC_SUPABASE_URL || !EXPO_PUBLIC_SUPABASE_ANON_KEY;

const STORAGE_KEY = 'spotter.session';

const secureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

function webStorageAdapter() {
  const store = {
    getItem: (key: string) => {
      try {
        return Promise.resolve(window.localStorage.getItem(key));
      } catch {
        return Promise.resolve(null);
      }
    },
    setItem: (key: string, value: string) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {}
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      try {
        window.localStorage.removeItem(key);
      } catch {}
      return Promise.resolve();
    },
  };
  return store;
}

export const supabase: SupabaseClient<Database> | null = isDevMode
  ? null
  : createClient<Database>(EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, {
      auth: {
        storage: Platform.OS === 'web' ? webStorageAdapter() : secureStoreAdapter,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });

// ---------------------------------------------------------------------------
// Dev-mode auth facade (labeled mock; no network)
// ---------------------------------------------------------------------------

export interface AuthResult {
  ok: boolean;
  error?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface AppSession {
  user: SessionUser;
  isDevMode: boolean;
}

export async function getStoredSession(): Promise<AppSession | null> {
  if (!isDevMode && supabase) {
    const { data } = await supabase.auth.getSession();
    const s = data.session;
    if (!s?.user) return null;
    return {
      user: { id: s.user.id, email: s.user.email ?? '', createdAt: s.user.created_at },
      isDevMode: false,
    };
  }
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AppSession;
  } catch {}
  return null;
}

export async function startDevSession(email: string): Promise<MockSession> {
  const session: MockSession = {
    user: devMock.createUser(email),
    isDevMode: true,
  };
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export async function clearSession(): Promise<void> {
  if (!isDevMode && supabase) {
    await supabase.auth.signOut();
  }
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch {}
}

// ---------------------------------------------------------------------------
// Unified auth entry: single path (no signup-vs-login fork). One tap on
// "Get started" opens the inline email+password form; submitting here either
// signs the user in (real mode) or creates a clearly-labeled demo session.
// ---------------------------------------------------------------------------

export async function authenticate(email: string, password: string): Promise<AuthResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) {
    return { ok: false, error: 'Enter your email and password.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, error: "That email doesn't look right — try again." };
  }
  if (password.length < 6) {
    return { ok: false, error: 'Password must be at least 6 characters.' };
  }

  if (!isDevMode && supabase) {
    try {
      // Single path: try sign-in first; fall back to sign-up if the account
      // doesn't exist yet (matches the no-fork onboarding spec).
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: normalized,
        password,
      });
      if (!signInError) return { ok: true };
      const { error: signUpError } = await supabase.auth.signUp({
        email: normalized,
        password,
      });
      if (signUpError) {
        return { ok: false, error: signUpError.message };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "Can't reach server. Try again." };
    }
  }

  // Dev mock — clearly labeled, no network
  try {
    await startDevSession(normalized);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "Can't reach server. Try again." };
  }
}

export type { MockSession };
export { devMock };