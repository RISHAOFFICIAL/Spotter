/**
 * Root error boundary — the last line of defence against "the app will not open".
 *
 * WHY (build 28): RN 0.86 routes an uncaught render error to
 * `onUncaughtError` -> `ExceptionsManager.handleException(err, true)` ->
 * `reportException` -> `reportFatal` -> SIGABRT. Without a boundary, ANY render
 * fault anywhere in the tree makes the app unopenable — the worst possible
 * first impression, and invisible to us (we only get an Apple crash log with no
 * JS message). With a boundary the same fault becomes a labelled, readable,
 * retryable screen: the user can recover, and the error text on screen is
 * evidence we can read from a screenshot.
 *
 * The error is NOT swallowed: it is reported through the first-party
 * diagnostics path (`reportCrash` -> insert-only `app_diagnostics` table),
 * exactly like the global handlers installed in src/app/_layout.tsx.
 *
 * Light theme only, black text (tokens; the owner never wants faint text).
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { reportCrash } from '@/lib/diagnostics';
import { colors } from '@/theme/tokens';

interface Props {
  children: React.ReactNode;
}

interface State {
  /** Error message text, or null when nothing is broken. */
  message: string | null;
  /** Bumped by Retry so the children are re-mounted, not just re-rendered. */
  attempt: number;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class RootErrorBoundary extends React.Component<Props, State> {
  state: State = { message: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // Must be pure: only state. Reporting happens in componentDidCatch.
    return { message: messageOf(error) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const stack = [error instanceof Error ? error.stack : null, info?.componentStack]
      .filter(Boolean)
      .join('\n--- componentStack ---\n');
    // First-party diagnostics: message + stack land in `app_diagnostics`.
    reportCrash(`[render-boundary] ${messageOf(error)}`, stack || null);
  }

  private retry = (): void => {
    this.setState((prev) => ({ message: null, attempt: prev.attempt + 1 }));
  };

  render(): React.ReactNode {
    if (this.state.message === null) {
      // Keyed fragment: a Retry after a fault re-mounts the subtree cleanly
      // instead of re-rendering a child that is stuck in a broken state.
      return (
        <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>
      );
    }

    return (
      <View style={styles.root} testID="root-error-boundary">
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            Spotter hit an unexpected problem while opening. Your workouts and photos are safe.
          </Text>
          <Text style={styles.label}>Error</Text>
          <Text style={styles.error} selectable testID="root-error-boundary-message">
            {this.state.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={this.retry}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            testID="root-error-boundary-retry"
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background.base.hex,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 48,
  },
  title: {
    color: colors.text.primary.hex,
    fontSize: 24,
    fontWeight: '700',
  },
  body: {
    color: colors.text.secondary.hex,
    fontSize: 16,
    lineHeight: 22,
    marginTop: 12,
  },
  label: {
    color: colors.text.secondary.hex,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginTop: 28,
    textTransform: 'uppercase',
  },
  error: {
    color: colors.text.primary.hex,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary.hex,
    borderRadius: 999,
    marginTop: 32,
    paddingVertical: 16,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: colors.brand.onPrimary.hex,
    fontSize: 17,
    fontWeight: '700',
  },
});
